/**
 * Open a link in the person's browser, and bring the Harness window back to the
 * front afterwards.
 *
 * Both are conveniences: when they cannot work (a remote shell, no display) the
 * caller still prints the link, so nothing depends on them succeeding.
 *
 * No shell is involved - the address is passed as a single argument - so a
 * crafted address cannot inject a command. Only http(s) addresses are opened.
 */

import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

export type Spawner = (command: string, args: string[], options: SpawnOptions) => { unref(): void; on(event: 'error', listener: () => void): unknown }

export interface Environment {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  execPath: string
}

const current = (): Environment => ({ platform: process.platform, env: process.env, execPath: process.execPath })

/** Whether there is a screen to open a browser on. A remote shell is not one. */
export function canOpenBrowser(environment: Environment = current()): boolean {
  const { platform, env } = environment
  if (env.SSH_CONNECTION || env.SSH_TTY) return false
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  return platform === 'darwin' || platform === 'win32'
}

function commandFor(platform: NodeJS.Platform, url: string): { command: string; args: string[] } | undefined {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // `start` would need cmd.exe, which re-parses `&` in the address.
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'linux') return { command: 'xdg-open', args: [url] }
  return undefined
}

function run(spawner: Spawner, command: string, args: string[]): boolean {
  try {
    const child = spawner(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Ask the system to open `url`. Returns whether a launch was attempted. */
export function openInBrowser(
  url: string,
  environment: Environment = current(),
  spawner: Spawner = spawn as unknown as Spawner,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (!canOpenBrowser(environment)) return false
  const launch = commandFor(environment.platform, parsed.href)
  return launch !== undefined && run(spawner, launch.command, launch.args)
}

/**
 * macOS only: bring the app this process belongs to back to the front, so the
 * person lands where they started once the browser has done its part.
 * The app path comes from our own executable, not from any name we guess.
 */
export function focusHostApp(
  environment: Environment = current(),
  spawner: Spawner = spawn as unknown as Spawner,
): boolean {
  if (environment.platform !== 'darwin') return false
  const marker = '.app/'
  const at = environment.execPath.indexOf(marker)
  if (at === -1) return false
  // The outermost bundle (a helper process lives inside the main one).
  const app = environment.execPath.slice(0, at + marker.length - 1)
  return run(spawner, 'open', [app])
}
