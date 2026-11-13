#!/usr/bin/env node
/**
 * Self-test for src/host/cookies.mjs — no dependencies, no cookie values printed.
 *
 * Usage:
 *   node tools/cookies-check.mjs                # all available browsers
 *   node tools/cookies-check.mjs --skip-launch  # skip real Chrome/Edge launches
 *   node tools/cookies-check.mjs --browser firefox
 *   node tools/cookies-check.mjs --cdp-roundtrip
 *   node tools/cookies-check.mjs --cdp-roundtrip --cdp-args "--single-process --no-zygote"
 *
 * The optional `--cdp-roundtrip` check never touches user browser data: it
 * creates a throwaway Chrome profile, writes one synthetic cookie over CDP,
 * copies the profile, launches Chrome again and proves the copied profile's
 * cookie decrypts — i.e. the mechanism `importCookies()` uses for Chrome/Edge.
 * A fake engine is used, so the DSH built-in browser never starts. Real
 * Chrome/Edge imports launch a short-lived copy of the source browser and need
 * `--no-sandbox` under the sandboxed test shell (only this script passes it; the
 * module's production default does not).
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  importCookies,
  clearCookies,
  detectExternalBrowsers,
} from '../src/host/cookies.mjs'

const argv = process.argv.slice(2)
const skipLaunch = argv.includes('--skip-launch')
const roundtripRequested = argv.includes('--cdp-roundtrip')
const onlyIndex = argv.indexOf('--browser')
const onlyBrowser = onlyIndex >= 0 ? String(argv[onlyIndex + 1] || '').toLowerCase() : ''
const cdpArgsIndex = argv.indexOf('--cdp-args')
const roundtripExtraArgs = cdpArgsIndex >= 0
  ? String(argv[cdpArgsIndex + 1] || '').split(/\s+/).filter((arg) => arg.startsWith('-'))
  : []

const failures = []
const skips = []

function record(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function skip(name, reason) {
  console.log(`SKIP  ${name}${reason ? ` — ${reason}` : ''}`)
  skips.push(name)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function findBrowserExecutable(browser) {
  const overrides = browser === 'chrome'
    ? [process.env.INSIDER_CHROME_PATH, process.env.CHROME_PATH]
    : [process.env.INSIDER_EDGE_PATH, process.env.EDGE_PATH]
  for (const override of overrides) {
    if (override && existsSync(override)) return override
  }
  const relativeParts = browser === 'chrome'
    ? ['Google', 'Chrome', 'Application', 'chrome.exe']
    : ['Microsoft', 'Edge', 'Application', 'msedge.exe']
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, ...relativeParts)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Minimal CDP client for the synthetic roundtrip only (the module has its own).
 * Uses the global WebSocket and a fully detached stdio setup so it also works in
 * a sandboxed shell that forbids piped child stdio.
 */
async function launchTestBrowser(executable, userDataDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    ...roundtripExtraArgs,
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })

  const portFile = join(userDataDir, 'DevToolsActivePort')
  let port = 0
  let wsPath = ''
  const portUntil = Date.now() + 20000
  while (Date.now() < portUntil && port === 0) {
    if (child.exitCode !== null) {
      throw new Error(`browser exited during startup (code ${child.exitCode})`)
    }
    try {
      const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
      port = Number(lines[0])
      wsPath = lines[1] || ''
      if (!Number.isInteger(port) || port <= 0) port = 0
    } catch {
      // not written yet
    }
    if (port === 0) await sleep(50)
  }
  if (!port) {
    try { child.kill() } catch {}
    throw new Error('browser DevTools port did not appear')
  }

  let wsUrl = wsPath
    ? `ws://127.0.0.1:${port}${wsPath.startsWith('/') ? wsPath : `/${wsPath}`}`
    : ''
  if (!wsUrl) {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    const version = await response.json()
    wsUrl = version.webSocketDebuggerUrl
  }

  let ws = null
  const wsUntil = Date.now() + 10000
  while (!ws && Date.now() < wsUntil) {
    const attempt = new WebSocket(wsUrl)
    attempt.binaryType = 'arraybuffer'
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          attempt.addEventListener('open', resolve, { once: true })
          attempt.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true })
        }),
        sleep(2500).then(() => { throw new Error('WebSocket open timed out') }),
      ])
      ws = attempt
    } catch {
      try { attempt.close() } catch {}
      await sleep(300)
    }
  }
  if (!ws) {
    try { child.kill() } catch {}
    throw new Error('could not connect to the browser DevTools WebSocket')
  }

  const pending = new Map()
  let nextId = 1
  ws.addEventListener('message', async (event) => {
    let text
    if (typeof event.data === 'string') text = event.data
    else if (event.data instanceof ArrayBuffer) text = Buffer.from(event.data).toString('utf8')
    else if (event.data && typeof event.data.text === 'function') text = await event.data.text()
    else return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || message.id == null) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })

  const send = (method, params = {}, sessionId, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, Math.max(1, timeoutMs))
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject: (err) => { clearTimeout(timer); reject(err) },
    })
    try {
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    }
  })

  const close = async () => {
    try { await send('Browser.close', {}, undefined, 1500) } catch {}
    try { ws.close() } catch {}
    await sleep(800)
    try { child.kill() } catch {}
    await sleep(300)
  }

  return { send, close }
}

/**
 * End-to-end check of the Chrome/Edge mechanism without touching user data:
 * write a synthetic cookie into a throwaway profile, copy the profile, launch
 * again, and read the cookie back decrypted over CDP.
 */
async function runSyntheticCdpRoundtrip() {
  console.log('\n== synthetic Chrome profile copy/decrypt roundtrip ==')
  const browser = onlyBrowser === 'edge' ? 'edge' : 'chrome'
  const executable = findBrowserExecutable(browser)
  if (!executable) {
    skip('synthetic CDP roundtrip', `${browser} executable not found`)
    return
  }
  const dirA = await makeTempDir('dsh-cookies-rt-a-')
  const dirB = await makeTempDir('dsh-cookies-rt-b-')
  let first = null
  let second = null
  try {
    first = await launchTestBrowser(executable, dirA)
    const targetA = await first.send('Target.createTarget', { url: 'about:blank' })
    const attachedA = await first.send('Target.attachToTarget', { targetId: targetA.targetId, flatten: true })
    const expires = Math.floor(Date.now() / 1000) + 3600
    const setResult = await first.send('Network.setCookie', {
      name: 'dsh_self_test_cookie',
      value: 'dsh-self-test-value-123',
      domain: 'example.com',
      path: '/',
      secure: false,
      httpOnly: false,
      expires,
      sameSite: 'Lax',
    }, attachedA.sessionId)
    if (setResult && setResult.success === false) throw new Error('Network.setCookie was rejected')
    const cookiesA = await first.send('Network.getAllCookies', {}, attachedA.sessionId, 12000)
    const probeA = (cookiesA.cookies || []).find((cookie) => cookie.name === 'dsh_self_test_cookie')
    if (!probeA) throw new Error('the synthetic cookie was not visible before copying the profile')
    await first.close()
    first = null

    await copyFile(join(dirA, 'Local State'), join(dirB, 'Local State'))
    const sourceNetwork = join(dirA, 'Default', 'Network')
    const targetNetwork = join(dirB, 'Default', 'Network')
    await mkdir(targetNetwork, { recursive: true })
    for (const fileName of ['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm']) {
      const source = join(sourceNetwork, fileName)
      if (existsSync(source)) await copyFile(source, join(targetNetwork, fileName))
    }

    second = await launchTestBrowser(executable, dirB)
    const targetB = await second.send('Target.createTarget', { url: 'about:blank' })
    const attachedB = await second.send('Target.attachToTarget', { targetId: targetB.targetId, flatten: true })
    const cookiesB = await second.send('Network.getAllCookies', {}, attachedB.sessionId, 15000)
    const allB = cookiesB.cookies || []
    const probeB = allB.find((cookie) => cookie.name === 'dsh_self_test_cookie')
    record(
      'synthetic CDP roundtrip: copied profile decrypts the cookie',
      Boolean(probeB) && probeB.value === 'dsh-self-test-value-123',
      `cookies=${allB.length} probePresent=${Boolean(probeB)} valueMatch=${Boolean(probeB && probeB.value === 'dsh-self-test-value-123')}`,
    )
  } catch (err) {
    record(
      'synthetic CDP roundtrip',
      false,
      `${err && err.message ? err.message : String(err)}` +
      (roundtripExtraArgs.length === 0
        ? ' (in a sandboxed shell retry with --cdp-args "--single-process --no-zygote")'
        : ''),
    )
  } finally {
    try { if (first) await first.close() } catch {}
    try { if (second) await second.close() } catch {}
  }
}

function createFakeEngine() {
  const state = { setCalls: 0, cookies: [], cleared: 0 }
  return {
    state,
    async setCookies(cookies) {
      if (!Array.isArray(cookies)) throw new Error('setCookies expected an array')
      state.setCalls += 1
      state.cookies = cookies
      return { set: cookies.length, failed: 0, errors: [] }
    },
    async clearCookies() {
      state.cleared += 1
      return { cleared: true }
    },
  }
}

const ALLOWED_COOKIE_KEYS = new Set([
  'name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expires', 'sameSite',
])
const FORBIDDEN_COOKIE_KEYS = new Set([
  'partitionKey', 'sourcePort', 'sourceScheme', 'size', 'session', 'priority',
  'sameParty', 'sourceScheme',
])

/** Validate the mapped CDP shape without printing any cookie content. */
function validateMappedCookies(cookies) {
  let badKeys = 0
  let forbiddenKeys = 0
  let badExpires = 0
  let badSameSite = 0
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== 'object') {
      badKeys += 1
      continue
    }
    for (const key of Object.keys(cookie)) {
      if (FORBIDDEN_COOKIE_KEYS.has(key)) forbiddenKeys += 1
      else if (!ALLOWED_COOKIE_KEYS.has(key)) badKeys += 1
    }
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) badKeys += 1
    if (typeof cookie.domain !== 'string' || cookie.domain.length === 0) badKeys += 1
    if (typeof cookie.path !== 'string') badKeys += 1
    if (typeof cookie.value !== 'string') badKeys += 1
    if (!Number.isFinite(cookie.expires)) badExpires += 1
    if (cookie.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
      badSameSite += 1
    }
  }
  return {
    mapped: cookies.length,
    badKeys,
    forbiddenKeys,
    badExpires,
    badSameSite,
  }
}

/**
 * Cheap leak check: the public result must never contain a cookie value. Only
 * long values are compared to keep false positives away.
 */
function countResultValueLeaks(result, cookies) {
  let leaks = 0
  let serialized = ''
  try {
    serialized = JSON.stringify(result)
  } catch {
    return 1
  }
  for (const cookie of cookies) {
    const value = cookie && cookie.value
    if (typeof value === 'string' && value.length >= 8 && serialized.includes(value)) leaks += 1
  }
  return leaks
}

function summaryLine(label, result, validation) {
  return [
    `${label}: profile=${result.profile === null ? 'null' : `"${result.profile}"`}`,
    `read=${result.cookies}`,
    `imported=${result.imported}`,
    `failed=${result.failed}`,
    `warnings=${result.warnings.length}`,
    `errors=${result.errors.length}`,
    `mapped=${validation.mapped}`,
    `forbiddenKeys=${validation.forbiddenKeys}`,
    `badKeys=${validation.badKeys}`,
  ].join(' ')
}

function printWarnings(label, result) {
  for (const warning of result.warnings.slice(0, 8)) console.log(`  ${label} warn: ${warning}`)
  for (const error of result.errors.slice(0, 8)) console.log(`  ${label} error: ${error}`)
}

const temporaryDirectories = []
async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

async function main() {
  console.log('== detectExternalBrowsers() ==')
  const detected = await detectExternalBrowsers()
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const info = detected[browser] || {}
    console.log(
      `${browser}: available=${Boolean(info.available)} executable=${info.executable ? 'yes' : 'no'} ` +
      `profile=${info.profile ? `"${info.profile}"` : 'null'} cookieDatabase=${Boolean(info.cookieDatabase)}` +
      `${info.error ? ` error="${info.error}"` : ''}`,
    )
  }
  record(
    'detectExternalBrowsers returns chrome/edge/firefox',
    Object.keys(detected).sort().join(',') === 'chrome,edge,firefox',
    Object.keys(detected).join(','),
  )
  record(
    'detection does not expose cookie values',
    !JSON.stringify(detected).includes('"value"'),
  )

  console.log('\n== graceful no-source paths ==')

  const noDataChrome = await importCookies(createFakeEngine(), {
    browser: 'chrome',
    userDataDir: join(tmpdir(), 'dsh-cookies-no-such-chrome-profile'),
  })
  printWarnings('no-data chrome', noDataChrome)
  record(
    'chrome with missing user data dir returns warnings instead of throwing',
    noDataChrome.imported === 0 && noDataChrome.warnings.length > 0,
    `warnings=${noDataChrome.warnings.length}`,
  )

  const emptyDir = await makeTempDir('dsh-cookies-check-empty-')
  const noDataFirefox = await importCookies(createFakeEngine(), {
    browser: 'firefox',
    profilesIni: join(emptyDir, 'profiles.ini'),
  })
  printWarnings('no-data firefox', noDataFirefox)
  record(
    'firefox without profiles.ini returns warnings instead of throwing',
    noDataFirefox.imported === 0 && noDataFirefox.warnings.length > 0,
    `warnings=${noDataFirefox.warnings.length}`,
  )

  const invalidBrowser = await importCookies(createFakeEngine(), { browser: 'safari' })
  printWarnings('invalid browser', invalidBrowser)
  record(
    'unsupported browser name returns a clear warning',
    invalidBrowser.imported === 0 && invalidBrowser.warnings.length > 0 && invalidBrowser.browser === null,
    `browser=${String(invalidBrowser.browser)} warnings=${invalidBrowser.warnings.length}`,
  )

  const emptyProfilesIni = join(emptyDir, 'profiles2.ini')
  await writeFile(emptyProfilesIni, '[General]\nStartWithLastProfile=1\n')
  const noProfiles = await importCookies(null, {
    browser: 'firefox',
    profilesIni: emptyProfilesIni,
  })
  printWarnings('firefox empty profiles.ini', noProfiles)
  record(
    'empty profiles.ini + null engine does not throw',
    noProfiles.imported === 0 && noProfiles.warnings.length > 0,
  )

  console.log('\n== clearCookies ==')
  const clearEngine = createFakeEngine()
  const cleared = await clearCookies(clearEngine)
  record(
    'clearCookies delegates to engine.clearCookies()',
    cleared.cleared === true && clearEngine.state.cleared === 1,
    JSON.stringify(cleared),
  )
  let threw = false
  try {
    await clearCookies(null)
  } catch {
    threw = true
  }
  record('clearCookies without engine throws a clear error', threw)

  console.log('\n== real browser imports (counts only) ==')
  const browsers = onlyBrowser ? [onlyBrowser] : ['chrome', 'edge', 'firefox']
  for (const browser of browsers) {
    if (browser !== 'firefox' && skipLaunch) {
      skip(`${browser} import`, '--skip-launch')
      continue
    }
    const info = detected[browser]
    if (!info || !info.available) {
      skip(`${browser} import`, (info && info.error) || 'browser data not available')
      continue
    }
    const engine = createFakeEngine()
    const started = Date.now()
    let result
    try {
      result = await importCookies(engine, {
        browser,
        // Only the test script adds --no-sandbox (required in this sandboxed shell);
        // the production module does not pass it.
        extraArgs: browser === 'firefox' ? [] : ['--no-sandbox'],
        // Keep a failed source attempt bounded; the production default is 25s.
        timeoutMs: browser === 'firefox' ? 25000 : 15000,
        log: (level, message) => console.log(`  [log:${level}] ${message}`),
      })
    } catch (err) {
      record(`${browser} import did not throw`, false, err && err.message ? err.message : String(err))
      continue
    }
    const elapsedMs = Date.now() - started
    const validation = validateMappedCookies(engine.state.cookies)
    const leaks = countResultValueLeaks(result, engine.state.cookies)
    const duration = `${(elapsedMs / 1000).toFixed(1)}s`
    console.log(summaryLine(`REAL ${browser}`, result, validation) + ` leaks=${leaks} ms=${elapsedMs}`)
    printWarnings(`REAL ${browser}`, result)

    record(
      `${browser} import shape is JSON-safe`,
      typeof result.browser === 'string' &&
        typeof result.cookies === 'number' &&
        typeof result.imported === 'number' &&
        typeof result.failed === 'number' &&
        Array.isArray(result.warnings) &&
        Array.isArray(result.errors) &&
        leaks === 0,
      `leaks=${leaks} duration=${duration}`,
    )
    record(
      `${browser} mapped cookies use only writable CDP fields`,
      validation.forbiddenKeys === 0 && validation.badKeys === 0 && validation.badExpires === 0 && validation.badSameSite === 0,
      `forbidden=${validation.forbiddenKeys} badKeys=${validation.badKeys} badExpires=${validation.badExpires} badSameSite=${validation.badSameSite}`,
    )

    if (result.cookies > 0) {
      record(
        `${browser} imported every read cookie through the engine`,
        result.imported > 0 && engine.state.setCalls === 1,
        `read=${result.cookies} imported=${result.imported} setCalls=${engine.state.setCalls}`,
      )
    } else {
      record(
        `${browser} zero cookies comes with an explanatory warning`,
        result.warnings.length > 0,
        `warnings=${result.warnings.length}`,
      )
    }
    record(
      `${browser} public result hides cookie values`,
      leaks === 0,
      'counts and warnings only',
    )
  }

  if (roundtripRequested) {
    await runSyntheticCdpRoundtrip()
  }

  console.log('\n== summary ==')
  console.log(`failures=${failures.length} skips=${skips.length}`)
  console.log(
    'note: if Chrome/Edge read 0 cookies while this shell is sandboxed, Chromium child ' +
    'processes (network service / renderers) may be blocked by the sandbox; rerun this ' +
    'script from a plain terminal or let the unsandboxed DSH Host validate the import. ' +
    'Use --cdp-roundtrip to verify the copy/decrypt mechanism without user data.',
  )
  if (failures.length > 0) {
    console.log(`failed checks: ${failures.join(' | ')}`)
  }
  return failures.length === 0 ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error('self-test crashed:', err && err.stack ? err.stack : err)
  exitCode = 1
} finally {
  for (const dir of temporaryDirectories) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
process.exit(exitCode)
