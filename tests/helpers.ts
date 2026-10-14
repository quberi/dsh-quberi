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
    tokenCounter: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = init?.body === undefined ? '' : String(init.body)
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
          scope: 'knowledge:read',
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
