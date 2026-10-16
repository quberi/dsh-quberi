import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Config, apply, inject, name } from '../src/index.js'

import { fakeQuberi, tokens } from './helpers.js'

type Record_ = { kind: 'grant'; payload: unknown } | undefined

/** Just enough of Harness' context to see what the plugin registers and stores. */
function fakeContext(workspace?: string) {
  const records = new Map<string, Record_>()
  const registered: { commands: any[]; tools: any[]; listeners: Array<{ event: string; handler: any }> } = {
    commands: [],
    tools: [],
    listeners: [],
  }
  const effects: Array<() => () => unknown> = []
  const ctx: any = {
    logger: { warn: vi.fn() },
    effect: (fn: () => () => unknown) => effects.push(fn),
    commands: { register: (def: unknown) => registered.commands.push(def) },
    tools: { register: (def: unknown) => registered.tools.push(def) },
    on: (event: string, handler: unknown) => registered.listeners.push({ event, handler }),
    // Looked up by name at call time, like Harness' own tools service does; a test can drop one.
    services: {
      sessions: { get: (id: unknown) => (id === 'session-1' ? { id } : undefined) },
      sandboxPolicy: {
        resolve: (req: { session: unknown }) => ({ mode: 'workspace-write', workspaceRoot: workspace ?? '/nonexistent', session: req.session }),
      },
    } as Record<string, unknown>,
    get(name: string) {
      return this.services[name]
    },
    credentials: {
      readRecord: async (key: string) => records.get(key),
      deleteRecord: async (key: string) => void records.delete(key),
      modifyRecord: async (key: string, mutate: (c: Record_) => Promise<Record_>) => {
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, next)
        return records.get(key)
      },
    },
  }
  return { ctx, records, registered, effects }
}

const config = Config({}) as ReturnType<typeof Config>

describe('plugin wiring', () => {
  it('asks for the services it uses and is named for its credential scope', () => {
    expect(name).toBe('quberi')
    // Cordis loads a plugin only while every listed service exists, so the workspace
    // services behind file upload must not be listed: search and save load without them.
    expect([...inject].sort()).toEqual(['commands', 'credentials', 'tools'])
  })

  it('defaults point at the hosted Quberi and the registered sign-in client', () => {
    expect(config.baseUrl).toBe('https://api.quberi.com')
    expect(config.clientId).toBe('quberi-harness')
  })

  it('registers one command, and search, save and upload tools', async () => {
    const { ctx, registered, effects } = fakeContext()
    await apply(ctx, config)
    expect(registered.commands.map((c) => c.name)).toEqual(['quberi'])
    expect(registered.tools.map((t) => t.name)).toEqual([
      'quberi_search',
      'quberi_save',
      'quberi_list_spaces',
      'quberi_list_documents',
      'quberi_upload_file',
    ])
    expect(effects).toHaveLength(1)

    const search = registered.tools.find((t) => t.name === 'quberi_search')!
    // Search reads only: it takes a query and an optional count, nothing else.
    expect(Object.keys(search.parameters.properties).sort()).toEqual(['query', 'top_k'])
    expect(search.parameters.required).toEqual(['query'])

    const save = registered.tools.find((t) => t.name === 'quberi_save')!
    // Save takes the note (title + text) and an optional target space name.
    expect(Object.keys(save.parameters.properties).sort()).toEqual(['space', 'text', 'title'])
    expect(save.parameters.required.sort()).toEqual(['text', 'title'])
    const upload = registered.tools.find((t) => t.name === 'quberi_upload_file')!
    // Upload takes a path and an optional space; nothing that could carry file content or a URL.
    expect(Object.keys(upload.parameters.properties).sort()).toEqual(['path', 'space'])
    expect(upload.parameters.required).toEqual(['path'])
    // Browsing takes no free text that could carry content: a space name and a page cursor.
    const spaces = registered.tools.find((t) => t.name === 'quberi_list_spaces')!
    expect(Object.keys(spaces.parameters.properties ?? {})).toEqual([])
    const documents = registered.tools.find((t) => t.name === 'quberi_list_documents')!
    expect(Object.keys(documents.parameters.properties).sort()).toEqual(['cursor', 'space'])
    expect(documents.parameters.required).toEqual(['space'])
  })

  it('refuses a non-https server address up front', async () => {
    const { ctx } = fakeContext()
    await expect(apply(ctx, { ...config, baseUrl: 'http://quberi.example' })).rejects.toThrow(/https/)
  })

  it('keeps the sign-in as one credential record owned by this plugin', async () => {
    const { ctx, records, registered } = fakeContext()
    await apply(ctx, config)
    const command = registered.commands[0]

    expect((await command.handler({ rawInput: ' status ' })).text).toMatch(/Not connected/)

    const key = 'quberi/oauth'
    records.set(key, { kind: 'grant', payload: tokens() })
    expect((await command.handler({ rawInput: 'status' })).text).toMatch(/Connected to Quberi/)

    // Something else's record shape is not mistaken for ours.
    records.set(key, { kind: 'grant', payload: { nope: true } })
    expect((await command.handler({ rawInput: 'status' })).text).toMatch(/Not connected/)
  })

  it('with automatic sign-in off, the tool says to run /quberi login and touches nothing', async () => {
    const { ctx, registered } = fakeContext()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await apply(ctx, { ...config, autoLogin: false, openBrowser: false, focusApp: false })
    const tool = registered.tools[0]
    await expect(
      tool.execute({ query: 'leave policy' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/Run \/quberi login/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('by default it will sign in on first use and refocus Harness; both can be turned off', () => {
    expect(config.openBrowser).toBe(true)
    expect(config.autoLogin).toBe(true)
    expect(config.focusApp).toBe(true)
  })
})

describe('file upload: the approval gate', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function workspace(): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'quberi-plugin-')))
    const dir = join(root, 'ws')
    mkdirSync(dir)
    writeFileSync(join(dir, 'spec.pdf'), Buffer.from('%PDF-1.7\nhello'))
    return dir
  }

  async function mounted(dir: string, over: Partial<typeof config> = {}) {
    const harness = fakeContext(dir)
    await apply(harness.ctx, { ...config, openBrowser: false, focusApp: false, ...over })
    const listener = harness.registered.listeners.find((l) => l.event === 'tools/pre-execute')?.handler
    const upload = harness.registered.tools.find((t) => t.name === 'quberi_upload_file')
    return { ...harness, listener, upload }
  }

  const call = (over: Record<string, unknown> = {}) => ({
    name: 'quberi_upload_file',
    callId: 'call-1',
    arguments: { path: 'spec.pdf' },
    agent: { id: 'session-1', session: { id: 'session-1' } },
    ...over,
  })
  const exec = (callId = 'call-1') => ({ callId, signal: new AbortController().signal })
  const allow = async () => ({ kind: 'allow' as const })

  it('asks the person before an upload, naming the file', async () => {
    const dir = workspace()
    const { listener } = await mounted(dir)
    const decision = await listener(call(), allow)
    expect(decision.kind).toBe('ask')
    expect(decision.displayReason.en).toContain('spec.pdf')
    expect(decision.displayReason.zh).toContain('spec.pdf')
  })

  it('leaves every other tool alone', async () => {
    const { listener } = await mounted(workspace())
    let delegated = 0
    const next = async () => {
      delegated += 1
      return { kind: 'allow' as const }
    }
    expect(await listener(call({ name: 'quberi_search' }), next)).toEqual({ kind: 'allow' })
    expect(await listener(call({ name: 'bash' }), next)).toEqual({ kind: 'allow' })
    expect(delegated).toBe(2)
  })

  it('keeps another policy\'s refusal, and does not ask over it', async () => {
    const { listener } = await mounted(workspace())
    const denied = { kind: 'deny' as const, reason: 'plan mode' }
    expect(await listener(call(), async () => denied)).toBe(denied)
    const cancelled = { kind: 'cancel' as const }
    expect(await listener(call(), async () => cancelled)).toBe(cancelled)
  })

  it('denies a file outside the workspace without asking', async () => {
    const dir = workspace()
    writeFileSync(join(dir, '..', 'outside.pdf'), '%PDF-1.7')
    const { listener } = await mounted(dir)
    const decision = await listener(call({ arguments: { path: '../outside.pdf' } }), allow)
    expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/outside/u) })
  })

  it('denies when the call has no session, or the session has no workspace', async () => {
    const { listener } = await mounted(workspace())
    expect((await listener(call({ agent: undefined }), allow)).kind).toBe('deny')
    expect((await listener(call({ agent: { id: 'unknown' } }), allow)).kind).toBe('deny')
  })

  it('finds the session through the store when the agent does not carry it', async () => {
    const { listener } = await mounted(workspace())
    expect((await listener(call({ agent: { id: 'session-1' } }), allow)).kind).toBe('ask')
  })

  it('denies when the host has no workspace service at all', async () => {
    const dir = workspace()
    const harness = fakeContext(dir)
    delete harness.ctx.services.sandboxPolicy
    await apply(harness.ctx, { ...config, openBrowser: false, focusApp: false })
    const listener = harness.registered.listeners.find((l) => l.event === 'tools/pre-execute')!.handler
    expect((await listener(call(), allow)).kind).toBe('deny')
  })

  it('will not send anything for a call that was never asked about', async () => {
    const fake = fakeQuberi()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch)
    const { upload, records } = await mounted(workspace())
    records.set('quberi/oauth', { kind: 'grant', payload: tokens({ scope: 'knowledge:read knowledge:write knowledge:upload' }) })
    await expect(upload.execute({ path: 'spec.pdf' }, exec())).rejects.toThrow(/not approved/u)
    expect(fake.calls).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('sends the approved file once the question was asked, and not a second time', async () => {
    const dir = workspace()
    // The plugin captures `fetch` when it is mounted, so the fake goes in first.
    const fake = fakeQuberi()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch)
    const { listener, upload, records } = await mounted(dir)
    records.set('quberi/oauth', { kind: 'grant', payload: tokens({ scope: 'knowledge:read knowledge:write knowledge:upload' }) })
    expect((await listener(call(), allow)).kind).toBe('ask')
    const done = await upload.execute({ path: 'spec.pdf' }, exec())
    expect(done.text).toMatch(/Uploaded to .* as "spec\.pdf"/u)
    expect(done.title).toMatch(/已上传|Uploaded/u)
    expect(done.markdown).toContain('spec')
    expect(fake.uploads).toHaveLength(1)
    expect((fake.uploads[0].get('file') as File).name).toBe('spec.pdf')
    await expect(upload.execute({ path: 'spec.pdf' }, exec())).rejects.toThrow(/not approved/u)
    expect(fake.uploads).toHaveLength(1)
    fetchSpy.mockRestore()
  })

  it('refuses a file changed between the question and the send', async () => {
    const dir = workspace()
    // The plugin captures `fetch` when it is mounted, so the fake goes in first.
    const fake = fakeQuberi()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch)
    const { listener, upload, records } = await mounted(dir)
    records.set('quberi/oauth', { kind: 'grant', payload: tokens({ scope: 'knowledge:read knowledge:write knowledge:upload' }) })
    await listener(call(), allow)
    writeFileSync(join(dir, 'spec.pdf'), Buffer.from('%PDF-1.7\nswapped'))
    await expect(upload.execute({ path: 'spec.pdf' }, exec())).rejects.toThrow(/changed after you approved/u)
    expect(fake.uploads).toHaveLength(0)
    fetchSpy.mockRestore()
  })

  it('does not even ask when the sign-in cannot upload', async () => {
    const { listener, records } = await mounted(workspace())
    records.set('quberi/oauth', { kind: 'grant', payload: tokens({ scope: 'knowledge:read knowledge:write' }) })
    const decision = await listener(call(), allow)
    expect(decision).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/cannot upload files/u) })
  })

  it('asks for the upload permission at sign-in only when uploads are on', async () => {
    for (const [uploadFiles, expected] of [
      [true, 'knowledge:read knowledge:write knowledge:upload'],
      [false, 'knowledge:read knowledge:write'],
    ] as const) {
      const fake = fakeQuberi()
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch)
      const { registered, effects } = await mounted(workspace(), { uploadFiles })
      const out = await registered.commands[0].handler({ rawInput: 'login' })
      const link = /https:\/\/\S+/u.exec(out.text)?.[0]
      expect(new URL(link!).searchParams.get('scope')).toBe(expected)
      await effects[0]()()
      fetchSpy.mockRestore()
    }
  })

  it('with uploads turned off, registers no upload tool and no gate, and does not ask for the permission', async () => {
    const { registered, listener } = await mounted(workspace(), { uploadFiles: false })
    expect(registered.tools.map((t) => t.name)).toEqual([
      'quberi_search',
      'quberi_save',
      'quberi_list_spaces',
      'quberi_list_documents',
    ])
    expect(listener).toBeUndefined()
    expect(config.uploadFiles).toBe(true)
  })
})

describe('how the tools look in the conversation', () => {
  const signedIn = (records: Map<string, Record_>) =>
    records.set('quberi/oauth', {
      kind: 'grant',
      payload: tokens({ scope: 'knowledge:read knowledge:write knowledge:upload' }),
    })
  const exec = () => ({ callId: 'c1', signal: new AbortController().signal })

  async function mountedWithFake(over: (fake: ReturnType<typeof fakeQuberi>) => void = () => undefined) {
    const fake = fakeQuberi()
    over(fake)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch)
    const harness = fakeContext('/nonexistent')
    await apply(harness.ctx, { ...config, openBrowser: false, focusApp: false })
    signedIn(harness.records)
    const tool = (name: string) => harness.registered.tools.find((t) => t.name === name)!
    return { ...harness, fake, tool, restore: () => fetchSpy.mockRestore() }
  }

  it('every tool shows a title while it runs, and the upload also points at its file', async () => {
    const { tool, restore } = await mountedWithFake()
    const call = (name: string, args: unknown) => tool(name).presentCall(args)
    expect(call('quberi_search', { query: 'AI RMF' })).toMatchObject({ card: 'generic', kind: 'search' })
    expect(call('quberi_save', { title: 'T', text: 'b' })).toMatchObject({ card: 'generic', kind: 'other' })
    expect(call('quberi_list_spaces', {})).toMatchObject({ card: 'generic', kind: 'search' })
    expect(call('quberi_list_documents', { space: 'Std' })).toMatchObject({ card: 'generic', kind: 'search' })
    const upload = call('quberi_upload_file', { path: 'docs/a.pdf', space: 'Ops' })
    expect(upload).toMatchObject({ card: 'generic', kind: 'other', locations: [{ path: 'docs/a.pdf' }] })
    expect(upload.title).toContain('docs/a.pdf')
    // Arguments that do not fit the tool fall back to Harness' default card instead of throwing.
    expect(() => call('quberi_upload_file', null)).not.toThrow()
    expect(call('quberi_upload_file', { path: 5 })?.locations).toBeUndefined()
    restore()
  })

  it('lists spaces: the model gets plain text, the person gets a card', async () => {
    const { tool, restore } = await mountedWithFake()
    const out = await tool('quberi_list_spaces').execute({}, exec())
    expect(out.text).toContain('"Product Team" (shared space, read only, 12 documents)')
    expect(out.markdown).toContain('Product Team')
    expect(out.title).toMatch(/List spaces|查看空间列表/u)
    // What the model reads is only the text; the card never reaches it.
    const blocks = tool('quberi_list_spaces').output.render({}, out)
    expect(blocks).toEqual([{ type: 'text', text: out.text }])
    expect(JSON.stringify(blocks)).not.toContain('📁')
    restore()
  })

  it('lists documents for a named space and hands the next-page cursor to the model', async () => {
    const { tool, fake, restore } = await mountedWithFake((f) => {
      f.documentsAnswer = (_auth, query) => ({
        status: 200,
        body: {
          space_name: query.get('space'),
          total: 80,
          next_cursor: 'page-2',
          documents: [{ name: 'A.pdf', mime_type: 'application/pdf', size_bytes: 5, updated_at: '2026-10-16T10:10:00Z', status: 'ready' }],
        },
      })
    })
    const out = await tool('quberi_list_documents').execute({ space: 'Std', cursor: 'page-1' }, exec())
    expect(out.text).toContain('cursor "page-2"')
    expect(out.markdown).not.toContain('page-2')
    const seen = fake.calls.find((c) => c.url.includes('/external/documents'))!
    expect(new URL(seen.url).searchParams.get('cursor')).toBe('page-1')
    restore()
  })

  it('hands the screen only a title and Markdown, and nothing for a failed call', async () => {
    const { tool, restore } = await mountedWithFake()
    const search = tool('quberi_search')
    const out = await search.execute({ query: 'remote work' }, exec())
    const meta = search.output.presentationMeta({ query: 'remote work' }, out)
    expect(Object.keys(meta).sort()).toEqual(['markdown', 'title'])
    const view = search.presentResult({ query: 'remote work' }, { content: [], isError: false, meta })
    expect(view).toMatchObject({ card: 'generic', title: expect.stringContaining('remote work') })
    expect(view.content[0]).toMatchObject({ type: 'text' })
    expect(view.content[0].text).toContain('Handbook')
    // Failed call, or a result with no card data (replayed from an older session): keep the default.
    const args = { query: 'remote work' }
    expect(search.presentResult(args, { content: [], isError: true, meta })).toBeUndefined()
    expect(search.presentResult(args, { content: [], isError: false })).toBeUndefined()
    expect(search.presentResult(args, { content: [], isError: false, meta: { title: 5 } })).toBeUndefined()
    restore()
  })

  it('an empty card body is left out rather than shown blank', async () => {
    const { tool, restore } = await mountedWithFake((f) => {
      f.searchAnswer = () => ({ status: 200, body: { organization: 'A', searched_spaces: 1, passages: [] } })
    })
    const search = tool('quberi_search')
    const out = await search.execute({ query: 'x' }, exec())
    const meta = search.output.presentationMeta({ query: 'x' }, out)
    const view = search.presentResult({ query: 'x' }, { content: [], isError: false, meta })
    expect(view).toMatchObject({ card: 'generic' })
    expect(view).not.toHaveProperty('content')
    expect(out.text).toMatch(/found no passages/u)
    restore()
  })

  it('save reports where the note went, in the model text and on the card', async () => {
    const { tool, restore } = await mountedWithFake()
    const out = await tool('quberi_save').execute({ title: 'Conclusion', text: 'We ship B.' }, exec())
    expect(out.text).toMatch(/Saved to/u)
    expect(out.title).toMatch(/已保存到|Saved to/u)
    restore()
  })
})
