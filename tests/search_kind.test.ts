import { afterEach, describe, expect, it } from 'vitest'

import { QuberiController, SEARCH_KINDS, formatSearchResult, resolveKind } from '../src/controller.js'
import type { ControllerOptions, SearchResult } from '../src/controller.js'

import { BASE, fakeQuberi, memoryStore, tokens } from './helpers.js'
import type { FakeQuberi } from './helpers.js'

const live: QuberiController[] = []
function make(over: Partial<ControllerOptions> = {}, fake: FakeQuberi = fakeQuberi()) {
  const controller = new QuberiController({
    baseUrl: BASE,
    clientId: 'quberi-harness',
    scope: 'knowledge:read',
    callbackPort: 0,
    loginTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    refreshSkewMs: 60_000,
    store: memoryStore(tokens()),
    fetch: fake.fetch,
    focusDelayMs: 0,
    ...over,
  })
  live.push(controller)
  return { controller, fake }
}
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.dispose()))
})

const sent = (fake: FakeQuberi) => fake.calls.filter((c) => c.url.endsWith('/external/search')).map((c) => JSON.parse(c.body))
const PREVIEW = `${BASE}/api/v1/external/preview/Lion_1.jpg`

describe('resolveKind', () => {
  it('lets the person narrow the search, and the model only when the person has not', () => {
    expect(SEARCH_KINDS).toEqual(['text', 'image', 'both'])
    for (const requested of [undefined, 'text', 'image', 'both'] as const) {
      expect(resolveKind('text', requested)).toBe('text')
      expect(resolveKind('image', requested)).toBe('image')
    }
    expect(resolveKind('both', undefined)).toBe('both')
    expect(resolveKind('both', 'text')).toBe('text')
    expect(resolveKind('both', 'image')).toBe('image')
  })
})

describe('the search request and response', () => {
  it('reads the pictures of a response, and drops a preview link that is not Quberi’s own', async () => {
    const fake = fakeQuberi()
    fake.searchAnswer = () => ({
      status: 200,
      body: {
        organization: 'Acme',
        searched_spaces: 1,
        passages: [],
        preview_expires_in: 600,
        images: [
          { name: 'lioness.jpg', space_name: 'tech', mime_type: 'image/jpeg', size_bytes: 9, score: 0.4, preview_url: PREVIEW },
          { name: 'evil.jpg', space_name: 'tech', mime_type: 'image/jpeg', size_bytes: 9, score: 0.3, preview_url: 'https://evil.example/x.jpg' },
          { name: '', space_name: 'tech', mime_type: 'image/jpeg', size_bytes: 9, score: 0.2 },
        ],
      },
    })
    const { controller } = make({}, fake)
    const result = await controller.search('lion', 5)
    expect(result.preview_expires_in).toBe(600)
    expect(result.images.map((i) => [i.name, i.preview_url])).toEqual([
      ['lioness.jpg', PREVIEW],
      ['evil.jpg', undefined],
    ])
  })

  it('treats a server that sends no pictures as having none', async () => {
    const { controller } = make()
    const result = await controller.search('leave', 5)
    expect(result.images).toEqual([])
    expect(result.preview_expires_in).toBe(0)
  })

  it('sends the kind only when it narrows the search', async () => {
    const { controller, fake } = make()
    await controller.search('x', 5)
    await controller.search('x', 5, undefined, undefined, 'both')
    await controller.search('x', 5, undefined, undefined, 'text')
    expect(sent(fake).map((b) => b.kind)).toEqual([undefined, undefined, 'text'])
  })

  it('asks again without the field when an older server refuses it', async () => {
    const fake = fakeQuberi()
    fake.searchAnswer = (_auth, body) =>
      JSON.parse(body).kind !== undefined
        ? { status: 422, body: { detail: [{ type: 'extra_forbidden', loc: ['body', 'kind'] }] } }
        : { status: 200, body: { organization: 'Acme', searched_spaces: 1, passages: [] } }
    const { controller } = make({}, fake)
    const result = await controller.search('x', 5, undefined, undefined, 'text')
    expect(result.searched_spaces).toBe(1)
    expect(sent(fake).map((b) => b.kind)).toEqual(['text', undefined])
  })

  it('does not retry a refusal that is not about the field', async () => {
    const fake = fakeQuberi()
    fake.searchAnswer = () => ({ status: 422, body: {} })
    const { controller } = make({}, fake)
    await expect(controller.search('x', 5, undefined, 'Parts')).rejects.toThrow(/cannot limit a search to one space/u)
    expect(sent(fake)).toHaveLength(1)
  })
})

describe('what the model is shown with related pictures', () => {
  const EMPTY: SearchResult = {
    organization: 'Acme', searched_spaces: 1, passages: [], pending_documents: [], pending_total: 0, images: [], preview_expires_in: 0,
  }
  const hit = { name: 'lioness.jpg', space_name: 'tech', mime_type: 'image/jpeg', size_bytes: 9, score: 0.4, preview_url: PREVIEW }
  const passage = { document_id: 'd', document_name: 'Zoo.md', space_id: 's', space_name: 'tech', chunk_index: 0, text: 'Lions live in prides.', score: 0.8 }

  it('puts the pictures after the passages, hedged, with the exact image line', () => {
    const text = formatSearchResult('lion', { ...EMPTY, passages: [passage], images: [hit], preview_expires_in: 600 })
    expect(text.indexOf('Lions live in prides.')).toBeLessThan(text.indexOf('MIGHT be related'))
    expect(text).toContain(`![lioness.jpg](${PREVIEW})`)
    expect(text).toMatch(/possible matches only; you cannot see them/u)
    expect(text).toMatch(/If none plausibly fits, do not mention these pictures/u)
    expect(text).toMatch(/about 10 minutes/u)
  })

  it('still says no passages were found, and offers the pictures', () => {
    const text = formatSearchResult('动物母狮', { ...EMPTY, images: [hit] })
    expect(text).toMatch(/found no passages/u)
    expect(text).toContain(`![lioness.jpg](${PREVIEW})`)
  })

  it('lists a picture without a preview as such, and keeps picture names from becoming Markdown', () => {
    const text = formatSearchResult('x', {
      ...EMPTY,
      images: [{ ...hit, name: 'a](https://evil.example/x.png)![b', preview_url: undefined }],
    })
    expect(text).toContain('(no preview is available for this picture)')
    expect(text).not.toContain('![a](https://evil.example')
  })

  it('adds nothing when there are no pictures', () => {
    const text = formatSearchResult('x', { ...EMPTY, passages: [passage] })
    expect(text).not.toMatch(/picture/iu)
  })
})

describe('/quberi mode', () => {
  it('starts from the configured default and says what it means', async () => {
    expect(make().controller.searchMode).toBe('both')
    const { controller } = make({ searchMode: 'text' })
    expect(controller.searchMode).toBe('text')
    expect((await controller.command('mode')).text).toMatch(/Search mode: text.*\n.*\/quberi mode both/su)
  })

  it('changes the mode, case-insensitively, and says it lasts until Harness restarts', async () => {
    const { controller } = make()
    const result = await controller.command('mode Image')
    expect(result.kind).toBe('success')
    expect(result.text).toMatch(/Search mode: image/u)
    expect(result.text).toMatch(/until Harness restarts/u)
    expect(controller.searchMode).toBe('image')
  })

  it('refuses a mode it does not know and leaves the mode alone', async () => {
    const { controller } = make({ searchMode: 'text' })
    const result = await controller.command('mode everything')
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/is not a search mode/u)
    expect(controller.searchMode).toBe('text')
  })

  it('is shown by status, and "modes" is not mistaken for the command', async () => {
    const { controller } = make({ searchMode: 'image' })
    expect(await controller.status()).toMatch(/Search mode: image\.$/u)
    expect((await controller.command('modes')).kind).toBe('error')
  })
})
