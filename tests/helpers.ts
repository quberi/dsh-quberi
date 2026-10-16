import { createHash } from 'node:crypto'

import type { TokenStore } from '../src/controller.js'
import type { TokenSet } from '../src/oauth.js'

export const BASE = 'https://api.quberi.com'

/** An in-memory token store with the same serialized read-modify-write contract. */
export function memoryStore(initial?: TokenSet): TokenStore & { value: TokenSet | undefined } {
  let tail: Promise<unknown> = Promise.resolve()
  const store = {
    value: initial,
    read: async () => store.value,
    modify: (mutate: (c: TokenSet | undefined) => Promise<TokenSet | undefined>) => {
      const run = tail.then(async () => {
        const next = await mutate(store.value)
        if (next !== undefined) store.value = next
      })
      tail = run.catch(() => undefined)
      return run
    },
    clear: async () => {
      store.value = undefined
    },
  }
  return store
}

export interface FakeQuberi {
  fetch: typeof fetch
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>
  /** What the next token request answers; default: success. */
  tokenAnswer?: (form: URLSearchParams) => { status: number; body: unknown }
  searchAnswer?: (auth: string) => { status: number; body: unknown }
  saveAnswer?: (auth: string, body: string) => { status: number; body: unknown }
  uploadAnswer?: (auth: string, form: FormData) => { status: number; body: unknown }
  spacesAnswer?: (auth: string) => { status: number; body: unknown }
  documentsAnswer?: (auth: string, query: URLSearchParams) => { status: number; body: unknown }
  /** The multipart bodies the fake received, in order. */
  uploads: FormData[]
  /** Scope stamped on tokens the fake issues; default read + write. */
  grantedScope: string
  tokenCounter: number
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function metadata(base = BASE, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: 'https://ai.quberi.com/oauth/authorize',
    token_endpoint: `${base}/api/v1/oauth/token`,
    revocation_endpoint: `${base}/api/v1/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['knowledge:read'],
    ...over,
  }
}

/** A stand-in for Quberi's OAuth and search endpoints. */
export function fakeQuberi(base = BASE, metadataOver: Record<string, unknown> = {}): FakeQuberi {
  const fake: FakeQuberi = {
    calls: [],
    uploads: [],
    tokenCounter: 0,
    grantedScope: 'knowledge:read knowledge:write',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const isForm = init?.body instanceof FormData
      const body = init?.body === undefined ? '' : isForm ? '[multipart]' : String(init.body)
      fake.calls.push({ url, method: init?.method ?? 'GET', headers, body })
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return json(200, metadata(base, metadataOver))
      }
      if (url.endsWith('/oauth/token')) {
        const form = new URLSearchParams(body)
        if (fake.tokenAnswer) {
          const answer = fake.tokenAnswer(form)
          return json(answer.status, answer.body)
        }
        fake.tokenCounter += 1
        return json(200, {
          access_token: `qbr_at_${fake.tokenCounter}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `qbr_rt_${fake.tokenCounter}`,
          scope: fake.grantedScope,
        })
      }
      if (url.endsWith('/oauth/revoke')) return json(200, {})
      if (url.endsWith('/api/v1/external/search')) {
        const auth = headers.Authorization ?? ''
        if (fake.searchAnswer) {
          const answer = fake.searchAnswer(auth)
          return json(answer.status, answer.body)
        }
        return json(200, {
          organization: 'Acme',
          searched_spaces: 2,
          passages: [
            {
              document_id: 'd1',
              document_name: 'Handbook.md',
              space_id: 's1',
              space_name: 'HR',
              chunk_index: 0,
              text: 'Remote work is allowed.',
              score: 0.9,
            },
          ],
        })
      }
      if (url.endsWith('/api/v1/external/save')) {
        const auth = headers.Authorization ?? ''
        if (fake.saveAnswer) {
          const answer = fake.saveAnswer(auth, body)
          return json(answer.status, answer.body)
        }
        return json(201, {
          document_id: 'doc-1',
          space_id: 'sp-1',
          space_name: 'My space',
          name: 'Note.md',
        })
      }
      if (url.includes('/api/v1/external/spaces')) {
        const auth = headers.Authorization ?? ''
        if (fake.spacesAnswer) {
          const answer = fake.spacesAnswer(auth)
          return json(answer.status, answer.body)
        }
        return json(200, {
          organization: 'Acme',
          total: 2,
          spaces: [
            { name: "chaney's space", kind: 'personal', can_edit: true, document_count: 3 },
            { name: 'Product Team', kind: 'shared', can_edit: false, document_count: 12 },
          ],
        })
      }
      if (url.includes('/api/v1/external/documents')) {
        const auth = headers.Authorization ?? ''
        const query = new URL(url).searchParams
        if (fake.documentsAnswer) {
          const answer = fake.documentsAnswer(auth, query)
          return json(answer.status, answer.body)
        }
        return json(200, {
          space_name: query.get('space') ?? '',
          total: 1,
          next_cursor: null,
          type: query.get('type'),
          documents: [
            { name: 'AI RMF.pdf', mime_type: 'application/pdf', size_bytes: 1946127, updated_at: '2026-10-16T10:10:00Z', status: 'ready' },
          ],
        })
      }
      if (url.endsWith('/api/v1/external/upload')) {
        const auth = headers.Authorization ?? ''
        const form = init?.body as FormData
        fake.uploads.push(form)
        if (fake.uploadAnswer) {
          const answer = fake.uploadAnswer(auth, form)
          return json(answer.status, answer.body)
        }
        const file = form.get('file') as File
        return json(201, {
          document_id: 'doc-2',
          space_id: 'sp-1',
          space_name: 'My space',
          name: file.name,
          mime_type: 'application/pdf',
          size_bytes: file.size,
        })
      }
      return json(404, {})
    }) as typeof fetch,
  }
  return fake
}

export function tokens(over: Partial<TokenSet> = {}): TokenSet {
  return {
    version: 1,
    accessToken: 'qbr_at_old',
    refreshToken: 'qbr_rt_old',
    expiresAt: Date.now() + 3_600_000,
    scope: 'knowledge:read',
    ...over,
  }
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}
