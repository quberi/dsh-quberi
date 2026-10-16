/**
 * Which local files `quberi_upload_file` may send, and the approval gate around it.
 *
 * Uploading is the one tool that moves a local file off the machine, and a model
 * chooses its path. A model can be steered by whatever text it read last, so a
 * poisoned page could ask for `~/.ssh/id_rsa` to be "saved to the knowledge base",
 * where a whole team can then search it. Three independent checks stand in the way:
 *
 * 1. **Workspace only.** The path is resolved (symlinks included) and must stay
 *    inside the session's workspace. Credential-shaped names and folders are refused.
 * 2. **A person approves every file.** Before anything is read for sending, the
 *    host asks the person, showing the exact file, size and destination. A grant
 *    covers that one file once.
 * 3. **The approved file is the file sent.** The approval records the file's size
 *    and SHA-256; the bytes are read again at send time and must match, so a file
 *    swapped after approval is refused.
 *
 * The server then checks the content again and has the final say on the type.
 *
 * This file does not import DeepSeek Harness, so it can be tested on its own.
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Matches the server's own cap (25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_PATH_CHARS = 4096
const MAX_SPACE_CHARS = 200
/** How long an approval prompt may stay open before its record is forgotten. */
const PLAN_TTL_MS = 60 * 60_000
const MAX_PENDING_PLANS = 64

/**
 * Types the server accepts from outside tools. The server decides from the file's
 * bytes; this list only saves a prompt for something it would refuse anyway.
 * Archives, HTML, SVG, executables and legacy Office files are deliberately absent.
 */
export const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.md',
  '.markdown',
  '.csv',
  '.txt',
  '.log',
  '.json',
])

/** Folders that hold credentials or tool state, wherever they sit in the workspace. */
const SENSITIVE_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.gcloud',
  '.config',
  '.npm',
  '.dsh',
])

/** File names that look like secrets: `secrets.json`, `my-credentials.txt`, `id_rsa_backup.md`. */
const SENSITIVE_NAME =
  /(^|[._\s-])(secret|secrets|credential|credentials|password|passwords|passwd|token|tokens|apikey|api-key|private[._-]?key|id_rsa|id_ed25519|id_ecdsa|keystore|wallet)([._\s-]|$)/iu

/** Control characters and bidi overrides would let a path look like a different one in a prompt. */
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

/** A problem the person can act on; the message is safe to show them and the model. */
export class UploadRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadRefusal'
  }
}

/** What was looked at when the file was proposed; the send must match it exactly. */
export interface UploadPlan {
  /** Canonical absolute path (symlinks resolved). */
  readonly realPath: string
  /** Canonical workspace root the path was checked against. */
  readonly root: string
  /** Path relative to the workspace, for display. */
  readonly displayPath: string
  /** File name sent to Quberi. */
  readonly filename: string
  readonly size: number
  readonly sha256: string
  readonly dev: number
  readonly ino: number
  /** Target space as the person would name it; undefined means their personal space. */
  readonly space: string | undefined
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function cleanSpace(space: unknown): string | undefined {
  if (space === undefined || space === null) return undefined
  if (typeof space !== 'string') throw new UploadRefusal('The space must be a name.')
  const trimmed = space.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > MAX_SPACE_CHARS) throw new UploadRefusal(`The space name is longer than ${MAX_SPACE_CHARS} characters.`)
  if (UNSAFE_PATH_CHARS.test(trimmed)) throw new UploadRefusal('The space name has characters that cannot be shown safely.')
  return trimmed
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Number((bytes / (1024 * 1024)).toFixed(2))} MB`
}

/** Read the file through one handle, refusing links, and report its size, hash and identity. */
async function fingerprint(realPath: string): Promise<{ data: Buffer; size: number; sha256: string; dev: number; ino: number }> {
  // O_NOFOLLOW: if the last component was swapped for a link since we resolved it, fail instead of following.
  const handle = await open(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new UploadRefusal('That path is not a regular file.')
    if (info.size > MAX_UPLOAD_BYTES) throw new UploadRefusal(tooLarge(info.size))
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== data.length) throw new UploadRefusal('The file changed while it was being read. Try again.')
    return {
      data,
      size: info.size,
      sha256: createHash('sha256').update(data).digest('hex'),
      dev: info.dev,
      ino: info.ino,
    }
  } finally {
    await handle.close()
  }
}

function tooLarge(size: number): string {
  // A file a byte over the limit would otherwise read "25 MB; the limit is 25 MB".
  const shown = formatBytes(size) === formatBytes(MAX_UPLOAD_BYTES) ? `${size.toLocaleString('en-US')} bytes` : formatBytes(size)
  return `That file is ${shown}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`
}

/**
 * Check a proposed file against the workspace rules and record what it is.
 * Throws {@link UploadRefusal} with a message that says what to change.
 */
export async function planUpload(rawPath: unknown, rawSpace: unknown, workspaceRoot: string): Promise<UploadPlan> {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new UploadRefusal('Give the path of a file in the workspace.')
  if (rawPath.length > MAX_PATH_CHARS) throw new UploadRefusal('That path is too long.')
  if (UNSAFE_PATH_CHARS.test(rawPath)) throw new UploadRefusal('That path has characters that cannot be shown safely.')
  const space = cleanSpace(rawSpace)

  let root: string
  try {
    root = await realpath(workspaceRoot)
  } catch {
    throw new UploadRefusal('The workspace folder is not available, so no file can be uploaded.')
  }

  let real: string
  try {
    real = await realpath(resolve(root, rawPath.trim()))
  } catch {
    throw new UploadRefusal('No such file in the workspace.')
  }
  if (!within(root, real)) {
    throw new UploadRefusal('Only files inside the workspace can be uploaded. That path points outside it.')
  }
  if (UNSAFE_PATH_CHARS.test(real)) throw new UploadRefusal('That path has characters that cannot be shown safely.')

  const displayPath = relative(root, real)
  const segments = displayPath.split(sep)
  const name = basename(real)
  const folders = segments.slice(0, -1).map((segment) => segment.toLowerCase())
  if (folders.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    throw new UploadRefusal('Files inside credential or tool-settings folders (such as .git, .ssh, .aws) are never uploaded.')
  }
  if (name.startsWith('.env') || SENSITIVE_NAME.test(name)) {
    throw new UploadRefusal('That file name looks like it holds secrets, so it is not uploaded.')
  }
  const extension = extname(name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new UploadRefusal(
      'That file type is not accepted from outside tools. Allowed: png, jpg, gif, webp, pdf, docx, xlsx, pptx, md, csv, txt, json.',
    )
  }

  const info = await stat(real)
  if (!info.isFile()) throw new UploadRefusal('That path is not a regular file.')
  if (info.size === 0) throw new UploadRefusal('That file is empty.')
  if (info.size > MAX_UPLOAD_BYTES) throw new UploadRefusal(tooLarge(info.size))

  const seen = await fingerprint(real)
  return {
    realPath: real,
    root,
    displayPath,
    filename: name,
    size: seen.size,
    sha256: seen.sha256,
    dev: seen.dev,
    ino: seen.ino,
    space,
  }
}

/**
 * Read the approved file again for sending, and refuse if it is no longer the
 * file that was approved (moved, replaced by a link, edited, or swapped).
 */
export async function readApproved(plan: UploadPlan): Promise<Buffer> {
  let real: string
  try {
    real = await realpath(plan.realPath)
  } catch {
    throw new UploadRefusal('The approved file is gone. Nothing was uploaded.')
  }
  if (real !== plan.realPath || !within(plan.root, real)) {
    throw new UploadRefusal('The approved file was moved or replaced. Nothing was uploaded.')
  }
  let seen: Awaited<ReturnType<typeof fingerprint>>
  try {
    seen = await fingerprint(real)
  } catch (error) {
    if (error instanceof UploadRefusal) throw error
    throw new UploadRefusal('The approved file could not be read again. Nothing was uploaded.')
  }
  if (seen.size !== plan.size || seen.sha256 !== plan.sha256 || seen.dev !== plan.dev || seen.ino !== plan.ino) {
    throw new UploadRefusal('The file changed after you approved it. Nothing was uploaded; ask again to review the new version.')
  }
  return seen.data
}

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

/** The approval request shape the host understands (`tools/pre-execute`). */
export type GateDecision =
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason: string; displayReason: { en: string; zh: string } }

interface Remembered {
  readonly plan: UploadPlan
  readonly at: number
}

export interface GateOptions {
  /** The workspace folder for a call, or undefined when it cannot be told. */
  workspaceRoot(call: { agent?: unknown }): string | undefined
  /** A reason the upload cannot work at all (checked before the person is asked), or undefined. */
  blocker?(): Promise<string | undefined>
  now?: () => number
}

/**
 * Pairs the question with the send. `decide` runs before the host asks the person
 * and remembers what it showed; `take` runs inside the tool and hands the
 * remembered file over exactly once. If the question was never asked (another
 * listener answered first, or the tool was reached some other way), nothing is
 * remembered and the tool refuses: the approval cannot be skipped by ordering.
 */
export class UploadGate {
  private readonly remembered = new Map<string, Remembered>()
  private readonly now: () => number

  constructor(private readonly options: GateOptions) {
    this.now = options.now ?? Date.now
  }

  async decide(call: { callId: string; arguments: unknown; agent?: unknown }): Promise<GateDecision> {
    const args = (typeof call.arguments === 'object' && call.arguments !== null ? call.arguments : {}) as Record<string, unknown>
    const blocked = await this.options.blocker?.()
    if (blocked !== undefined) return { kind: 'deny', reason: blocked }
    const root = this.options.workspaceRoot(call)
    if (root === undefined) {
      return { kind: 'deny', reason: 'The workspace folder could not be determined, so no file can be uploaded.' }
    }
    let plan: UploadPlan
    try {
      plan = await planUpload(args.path, args.space, root)
    } catch (error) {
      if (error instanceof UploadRefusal) return { kind: 'deny', reason: error.message }
      return { kind: 'deny', reason: 'That file could not be checked, so it was not uploaded.' }
    }
    this.forgetStale()
    this.remembered.set(call.callId, { plan, at: this.now() })

    const where = plan.space ? `the "${plan.space}" space` : 'your personal space'
    const whereZh = plan.space ? `空间“${plan.space}”` : '个人空间'
    // The audited reason carries the hash; the prompt a person reads does not (it means nothing to them).
    const shown = `${plan.displayPath} (${formatBytes(plan.size)})`
    const tail = 'Anyone with access to that space can then find and read it.'
    return {
      kind: 'ask',
      reason: `Upload ${shown}, sha256 ${plan.sha256.slice(0, 12)}, to Quberi, into ${where}. ${tail}`,
      displayReason: {
        en: `Upload ${shown} to Quberi, into ${where}. ${tail}`,
        zh: `把 ${shown} 上传到 Quberi 的${whereZh}。有该空间权限的人都能搜到并读取它。`,
      },
    }
  }

  /** The file approved for this call, once. */
  take(callId: string): UploadPlan {
    const entry = this.remembered.get(callId)
    this.remembered.delete(callId)
    if (entry === undefined || this.now() - entry.at > PLAN_TTL_MS) {
      throw new UploadRefusal('This upload was not approved, so nothing was sent.')
    }
    return entry.plan
  }

  /** Drop the record of a call that will not run (rejected, cancelled, or failed). */
  forget(callId: string): void {
    this.remembered.delete(callId)
  }

  private forgetStale(): void {
    const cutoff = this.now() - PLAN_TTL_MS
    for (const [id, entry] of this.remembered) if (entry.at < cutoff) this.remembered.delete(id)
    while (this.remembered.size >= MAX_PENDING_PLANS) {
      const oldest = this.remembered.keys().next().value
      if (oldest === undefined) break
      this.remembered.delete(oldest)
    }
  }
}
