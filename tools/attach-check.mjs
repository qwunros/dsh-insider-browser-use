#!/usr/bin/env node
/**
 * End-to-end check for "drive an existing browser" (attach mode).
 *
 * It attaches to a real browser that is already running with a DevTools
 * endpoint — the browser the dsh panel is displayed in, an Electron/desktop
 * shell, or the browser this plugin itself spawned — opens one tab in it,
 * exercises navigation/snapshot/screenshot/input, and then verifies that
 * stopping only closes that tab and never the browser.
 *
 * Usage:
 *   node tools/attach-check.mjs [endpoint] [url]
 *
 * `endpoint` accepts a port (9222), an http URL (http://127.0.0.1:9222) or a
 * ws URL. Without an argument the DevTools port of the plugin's own profile is
 * read from <DSH_HOME>/insider-browser/profile/DevToolsActivePort.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserEngine, resolveAttachTarget } from '../src/host/engine.mjs'

const profileDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'insider-browser', 'profile')
const pageUrl = process.argv[3] || 'http://127.0.0.1:3080/'

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function endpointFromProfile() {
  try {
    const text = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)
    const port = Number(text[0])
    if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`
  } catch {
    /* no running instance */
  }
  return ''
}

const endpoint = process.argv[2] || endpointFromProfile()
if (!endpoint) {
  console.error('no DevTools endpoint given and none available in', join(profileDir, 'DevToolsActivePort'))
  console.error('start a browser with --remote-debugging-port=9222 and run: node tools/attach-check.mjs 9222')
  process.exit(2)
}

const target = resolveAttachTarget({ attachTo: endpoint }, {})
console.log(`attaching to ${target.url}`)

async function endpointAlive() {
  try {
    const response = await fetch(`${target.url}/json/version`, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

async function pages() {
  try {
    const response = await fetch(`${target.url}/json/list`, { signal: AbortSignal.timeout(2000) })
    const list = await response.json()
    return list.filter((entry) => entry.type === 'page').map((entry) => entry.url)
  } catch {
    return []
  }
}

const pagesBefore = await pages()
check('the carrier browser answers before attaching', await endpointAlive(), `${pagesBefore.length} page(s) open`)

const engine = new BrowserEngine({
  attachTo: endpoint,
  allowCookieWrites: false,
  viewport: { width: 1280, height: 800 },
})

try {
  await engine.ensure()
  check('engine attached instead of spawning', engine.status.carrier === 'attached' && engine.status.running === true, JSON.stringify({ carrier: engine.status.carrier, endpoint: engine.status.endpoint, channel: engine.status.channel }))
  check('attached mode reports no executable', engine.status.executable === null)

  const probeUrl = pageUrl + (pageUrl.includes('?') ? '&' : '?') + 'attach-check=1'
  const nav = await engine.navigate(probeUrl)
  check('navigation works inside the carrier', /attach-check=1/.test(nav.url), `${nav.url} | ${nav.title}`)

  const snapshot = await engine.snapshot({ maxElements: 5 })
  check('snapshot reads the page', typeof snapshot.text === 'string' && snapshot.text.length > 0, `${snapshot.elements.length} elements, ${snapshot.text.length} chars`)

  const shot = await engine.screenshot()
  check('screenshot works', Buffer.isBuffer(shot.data) && shot.data.length > 1000, `${shot.width}x${shot.height}, ${shot.data.length} bytes`)

  const input = await engine.dispatchInput([
    { t: 'm', a: 'move', x: 120, y: 120 },
    { t: 'm', a: 'down', x: 120, y: 120, button: 'left', clickCount: 1 },
    { t: 'm', a: 'up', x: 120, y: 120, button: 'left', clickCount: 1 },
  ])
  check('human input reaches the carrier', input.dispatched === 3, JSON.stringify(input))

  const diagnostics = await engine.diagnose({ maxAgeMs: 0 })
  check('diagnostics flag the attached endpoint as reachable', diagnostics.attach.reachable === true, JSON.stringify(diagnostics.attach))
  check('diagnostics list installable browsers', Array.isArray(diagnostics.candidates), `${diagnostics.candidates.length} candidate(s)`)

  let blocked = false
  try {
    await engine.clearCookies()
  } catch (error) {
    blocked = /refusing to clear cookies/.test(error.message)
  }
  check('cookie writes are refused against a borrowed browser', blocked)

  const pagesWhileAttached = await pages()
  check('the carrier shows our tab', pagesWhileAttached.some((url) => /attach-check=1/.test(url)), `${pagesWhileAttached.length} page(s)`)

  await engine.stop()
  await sleep(500)
  check('stop does not close the carrier', await endpointAlive())
  check('stop closes only our tab', !(await pages()).some((url) => /attach-check=1/.test(url)))
  check('status is clear after stop', engine.status.carrier === 'none' && engine.status.running === false)
} catch (error) {
  check('attach run completed', false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
} finally {
  try {
    await engine.stop()
  } catch {
    /* already stopped */
  }
}

console.log(failures === 0 ? '\nattach check passed' : `\n${failures} attach check(s) failed`)
process.exit(failures === 0 ? 0 : 1)