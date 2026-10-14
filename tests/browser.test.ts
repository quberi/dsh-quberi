import { describe, expect, it, vi } from 'vitest'

import { canOpenBrowser, focusHostApp, openInBrowser } from '../src/browser.js'
import type { Environment, Spawner } from '../src/browser.js'

function recorder() {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = []
  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref: () => undefined, on: () => undefined }
  }
  return { calls, spawner }
}

const mac: Environment = {
  platform: 'darwin',
  env: {},
  execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
}

describe('opening the browser', () => {
  it('uses the platform opener and passes the address as ONE argument (no shell)', () => {
    const url = 'https://ai.quberi.com/oauth/authorize?a=1&b=2;rm -rf ~'
    for (const [platform, command] of [
      ['darwin', 'open'],
      ['linux', 'xdg-open'],
      ['win32', 'rundll32'],
    ] as const) {
      const { calls, spawner } = recorder()
      const env = { platform, env: { DISPLAY: ':0' }, execPath: '/x' }
      expect(openInBrowser(url, env, spawner)).toBe(true)
      expect(calls[0]?.command).toBe(command)
      expect(calls[0]?.args.at(-1)).toBe(new URL(url).href)
      // Never run through a shell, where `&` and `;` would mean something.
      expect(JSON.stringify(calls[0]?.options)).not.toContain('"shell":true')
    }
  })

  it('only opens http(s) addresses', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ssh://host', 'not a url', '']) {
      const { calls, spawner } = recorder()
      expect(openInBrowser(bad, mac, spawner), bad).toBe(false)
      expect(calls).toHaveLength(0)
    }
  })

  it('does not try on a remote shell or a machine with no screen', () => {
    expect(canOpenBrowser({ ...mac, env: { SSH_CONNECTION: '1 2 3 4' } })).toBe(false)
    expect(canOpenBrowser({ ...mac, env: { SSH_TTY: '/dev/pts/0' } })).toBe(false)
    expect(canOpenBrowser({ platform: 'linux', env: {}, execPath: '/x' })).toBe(false)
    expect(canOpenBrowser({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, execPath: '/x' })).toBe(true)
    const { calls, spawner } = recorder()
    expect(openInBrowser('https://ai.quberi.com/', { ...mac, env: { SSH_CONNECTION: 'x' } }, spawner)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('survives the opener being missing', () => {
    const throwing: Spawner = () => {
      throw new Error('ENOENT')
    }
    expect(openInBrowser('https://ai.quberi.com/', mac, throwing)).toBe(false)
  })
})

describe('bringing Harness back to the front', () => {
  it('opens the app bundle this process belongs to (macOS)', () => {
    const { calls, spawner } = recorder()
    expect(focusHostApp(mac, spawner)).toBe(true)
    expect(calls[0]).toMatchObject({ command: 'open', args: ['/Applications/DeepSeek Harness.app'] })
  })

  it('picks the OUTER app when running from a helper process', () => {
    const { calls, spawner } = recorder()
    const helper: Environment = {
      ...mac,
      execPath:
        '/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper',
    }
    focusHostApp(helper, spawner)
    expect(calls[0]?.args).toEqual(['/Applications/DeepSeek Harness.app'])
  })

  it('does nothing off macOS or outside an app bundle', () => {
    const { calls, spawner } = recorder()
    expect(focusHostApp({ ...mac, platform: 'linux' }, spawner)).toBe(false)
    expect(focusHostApp({ ...mac, execPath: '/usr/local/bin/node' }, spawner)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('never throws when the opener is missing', () => {
    expect(
      focusHostApp(mac, () => {
        throw new Error('nope')
      }),
    ).toBe(false)
    vi.restoreAllMocks()
  })
})
