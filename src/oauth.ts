/**
 * The OAuth pieces that do not depend on DeepSeek Harness: PKCE, reading
 * Quberi's discovery document, and reading token responses.
 *
 * Everything that crosses the network is untrusted, so each value is checked
 * before use and nothing here ever logs or returns a token to the caller of a
 * message.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_SET_VERSION = 1
/** Largest JSON body we are willing to read from the authorization server. */
export const MAX_WIRE_JSON_BYTES = 64 * 1024

/** What Quberi's `/.well-known/oauth-authorization-server` must tell us. */
export interface Metadata {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint: string
}

/** The tokens we keep. Stored as one record; never shown to the model. */
export interface TokenSet {
  readonly version: 1
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
  readonly scope: string
}

export interface TokenResponse {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
  readonly scope: string
}

/** An error from the authorization server, using its standard `error` code. */
export class OAuthRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'OAuthRequestError'
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

/** RFC 7636 `S256`. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** Constant-time comparison for the browser's untrusted `state`. */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

export function parseJsonObject(text: string, subject: string): Record<string, unknown> {
  if (Buffer.byteLength(text, 'utf8') > MAX_WIRE_JSON_BYTES) {
    throw new Error(`${subject} is too large`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${subject} was not valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Quberi OAuth response field "${field}" must be a non-empty string`)
  }
  return value
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
}

/** The address of the Quberi API, without a trailing slash. HTTPS, or loopback HTTP for development. */
export function normaliseBaseUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new Error('quberi: baseUrl must use https:// (http:// is only allowed for a local development server)')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('quberi: baseUrl must not contain credentials, a query or a fragment')
  }
  return url.origin
}

/**
 * Check the discovery document. We only ever send a token or a code to
 * endpoints on the same origin as the configured Quberi API; the browser page
 * (`authorization_endpoint`) may live on the web app's origin, because
 * nothing secret is sent to it by this plugin.
 */
export function parseMetadata(record: Record<string, unknown>, baseUrl: string): Metadata {
  if (stringField(record, 'issuer') !== baseUrl) {
    throw new Error(`Quberi OAuth metadata issuer must be ${baseUrl}`)
  }
  const methods = record.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new Error('Quberi OAuth metadata does not advertise PKCE S256')
  }
  const grants = record.grant_types_supported
  if (!Array.isArray(grants) || !grants.includes('authorization_code') || !grants.includes('refresh_token')) {
    throw new Error('Quberi OAuth metadata must advertise the authorization_code and refresh_token grants')
  }
  const auth = record.token_endpoint_auth_methods_supported
  if (!Array.isArray(auth) || !auth.includes('none')) {
    throw new Error('Quberi OAuth metadata does not allow a public client')
  }
  const sameOrigin = (field: string): string => {
    const url = new URL(stringField(record, field))
    if (url.origin !== baseUrl) {
      throw new Error(`Quberi OAuth metadata field "${field}" must be on ${baseUrl}`)
    }
    return url.href
  }
  const authorization = new URL(stringField(record, 'authorization_endpoint'))
  if (authorization.protocol !== 'https:' && !isLoopbackHttp(authorization)) {
    throw new Error('Quberi OAuth metadata field "authorization_endpoint" must use https')
  }
  return Object.freeze({
    issuer: baseUrl,
    authorizationEndpoint: authorization.href,
    tokenEndpoint: sameOrigin('token_endpoint'),
    revocationEndpoint: sameOrigin('revocation_endpoint'),
  })
}

export function parseTokenResponse(record: Record<string, unknown>): TokenResponse {
  const expiresIn = record.expires_in
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Quberi OAuth response field "expires_in" must be a positive number')
  }
  if (stringField(record, 'token_type').toLowerCase() !== 'bearer') {
    throw new Error('Quberi OAuth response token_type must be Bearer')
  }
  return Object.freeze({
    accessToken: stringField(record, 'access_token'),
    refreshToken: stringField(record, 'refresh_token'),
    expiresIn,
    scope: typeof record.scope === 'string' ? record.scope : '',
  })
}

/** Read a stored token set; `undefined` if it is missing or not ours. */
export function readTokenSet(value: unknown): TokenSet | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const r = value as Record<string, unknown>
  if (
    r.version !== TOKEN_SET_VERSION ||
    typeof r.accessToken !== 'string' ||
    typeof r.refreshToken !== 'string' ||
    !r.accessToken ||
    !r.refreshToken ||
    typeof r.expiresAt !== 'number' ||
    !Number.isFinite(r.expiresAt)
  ) {
    return undefined
  }
  return Object.freeze({
    version: TOKEN_SET_VERSION,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.expiresAt,
    scope: typeof r.scope === 'string' ? r.scope : '',
  })
}

/** The standard error body, without ever echoing a token. */
export function oauthErrorFrom(record: Record<string, unknown>, status: number): OAuthRequestError {
  const code = typeof record.error === 'string' ? record.error : 'server_error'
  const description = typeof record.error_description === 'string' ? record.error_description : ''
  return new OAuthRequestError(
    code,
    description ? `${code}: ${description}` : `${code} (HTTP ${status})`,
    status,
  )
}

// ---------------------------------------------------------------------------
// Where the browser lands when sign-in is over
// ---------------------------------------------------------------------------

/** The outcomes Quberi's result page knows how to explain. Anything else is not sent. */
export type LoginOutcome = 'ok' | 'cancelled' | 'org_off' | 'failed'

/**
 * Quberi's own result page, on the same origin as the sign-in page.
 *
 * The page is given only one of a few fixed outcome words, never a message from
 * the server, so nothing a server (or anyone else) says can be shown on it.
 */
export function resultPageUrl(authorizationEndpoint: string, outcome: LoginOutcome): string {
  const origin = new URL(authorizationEndpoint).origin
  return `${origin}/oauth/connected?status=${outcome}`
}
