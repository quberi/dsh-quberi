/**
 * Search your Quberi knowledge base from DeepSeek Harness.
 *
 * `/quberi login` signs you in through the browser (OAuth + PKCE); after that
 * the model can call `quberi_search`. The sign-in is read-only and acts as you:
 * it can only find passages in spaces you can already read, in the one
 * organization you chose. You can disconnect it from Quberi (Account) or with
 * `/quberi logout`.
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
import { QuberiController, QuberiUserError, formatSearchResult } from './controller.js'
import type { TokenStore } from './controller.js'
import { readTokenSet } from './oauth.js'
import type { TokenSet } from './oauth.js'

/** Cordis plugin name. Also the owner scope of the stored sign-in record. */
export const name = 'quberi'
/** Services this plugin needs. */
export const inject = ['commands', 'credentials', 'tools']

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
})

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
    scope: 'knowledge:read',
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
    description: 'sign in to Quberi (read-only knowledge search) or check the connection',
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
}
