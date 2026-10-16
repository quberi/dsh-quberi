/**
 * Search, save and upload to your Quberi knowledge base from DeepSeek Harness.
 *
 * `/quberi login` signs you in through the browser (OAuth + PKCE); after that
 * the model can call `quberi_search` (read), `quberi_save` (write) and
 * `quberi_upload_file` (upload, one workspace file at a time, each approved by
 * you first). The sign-in acts as you: search finds only passages in spaces you
 * can read, and save and upload only write into spaces you can edit, in the one
 * organization you chose.
 * You can disconnect it from Quberi (Account) or with `/quberi logout`.
 *
 * @module dsh-quberi
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
// Side-effect type import: declaration-merges `ctx.commands` onto Context.
import type {} from '@deepseek-ai/dsh-commands'

import { focusHostApp, openInBrowser } from './browser.js'
import {
  QuberiController,
  QuberiUserError,
  formatSaveResult,
  formatSearchResult,
  formatUploadResult,
} from './controller.js'
import type { TokenStore } from './controller.js'
import { readTokenSet } from './oauth.js'
import type { TokenSet } from './oauth.js'
import { UploadGate, UploadRefusal, readApproved } from './upload.js'

/** Cordis plugin name. Also the owner scope of the stored sign-in record. */
export const name = 'quberi'
/**
 * Services this plugin needs. Cordis loads a plugin only while every one is
 * present, so the workspace services behind file upload are not listed here:
 * they are looked up at call time, and without them the upload tool refuses.
 */
export const inject = ['commands', 'credentials', 'tools']

/** The name of the file-upload tool, which the approval gate recognises. */
const UPLOAD_TOOL = 'quberi_upload_file'

export interface Config {
  /** Quberi API origin. */
  baseUrl: string
  /** The sign-in client Quberi knows this plugin as. */
  clientId: string
  /** Loopback port for the browser callback; 0 asks the OS for a free one. */
  callbackPort: number
  /** How long an unfinished browser sign-in stays valid. */
  loginTimeoutMs: number
  /** Per-request timeout for Quberi calls. */
  requestTimeoutMs: number
  /** Refresh the access token this long before it expires. */
  refreshSkewMs: number
  /** Open the sign-in page in your browser instead of only printing the link. */
  openBrowser: boolean
  /** Sign in the first time the search tool is used, without a separate /quberi login. */
  autoLogin: boolean
  /** Bring Harness back to the front when sign-in finishes (macOS). */
  focusApp: boolean
  /**
   * Offer the file-upload tool (each file is shown to you and needs your approval).
   * Off: the tool is not registered and sign-in does not ask for the upload permission.
   */
  uploadFiles: boolean
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('https://api.quberi.com'),
  clientId: z.string().pattern(/^[A-Za-z0-9._~-]+$/u).default('quberi-harness'),
  callbackPort: z.number().step(1).min(0).max(65_535).default(0),
  loginTimeoutMs: z.number().min(1).max(3_600_000).default(5 * 60_000),
  requestTimeoutMs: z.number().min(1).max(300_000).default(30_000),
  refreshSkewMs: z.number().min(0).max(3_600_000).default(60_000),
  openBrowser: z.boolean().default(true),
  autoLogin: z.boolean().default(true),
  focusApp: z.boolean().default(true),
  uploadFiles: z.boolean().default(true),
})

/** The folder the calling agent's session works in, or undefined if it cannot be told. */
function workspaceRootOf(ctx: Context, call: { agent?: unknown }): string | undefined {
  // Looked up by name at call time (as the tools service does for approval), not injected.
  const lookup = (ctx as unknown as { get(name: string): unknown }).get.bind(ctx)
  const agent = call.agent as { session?: unknown; id?: unknown } | undefined
  if (agent === undefined) return undefined
  try {
    // An agent carries its session; the store is the fallback (an agent's id is its session id).
    const sessions = lookup('sessions') as { get(id: unknown): unknown } | undefined
    const session = agent.session ?? (agent.id === undefined ? undefined : sessions?.get(agent.id))
    const policy = lookup('sandboxPolicy') as { resolve(request: { session: unknown }): { workspaceRoot: string } } | undefined
    if (session === undefined || policy === undefined) return undefined
    const root = policy.resolve({ session }).workspaceRoot
    return typeof root === 'string' && root !== '' ? root : undefined
  } catch {
    return undefined
  }
}

/** Keep the token set as one credential record, written under the host's lock. */
function recordStore(ctx: Context): TokenStore {
  const key = credentialKey(name, 'oauth')
  const asTokens = (record: Awaited<ReturnType<typeof ctx.credentials.readRecord>>): TokenSet | undefined =>
    record?.kind === 'grant' ? readTokenSet(record.payload) : undefined
  return {
    read: async () => asTokens(await ctx.credentials.readRecord(key)),
    modify: async (mutate) => {
      await ctx.credentials.modifyRecord(key, async (current) => {
        const next = await mutate(asTokens(current))
        return next === undefined ? undefined : { kind: 'grant', payload: next }
      })
    },
    clear: () => ctx.credentials.deleteRecord(key),
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const controller = new QuberiController({
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    scope: config.uploadFiles ? 'knowledge:read knowledge:write knowledge:upload' : 'knowledge:read knowledge:write',
    callbackPort: config.callbackPort,
    loginTimeoutMs: config.loginTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    refreshSkewMs: config.refreshSkewMs,
    store: recordStore(ctx),
    openBrowser: config.openBrowser ? (url) => openInBrowser(url) : undefined,
    focusApp: config.focusApp ? () => focusHostApp() : undefined,
    autoLogin: config.autoLogin,
    warn: (message) => ctx.logger.warn(message),
  })
  ctx.effect(() => () => controller.dispose(), 'quberi.lifecycle')

  ctx.commands.register({
    name: 'quberi',
    description: 'sign in to Quberi (search, save and upload knowledge) or check the connection',
    input: { hint: '[login|status|logout]' },
    handler: (invocation) => controller.command(invocation.rawInput),
  })

  ctx.tools.register(
    defineTool({
      name: 'quberi_search',
      description:
        "Search the user's Quberi knowledge base: the company or team documents they are allowed to read " +
        '(handbooks, policies, notes). Returns matching passages with the document name and space. ' +
        'Read-only. The first time, it opens a browser window for the user to sign in to Quberi; ' +
        'if it says the user must open a link, pass that link on.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'What to look for, phrased as a question or key phrase.',
        },
        top_k: {
          type: 'number',
          description: 'How many passages to return, 1 to 10 (default 5).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        try {
          const result = await controller.search(args.query, args.top_k ?? 5, exec.signal)
          return formatSearchResult(args.query, result)
        } catch (error) {
          if (error instanceof QuberiUserError) throw error
          if (exec.signal.aborted) throw error
          // Network and parsing details stay out of the model's context.
          throw new Error('Quberi could not be reached or answered unexpectedly. Try again shortly.')
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'quberi_save',
      description:
        "Save a note into the user's Quberi knowledge base so it can be found later with quberi_search. " +
        'Use it to keep a conclusion, decision, plan, snippet, or summary that came out of this conversation. ' +
        'By default it goes into the user\'s personal space; pass `space` to save into a named team space they can edit. ' +
        'The first time, it opens a browser window for the user to sign in to Quberi (granting read and save); ' +
        'if it says the user must open a link, pass that link on. ' +
        'Be proactive but not pushy: when the conversation produces something worth keeping, briefly offer to save it ' +
        'and let the user confirm before calling this tool — do not save silently or repeatedly.',
      parameters: {
        title: {
          type: 'string',
          required: true,
          description: 'A short, descriptive title for the note (becomes the document name).',
        },
        text: {
          type: 'string',
          required: true,
          description:
            'The note body, as Markdown. Include the content worth keeping; it may contain headings, ' +
            'lists, code blocks, and image links. Images are stored but not yet searchable by content.',
        },
        space: {
          type: 'string',
          description:
            'Name of the team space to save into, as the user refers to it. ' +
            'Omit to use the user\'s personal space.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        try {
          const result = await controller.saveNote(
            { title: args.title, text: args.text, space: args.space },
            exec.signal,
          )
          return formatSaveResult(result)
        } catch (error) {
          if (error instanceof QuberiUserError) throw error
          if (exec.signal.aborted) throw error
          throw new Error('Quberi could not be reached or answered unexpectedly. Try again shortly.')
        }
      },
    }),
  )

  if (!config.uploadFiles) return

  // Every upload is shown to the person first. The gate records what it showed;
  // the tool sends only that file, and only if the question was actually asked.
  const gate = new UploadGate({
    workspaceRoot: (call) => workspaceRootOf(ctx, call),
    blocker: () => controller.uploadBlocker(),
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== UPLOAD_TOOL) return next()
    const prior = await next()
    // Another policy saying no (or cancel) stands; ours only adds the question.
    if (prior.kind === 'deny' || prior.kind === 'cancel') return prior
    return gate.decide({ callId: exec.callId, arguments: exec.arguments, agent: exec.agent })
  })

  ctx.tools.register(
    defineTool({
      name: UPLOAD_TOOL,
      description:
        "Upload one file from the current workspace into the user's Quberi knowledge base, so it can be found " +
        'later with quberi_search (PDF, Word, Excel, PowerPoint, Markdown, CSV, text and JSON are indexed for search; ' +
        'images are stored but not yet searchable by content). ' +
        'Only use it when the user asked you to upload or keep that specific file. ' +
        'The user is shown the exact file, its size and the destination space and must approve every upload, ' +
        'so say which file you are about to upload. ' +
        'Only files inside the workspace work; archives, HTML, SVG, executables and files that look like secrets are refused. ' +
        'By default it goes into the user\'s personal space; pass `space` to use a named team space they can edit.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path of the file, relative to the workspace folder (or absolute but inside it).',
        },
        space: {
          type: 'string',
          description: "Name of the team space to upload into, as the user refers to it. Omit to use the user's personal space.",
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        try {
          // Refuses unless the approval question for this very call was asked.
          const plan = gate.take(exec.callId)
          const data = await readApproved(plan)
          const result = await controller.uploadFile({ data, filename: plan.filename, space: plan.space }, exec.signal)
          return formatUploadResult(result)
        } catch (error) {
          if (error instanceof QuberiUserError) throw error
          if (error instanceof UploadRefusal) throw new QuberiUserError(error.message)
          if (exec.signal.aborted) throw error
          throw new Error('Quberi could not be reached or answered unexpectedly. Try again shortly.')
        }
      },
    }),
  )
}
