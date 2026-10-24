import { describe, expect, it } from 'vitest'

import {
  defaultAuthUrl,
  normaliseBaseUrl,
  oauthErrorFrom,
  parseMetadata,
  parseTokenResponse,
  pkceChallenge,
  readTokenSet,
  statesMatch,
} from '../src/oauth.js'

import { AUTH, BASE, metadata } from './helpers.js'

describe('PKCE', () => {
  it('matches the RFC 7636 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('compares state values exactly', () => {
    expect(statesMatch('abc', 'abc')).toBe(true)
    expect(statesMatch('abc', 'abd')).toBe(false)
    expect(statesMatch('abc', 'abcd')).toBe(false)
    expect(statesMatch('abc', '')).toBe(false)
  })
})

describe('baseUrl', () => {
  it('accepts https and a local development server, nothing else', () => {
    expect(normaliseBaseUrl('https://api.quberi.com/')).toBe('https://api.quberi.com')
    expect(normaliseBaseUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000')
    for (const bad of [
      'http://api.quberi.com',
      'ftp://api.quberi.com',
      'https://user:pw@api.quberi.com',
      'https://api.quberi.com?x=1',
      'https://api.quberi.com#x',
    ]) {
      expect(() => normaliseBaseUrl(bad), bad).toThrow()
    }
  })
})

describe('where signing in happens', () => {
  it('is the web origin for the hosted service, and the API itself otherwise', () => {
    expect(defaultAuthUrl(BASE)).toBe(AUTH)
    expect(defaultAuthUrl('https://quberi.example.org')).toBe('https://quberi.example.org')
    expect(defaultAuthUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000')
  })
})

describe('discovery document', () => {
  it('accepts a good one; the browser page may be on the web origin', () => {
    const m = parseMetadata(metadata(), AUTH)
    expect(m.tokenEndpoint).toBe(`${AUTH}/api/v1/oauth/token`)
    expect(m.authorizationEndpoint).toBe('https://ai.quberi.com/oauth/authorize')
  })

  it('accepts a login page on another origin, since nothing secret goes there', () => {
    const m = parseMetadata(metadata(AUTH, { authorization_endpoint: 'https://web.example/oauth/authorize' }), AUTH)
    expect(m.authorizationEndpoint).toBe('https://web.example/oauth/authorize')
  })

  it('wants the sign-in server to name itself, not the API', () => {
    // The hosted service says issuer = ai.quberi.com on both of its origins. Read as the API's, it is wrong.
    expect(() => parseMetadata(metadata(AUTH), BASE)).toThrow(/issuer must be https:\/\/api\.quberi\.com/)
    expect(() => parseMetadata(metadata(BASE), AUTH)).toThrow(/issuer must be https:\/\/ai\.quberi\.com/)
  })

  it('still reads the one-origin layout a self-hosted Quberi has', () => {
    const own = 'https://quberi.example.org'
    expect(parseMetadata(metadata(own), own).tokenEndpoint).toBe(`${own}/api/v1/oauth/token`)
  })

  it.each([
    ['another issuer', { issuer: 'https://evil.example' }],
    ['no S256', { code_challenge_methods_supported: ['plain'] }],
    ['no refresh grant', { grant_types_supported: ['authorization_code'] }],
    ['client secret required', { token_endpoint_auth_methods_supported: ['client_secret_post'] }],
    ['token endpoint elsewhere', { token_endpoint: 'https://evil.example/token' }],
    ['revocation endpoint elsewhere', { revocation_endpoint: 'https://evil.example/revoke' }],
    ['plain-http login page', { authorization_endpoint: 'http://ai.quberi.com/oauth/authorize' }],
  ])('rejects %s (we would send a code or token there)', (_label, over) => {
    expect(() => parseMetadata(metadata(AUTH, over), AUTH)).toThrow()
  })
})

describe('token responses', () => {
  const ok = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'knowledge:read' }

  it('reads a good response', () => {
    expect(parseTokenResponse(ok)).toMatchObject({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 })
  })

  it.each([
    [{ ...ok, access_token: '' }],
    [{ ...ok, refresh_token: undefined }],
    [{ ...ok, token_type: 'MAC' }],
    [{ ...ok, expires_in: 0 }],
    [{ ...ok, expires_in: '3600' }],
  ])('rejects %j', (bad) => {
    expect(() => parseTokenResponse(bad as Record<string, unknown>)).toThrow()
  })

  it('reads a stored token set only if it is complete', () => {
    expect(readTokenSet({ version: 1, accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: 's' })).toBeDefined()
    for (const bad of [undefined, null, {}, { version: 2, accessToken: 'a', refreshToken: 'r', expiresAt: 1 }, { version: 1, accessToken: '', refreshToken: 'r', expiresAt: 1 }, { version: 1, accessToken: 'a', refreshToken: 'r' }]) {
      expect(readTokenSet(bad)).toBeUndefined()
    }
  })

  it('never puts a token in an error message', () => {
    const err = oauthErrorFrom({ error: 'invalid_grant', error_description: 'the code is invalid' }, 400)
    expect(err.code).toBe('invalid_grant')
    expect(err.message).toBe('invalid_grant: the code is invalid')
  })
})
