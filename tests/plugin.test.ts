import { describe, expect, it, vi } from 'vitest'

import { Config, apply, inject, name } from '../src/index.js'

import { tokens } from './helpers.js'

type Record_ = { kind: 'grant'; payload: unknown } | undefined

/** Just enough of Harness' context to see what the plugin registers and stores. */
function fakeContext() {
  const records = new Map<string, Record_>()
  const registered: { commands: any[]; tools: any[] } = { commands: [], tools: [] }
  const effects: Array<() => () => unknown> = []
  const ctx: any = {
    logger: { warn: vi.fn() },
    effect: (fn: () => () => unknown) => effects.push(fn),
    commands: { register: (def: unknown) => registered.commands.push(def) },
    tools: { register: (def: unknown) => registered.tools.push(def) },
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
    expect([...inject].sort()).toEqual(['commands', 'credentials', 'tools'])
  })

  it('defaults point at the hosted Quberi and the registered sign-in client', () => {
    expect(config.baseUrl).toBe('https://api.quberi.com')
    expect(config.clientId).toBe('quberi-harness')
  })

  it('registers one command, a search tool and a save tool', async () => {
    const { ctx, registered, effects } = fakeContext()
    await apply(ctx, config)
    expect(registered.commands.map((c) => c.name)).toEqual(['quberi'])
    expect(registered.tools.map((t) => t.name)).toEqual(['quberi_search', 'quberi_save'])
    expect(effects).toHaveLength(1)

    const search = registered.tools.find((t) => t.name === 'quberi_search')!
    // Search reads only: it takes a query and an optional count, nothing else.
    expect(Object.keys(search.parameters.properties).sort()).toEqual(['query', 'top_k'])
    expect(search.parameters.required).toEqual(['query'])

    const save = registered.tools.find((t) => t.name === 'quberi_save')!
    // Save takes the note (title + text) and an optional target space name.
    expect(Object.keys(save.parameters.properties).sort()).toEqual(['space', 'text', 'title'])
    expect(save.parameters.required.sort()).toEqual(['text', 'title'])
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
