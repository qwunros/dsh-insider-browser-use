/**
 * Cookie import / clear for the built-in browser (Host half).
 *
 * Pure ESM, `node:` builtins only. This module never imports `@deepseek-ai/*`
 * and never logs, returns or throws cookie *values* — only counts and source
 * descriptions are exposed.
 *
 * Import strategies
 * -----------------
 * Firefox: copy `cookies.sqlite` (+ `-wal`/`-shm`) from the selected profile to a
 * temp directory and read it read-only with `node:sqlite`.
 *
 * Chrome / Edge (Windows): copy `Local State` plus the profile cookie database
 * into a throwaway user-data-dir and start *the same browser executable* headless
 * with `--remote-debugging-port=0`. The browser itself decrypts the cookies
 * (DPAPI / app-bound v20), so this module never touches the encryption key. A
 * minimal CDP client (`Network.getAllCookies`, falling back to
 * `Storage.getCookies`) reads the plaintext list, then the temp browser is closed
 * and the temp directory removed (EBUSY is ignored).
 *
 * Public API
 * ----------
 *   importCookies(engine, { browser, log, timeoutMs?, extraArgs?, ...overrides })
 *   clearCookies(engine)
 *   detectExternalBrowsers()
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

const SUPPORTED_BROWSERS = ['chrome', 'edge', 'firefox']
const DEFAULT_TIMEOUT_MS = 25000
const STARTUP_TIMEOUT_MS = 15000
const MAX_TIMEOUT_MS = 120000

const CHROME_BASE_ARGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--disable-gpu',
  '--mute-audio',
  '--hide-scrollbars',
]

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text, max) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, max)}...`
}

function errMessage(err) {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return truncate(err, 600)
  if (typeof err.message === 'string' && err.message) return truncate(err.message, 600)
  return truncate(String(err), 600)
}

function errorCode(err) {
  return (err && (err.code || err.name)) || 'unknown error'
}

/** Redact any imported cookie value that somehow leaked into an error string. */
function sanitize(text, cookies) {
  let out = truncate(String(text ?? ''), 600)
  if (Array.isArray(cookies)) {
    for (const cookie of cookies) {
      const value = cookie && cookie.value
      if (typeof value === 'string' && value.length >= 3 && out.includes(value)) {
        out = out.split(value).join('[redacted]')
      }
    }
  }
  return out
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function isFileSync(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectorySync(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function normalizeExtraArgs(value) {
  if (!Array.isArray(value)) return []
  return value.filter((arg) => typeof arg === 'string' && arg.startsWith('-')).slice(0, 32)
}

function normalizeTimeout(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(number), 1000), MAX_TIMEOUT_MS)
}

/** Logger adapter: accepts ctx.logger style objects or a plain function. */
function emitLog(log, level, message) {
  if (!log) return
  try {
    if (typeof log === 'function') {
      // Two-argument loggers get the level; simple one-argument loggers get text.
      if (log.length >= 2) log(level, message)
      else log(message)
      return
    }
    const method = log[level] || log.log
    if (typeof method === 'function') method.call(log, message)
  } catch {
    // logging must never break the import
  }
}

function logInfo(log, message) {
  emitLog(log, 'info', message)
}

function logWarn(log, message) {
  emitLog(log, 'warn', message)
}

class Deadline {
  constructor(ms) {
    this.timeoutMs = ms
    this.end = Date.now() + ms
  }

  get remaining() {
    return this.end - Date.now()
  }

  get expired() {
    return this.remaining <= 0
  }

  check(what) {
    if (this.expired) {
      throw new Error(`${what} timed out after ${this.timeoutMs}ms`)
    }
  }
}

// ---------------------------------------------------------------------------
// browser / profile discovery
// ---------------------------------------------------------------------------

function browserLabel(browser) {
  if (browser === 'chrome') return 'Chrome'
  if (browser === 'edge') return 'Edge'
  return 'Firefox'
}

function findChromeUserDataDir(browser) {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return null
  const candidates = browser === 'chrome'
    ? [join(localAppData, 'Google', 'Chrome', 'User Data')]
    : [join(localAppData, 'Microsoft', 'Edge', 'User Data')]
  for (const candidate of candidates) {
    if (isDirectorySync(candidate)) return candidate
  }
  return null
}

function findChromeExecutable(browser) {
  const override = browser === 'chrome'
    ? process.env.INSIDER_CHROME_PATH || process.env.CHROME_PATH
    : process.env.INSIDER_EDGE_PATH || process.env.EDGE_PATH
  if (override && isFileSync(override)) return override
  const programFiles = process.env.ProgramFiles
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const localAppData = process.env.LOCALAPPDATA
  const relativeParts = browser === 'chrome'
    ? ['Google', 'Chrome', 'Application', 'chrome.exe']
    : ['Microsoft', 'Edge', 'Application', 'msedge.exe']
  const candidates = []
  if (programFiles) candidates.push(join(programFiles, ...relativeParts))
  if (programFilesX86) candidates.push(join(programFilesX86, ...relativeParts))
  if (localAppData) candidates.push(join(localAppData, ...relativeParts))
  for (const candidate of candidates) {
    if (isFileSync(candidate)) return candidate
  }
  return null
}

/** Order profile directory names, most relevant first. */
function listChromeProfileNames(userDataDir, localState, profileOverride) {
  const profile = (localState && localState.profile) || {}
  const infoCache = profile.info_cache || {}
  const ordered = []
  const seen = new Set()
  const push = (name) => {
    if (typeof name === 'string' && name && !seen.has(name)) {
      seen.add(name)
      ordered.push(name)
    }
  }
  if (typeof profileOverride === 'string' && profileOverride) push(profileOverride)
  push(profile.last_used)
  const lastActive = profile.last_active_profiles
  if (Array.isArray(lastActive)) {
    for (let index = lastActive.length - 1; index >= 0; index -= 1) push(lastActive[index])
  }
  const profileOrder = profile.profiles_order
  if (Array.isArray(profileOrder)) {
    for (let index = profileOrder.length - 1; index >= 0; index -= 1) push(profileOrder[index])
  }
  for (const name of Object.keys(infoCache)) push(name)
  push('Default')
  const existing = ordered.filter((name) => isDirectorySync(join(userDataDir, name)))
  return existing.length > 0 ? existing : ordered
}

/** Locate the SQLite cookie database of a Chrome/Edge profile. */
function findChromeCookieDatabase(userDataDir, profileNames) {
  for (const profileName of profileNames) {
    const profileDir = join(userDataDir, profileName)
    const candidates = [
      join(profileDir, 'Network', 'Cookies'),
      join(profileDir, 'Cookies'),
    ]
    for (const candidate of candidates) {
      if (isFileSync(candidate)) return { profileName, dbPath: candidate }
    }
  }
  return null
}

/** Parse a Firefox profiles.ini style file into sections. */
function parseIni(text) {
  const sections = []
  let current = null
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = line.match(/^\[(.+)]$/)
    if (header) {
      current = { name: header[1], values: {} }
      sections.push(current)
      continue
    }
    if (!current) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    current.values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return sections
}

/**
 * Ordered Firefox profile candidates: explicit `Default=1` first, then install
 * defaults, then the remaining profiles last-declared first (the design asks for
 * "last profile" when no explicit default exists).
 */
async function firefoxProfileCandidates(profilesIni, firefoxRoot, profileOverride) {
  let sections = []
  try {
    sections = parseIni(await readFile(profilesIni, 'utf8'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw new Error(`cannot read Firefox profiles.ini (${errorCode(err)})`)
    }
  }

  const entries = []
  const seenDirs = new Set()
  const add = (entry) => {
    if (!entry) return
    const key = entry.dir.toLowerCase()
    if (seenDirs.has(key)) return
    seenDirs.add(key)
    entries.push(entry)
  }

  for (const section of sections) {
    if (!/^Profile\d+$/i.test(section.name) && section.name.toLowerCase() !== 'profile') continue
    const rawPath = section.values.Path
    if (!rawPath) continue
    const isRelative = String(section.values.IsRelative ?? '1') !== '0'
    const dir = isRelative ? join(firefoxRoot, rawPath) : rawPath
    add({
      name: section.values.Name || basename(dir),
      dir,
      preferred: String(section.values.Default ?? '') === '1',
      fromInstall: false,
    })
  }

  for (const section of sections) {
    if (!/^Install/i.test(section.name)) continue
    const rawPath = section.values.Default
    if (!rawPath) continue
    const dir = join(firefoxRoot, rawPath)
    // A resolved install default should win next to an explicit Default=1.
    add({ name: basename(dir), dir, preferred: false, fromInstall: true })
  }

  // Fallback: profiles.ini missing/empty but a Profiles directory exists.
  if (entries.length === 0) {
    try {
      const entriesOnDisk = await readdir(join(firefoxRoot, 'Profiles'), { withFileTypes: true })
      for (const entry of entriesOnDisk) {
        if (!entry.isDirectory()) continue
        add({
          name: entry.name,
          dir: join(firefoxRoot, 'Profiles', entry.name),
          preferred: false,
          fromInstall: false,
        })
      }
    } catch {
      // ignore: no Profiles directory either
    }
  }

  if (profileOverride) {
    const forced = entries.find((entry) => entry.name === profileOverride || basename(entry.dir) === profileOverride)
    const candidate = forced || {
      name: profileOverride,
      dir: join(firefoxRoot, profileOverride),
      preferred: false,
      fromInstall: false,
    }
    add(candidate)
  }

  const preferred = entries.filter((entry) => entry.preferred)
  const rest = entries.filter((entry) => !entry.preferred).reverse()
  const ordered = [...preferred, ...rest]
  if (profileOverride) {
    // A caller-specified profile always goes first.
    const forced = ordered.find((entry) => entry.name === profileOverride || basename(entry.dir) === profileOverride)
    if (forced) {
      const remaining = ordered.filter((entry) => entry !== forced)
      return [forced, ...remaining]
    }
  }
  return ordered
}

async function findFirefoxCookieProfile(profilesIni, firefoxRoot, profileOverride) {
  const candidates = await firefoxProfileCandidates(profilesIni, firefoxRoot, profileOverride)
  for (const candidate of candidates) {
    const dbPath = join(candidate.dir, 'cookies.sqlite')
    if (await isFile(dbPath)) return { candidate, candidates, dbPath }
  }
  return { candidate: null, candidates, dbPath: null }
}

// ---------------------------------------------------------------------------
// Chrome / Edge / Firefox -> CDP cookie mapping
// ---------------------------------------------------------------------------

function normalizeExpires(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return -1
  return Math.floor(number)
}

function normalizeSameSite(value) {
  if (value === 'Strict' || value === 'Lax' || value === 'None') return value
  return undefined
}

/** Map one `Network.getAllCookies` entry to the writable `Network.setCookie` shape. */
function mapChromeCookie(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  if (typeof raw.domain !== 'string' || raw.domain.length === 0) return null
  const path = typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path : '/'
  const cookie = {
    name: raw.name,
    // Empty values are valid and must be preserved.
    value: typeof raw.value === 'string' ? raw.value : '',
    domain: raw.domain,
    path,
    secure: Boolean(raw.secure),
    httpOnly: Boolean(raw.httpOnly),
    expires: normalizeExpires(raw.expires),
  }
  const sameSite = normalizeSameSite(raw.sameSite)
  if (sameSite) cookie.sameSite = sameSite
  return cookie
}

const FIREFOX_SAME_SITE = { 0: 'None', 1: 'Lax', 2: 'Strict' }

/**
 * Map one `moz_cookies` row to a CDP cookie.
 * Returns `{ cookie, degraded }` or null when the row is unusable.
 */
function mapFirefoxCookie(row) {
  if (!row || typeof row !== 'object') return null
  const host = typeof row.host === 'string' ? row.host : ''
  const name = typeof row.name === 'string' ? row.name : ''
  if (!host || !name) return null
  const secure = Number(row.isSecure) === 1 || row.isSecure === true
  const httpOnly = Number(row.isHttpOnly) === 1 || row.isHttpOnly === true
  const value = typeof row.value === 'string' ? row.value : ''
  const cookie = {
    name,
    value,
    domain: host,
    path: typeof row.path === 'string' && row.path.startsWith('/') ? row.path : '/',
    secure,
    httpOnly,
    expires: normalizeExpires(row.expiry),
  }
  const sameSiteNumber = Number(row.sameSite)
  let sameSite = FIREFOX_SAME_SITE[sameSiteNumber]
  let degraded = false
  if (sameSite === 'None' && !secure) {
    // SameSite=None requires Secure; Chrome would reject the cookie outright.
    sameSite = 'Lax'
    degraded = true
  }
  if (sameSite) cookie.sameSite = sameSite
  return { cookie, degraded }
}

// ---------------------------------------------------------------------------
// minimal CDP client (global WebSocket, no dependencies)
// ---------------------------------------------------------------------------

class MiniCdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
  }

  async connect(timeoutMs) {
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    try {
      ws.binaryType = 'arraybuffer'
    } catch {
      // harmless on runtimes without binaryType
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error(`CDP WebSocket open timed out after ${Math.round(timeoutMs)}ms`))
      }, Math.max(1, timeoutMs))
      const cleanup = () => {
        clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('CDP WebSocket connection failed'))
      }
      const onClose = () => {
        cleanup()
        reject(new Error('CDP WebSocket closed before it opened'))
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)
    })

    ws.addEventListener('message', (event) => {
      void this.handleMessage(event.data)
    })
    ws.addEventListener('close', () => {
      this.closed = true
      this.rejectAll(new Error('CDP connection closed'))
    })
    ws.addEventListener('error', () => {
      // Swallowed: the close handler (or per-command timeout) reports failures.
    })
  }

  handleMessage(data) {
    const parse = (text) => {
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      if (!message || message.id == null) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${truncate(message.error.message || 'unknown error', 300)}`))
      } else {
        pending.resolve(message.result)
      }
    }

    if (typeof data === 'string') {
      parse(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      parse(Buffer.from(data).toString('utf8'))
      return
    }
    if (ArrayBuffer.isView(data)) {
      parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'))
      return
    }
    if (data && typeof data.text === 'function') {
      data.text().then(parse).catch(() => {})
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 5000) {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error('CDP client is not connected'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${Math.round(timeoutMs)}ms`))
      }, Math.max(1, timeoutMs))
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      const payload = { id, method, params: params || {} }
      if (sessionId) payload.sessionId = sessionId
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP ${method} send failed: ${errMessage(err)}`))
      }
    })
  }

  rejectAll(err) {
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
  }

  close() {
    this.closed = true
    this.rejectAll(new Error('CDP client closed'))
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
  }
}

// ---------------------------------------------------------------------------
// temporary browser process helpers
// ---------------------------------------------------------------------------

function spawnTempBrowser(executable, args) {
  const state = {
    child: null,
    stderr: '',
    stderrCapture: false,
    spawnError: null,
    exited: false,
    exitInfo: null,
  }
  const launch = (stdio) => spawn(executable, args, { stdio, windowsHide: true })
  let child = null
  try {
    // Capture stderr when possible: it makes "the browser did not start" warnings
    // much more useful. Some restricted sandboxes cannot create the pipes that
    // child_process needs for captured stdio and throw EPERM synchronously, so
    // fall back to a fully detached stdio setup instead of failing the import.
    child = launch(['ignore', 'ignore', 'pipe'])
    state.stderrCapture = true
  } catch (err) {
    const code = err && err.code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw err
    child = launch('ignore')
    state.stderrCapture = false
  }
  state.child = child
  if (state.stderrCapture) {
    child.stderr?.on('data', (chunk) => {
      if (state.stderr.length < 8192) state.stderr += chunk.toString('utf8')
    })
  }
  child.on('error', (err) => {
    state.spawnError = err
  })
  child.on('exit', (code, signal) => {
    state.exited = true
    state.exitInfo = { code, signal }
  })
  return state
}

function stderrSummary(state) {
  if (!state || !state.stderr) return ''
  const text = state.stderr.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return ` (browser stderr: ${truncate(text.slice(-300), 300)})`
}

function waitForExit(state, ms) {
  if (!state || state.exited) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timer = null
    const onExit = () => {
      if (timer) clearTimeout(timer)
      resolve(true)
    }
    state.child.once('exit', onExit)
    timer = setTimeout(() => {
      state.child.removeListener('exit', onExit)
      resolve(state.exited)
    }, Math.max(1, ms))
  })
}

function killProcessTree(child) {
  const pid = child?.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => {})
    } catch {
      // ignore
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
}

async function removeTempDir(tempDir) {
  if (!tempDir) return
  try {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
  } catch {
    // Windows may keep the copied profile busy for a moment; that is tolerable.
  }
}

async function shutdownTempBrowser(state, cdp, deadline) {
  if (cdp) {
    try {
      if (!cdp.closed) await cdp.send('Browser.close', {}, undefined, 1500)
    } catch {
      // browser may already be gone
    }
    try {
      cdp.close()
    } catch {
      // ignore
    }
  }
  if (!state) return
  const grace = Number.isFinite(deadline?.remaining)
    ? Math.max(800, Math.min(2500, deadline.remaining))
    : 2500
  if (!state.exited) await waitForExit(state, grace)
  if (!state.exited) {
    try {
      state.child.kill()
    } catch {
      // ignore
    }
    await waitForExit(state, 1000)
  }
  if (!state.exited) killProcessTree(state.child)
  if (!state.exited) await waitForExit(state, 1500)
}

async function copyFileWithRetry(source, destination, attempts = 4) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
      return
    } catch (err) {
      lastError = err
      if (attempt < attempts - 1) await sleep(100 * (attempt + 1))
    }
  }
  throw lastError
}

async function copyRequired(source, destination, label) {
  try {
    await copyFileWithRetry(source, destination)
  } catch (err) {
    throw new Error(
      `cannot copy ${label} (${errorCode(err)}); ` +
      'if the source browser is running, quit it and try again',
    )
  }
}

// ---------------------------------------------------------------------------
// Chrome / Edge import
// ---------------------------------------------------------------------------

async function waitForDevToolsPort(state, tempDir, deadline) {
  const portFile = join(tempDir, 'DevToolsActivePort')
  const budget = Math.max(2000, Math.min(STARTUP_TIMEOUT_MS, deadline.remaining - 2000))
  const until = Date.now() + budget
  while (Date.now() < until) {
    if (state.spawnError) {
      throw new Error(`could not start the browser (${errorCode(state.spawnError)})`)
    }
    if (state.exited) {
      const info = state.exitInfo || {}
      throw new Error(
        `the browser exited during startup (code ${info.code ?? 'unknown'}, signal ${info.signal ?? 'none'})` +
        stderrSummary(state),
      )
    }
    try {
      const text = await readFile(portFile, 'utf8')
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const port = Number(lines[0])
      if (Number.isInteger(port) && port > 0) {
        return { port, wsPath: lines[1] || '' }
      }
    } catch {
      // not written yet
    }
    await sleep(50)
  }
  throw new Error(`the browser DevTools port did not appear within ${Math.round(budget / 1000)}s${stderrSummary(state)}`)
}

async function fetchBrowserWsUrl(port, deadline) {
  const timeout = Math.max(500, Math.min(3000, deadline.remaining))
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`DevTools /json/version returned HTTP ${response.status}`)
  const info = await response.json()
  if (!info || typeof info.webSocketDebuggerUrl !== 'string' || !info.webSocketDebuggerUrl) {
    throw new Error('DevTools /json/version did not return a WebSocket URL')
  }
  return info.webSocketDebuggerUrl
}

async function readCookiesOverCdp(cdp, deadline) {
  const remaining = () => Math.max(1000, deadline.remaining)
  const failures = []
  let firstError = null

  try {
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, remaining())
    const attached = await cdp.send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      undefined,
      remaining(),
    )
    const sessionId = attached && attached.sessionId
    if (!sessionId) throw new Error('Target.attachToTarget returned no session id')
    // Network.enable is best effort: Network.getAllCookies is answered by the
    // browser process and does not strictly require an enabled Network domain.
    // A restricted environment may never answer the per-target enable call, and
    // that must not lose the cookies we can still read.
    try {
      await cdp.send('Network.enable', {}, sessionId, Math.min(3000, remaining()))
    } catch {
      // Continue: getAllCookies below has its own deadline and error reporting.
    }
    const result = await cdp.send('Network.getAllCookies', {}, sessionId, remaining())
    if (Array.isArray(result && result.cookies)) return result.cookies
    failures.push('Network.getAllCookies returned no cookie list')
  } catch (err) {
    firstError = err
    failures.push(`Network.getAllCookies: ${errMessage(err)}`)
  }

  try {
    const result = await cdp.send('Storage.getCookies', {}, undefined, remaining())
    if (Array.isArray(result && result.cookies)) return result.cookies
    failures.push('Storage.getCookies returned no cookie list')
  } catch (err) {
    failures.push(`Storage.getCookies: ${errMessage(err)}`)
  }

  throw new Error(
    `could not read cookies over CDP${firstError ? ` (${errMessage(firstError)})` : ''}: ${failures.join('; ')}`,
  )
}

async function readChromeCookies(browser, options, deadline) {
  const label = browserLabel(browser)
  const warnings = []

  const userDataDir = options.userDataDir
    ? String(options.userDataDir)
    : findChromeUserDataDir(browser)
  if (!userDataDir) {
    throw new Error(`${label} user data directory was not found (looked under %LOCALAPPDATA%)`)
  }
  if (!(await isDirectory(userDataDir))) {
    throw new Error(`${label} user data directory does not exist: ${userDataDir}`)
  }

  const executable = options.executable
    ? String(options.executable)
    : findChromeExecutable(browser)
  if (!executable) {
    throw new Error(`${label} executable was not found; install ${label} or pass an executable path`)
  }

  let localState = {}
  try {
    localState = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'))
  } catch (err) {
    throw new Error(
      `cannot read ${label} Local State (${errorCode(err)}); ` +
      `the browser may be installed for another user or the profile is not initialised`,
    )
  }

  const profileOverride = typeof options.profile === 'string' ? options.profile : undefined
  const profileNames = listChromeProfileNames(userDataDir, localState, profileOverride)
  if (profileNames.length === 0) {
    throw new Error(`no ${label} profile directories were found in ${userDataDir}`)
  }
  const database = findChromeCookieDatabase(userDataDir, profileNames)
  if (!database) {
    const shown = profileNames.slice(0, 4).join(', ')
    throw new Error(`no cookie database was found in ${label} profile(s) ${shown}${profileNames.length > 4 ? ', ...' : ''}`)
  }
  if (database.profileName !== profileNames[0]) {
    warnings.push(
      `preferred profile "${profileNames[0]}" has no cookie database; using "${database.profileName}"`,
    )
  }

  deadline.check('cookie import')
  const tempDir = await mkdtemp(join(tmpdir(), `dsh-cookie-import-${browser}-`))
  let browserState = null
  let cdp = null
  try {
    await copyRequired(join(userDataDir, 'Local State'), join(tempDir, 'Local State'), 'Local State')
    const relativeDbPath = relative(userDataDir, database.dbPath)
    const destinationDatabase = join(tempDir, relativeDbPath)
    await copyRequired(database.dbPath, destinationDatabase, 'the cookie database')
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = database.dbPath + suffix
      if (await isFile(sidecar)) {
        try {
          await copyFileWithRetry(sidecar, destinationDatabase + suffix)
        } catch {
          warnings.push(`a cookie database sidecar (${suffix}) could not be copied; recent cookies may be missing`)
        }
      }
    }
    // Preferences are optional; they only make the copied profile look familiar.
    const preferencesSource = join(userDataDir, database.profileName, 'Preferences')
    if (await isFile(preferencesSource)) {
      try {
        await copyFileWithRetry(preferencesSource, join(tempDir, database.profileName, 'Preferences'))
      } catch {
        // ignore
      }
    }

    const args = [
      ...CHROME_BASE_ARGS,
      ...normalizeExtraArgs(options.extraArgs),
      'about:blank',
    ]
    browserState = spawnTempBrowser(executable, ['--user-data-dir=' + tempDir, ...args])
    const portInfo = await waitForDevToolsPort(browserState, tempDir, deadline)

    let wsUrl = ''
    if (portInfo.wsPath) {
      const wsPath = portInfo.wsPath.startsWith('/') ? portInfo.wsPath : `/${portInfo.wsPath}`
      wsUrl = `ws://127.0.0.1:${portInfo.port}${wsPath}`
    } else {
      wsUrl = await fetchBrowserWsUrl(portInfo.port, deadline)
    }

    cdp = new MiniCdp(wsUrl)
    await cdp.connect(Math.max(1000, Math.min(8000, deadline.remaining)))
    const rawCookies = await readCookiesOverCdp(cdp, deadline)

    const cookies = []
    let invalid = 0
    let partitioned = 0
    for (const raw of rawCookies) {
      const cookie = mapChromeCookie(raw)
      if (!cookie) {
        invalid += 1
        continue
      }
      if (raw && raw.partitionKey) partitioned += 1
      cookies.push(cookie)
    }
    if (invalid > 0) {
      warnings.push(`${invalid} cookie(s) were skipped because they had no usable name or domain`)
    }
    if (partitioned > 0) {
      warnings.push(
        `${partitioned} partitioned (CHIPS) cookie(s) were imported without their partition key`,
      )
    }
    return { profile: database.profileName, cookies, invalid, warnings }
  } finally {
    await shutdownTempBrowser(browserState, cdp, deadline)
    await removeTempDir(tempDir)
  }
}

// ---------------------------------------------------------------------------
// Firefox import
// ---------------------------------------------------------------------------

function queryFirefoxCookieRows(db) {
  const withSameSite =
    'SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies'
  const withoutSameSite =
    'SELECT host, path, name, value, expiry, isSecure, isHttpOnly, 1 AS sameSite FROM moz_cookies'
  try {
    return db.prepare(withSameSite).all()
  } catch {
    return db.prepare(withoutSameSite).all()
  }
}

async function readFirefoxCookies(options, deadline) {
  const warnings = []
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const profilesIni = options.profilesIni
    ? String(options.profilesIni)
    : join(appData, 'Mozilla', 'Firefox', 'profiles.ini')
  const firefoxRoot = dirname(profilesIni)
  const profileOverride = typeof options.profile === 'string' ? options.profile : undefined

  const { candidate, candidates, dbPath } = await findFirefoxCookieProfile(
    profilesIni,
    firefoxRoot,
    profileOverride,
  )
  if (!candidate || !dbPath) {
    if (candidates.length === 0) {
      throw new Error('no Firefox profiles were found (profiles.ini is missing or empty)')
    }
    const shown = candidates.slice(0, 4).map((entry) => entry.name).join(', ')
    throw new Error(`no cookies.sqlite was found in Firefox profile(s) ${shown}${candidates.length > 4 ? ', ...' : ''}`)
  }
  if (candidates[0] && candidate.name !== candidates[0].name) {
    warnings.push(
      `preferred Firefox profile "${candidates[0].name}" has no cookies.sqlite; using "${candidate.name}"`,
    )
  }

  deadline.check('Firefox cookie import')
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-cookie-import-firefox-'))
  const tempDatabase = join(tempDir, 'cookies.sqlite')
  try {
    await copyRequired(dbPath, tempDatabase, 'cookies.sqlite')
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = dbPath + suffix
      if (await isFile(sidecar)) {
        try {
          await copyFileWithRetry(sidecar, tempDatabase + suffix)
        } catch {
          warnings.push(`a cookies.sqlite sidecar (${suffix}) could not be copied; recent cookies may be missing`)
        }
      }
    }

    let DatabaseSync = null
    try {
      const sqlite = await import('node:sqlite')
      DatabaseSync = sqlite.DatabaseSync
    } catch {
      throw new Error('node:sqlite is not available in this Node.js runtime (need Node.js 22.5+ with sqlite support)')
    }
    if (typeof DatabaseSync !== 'function') {
      throw new Error('node:sqlite did not expose DatabaseSync')
    }

    let rows = []
    let database = null
    try {
      database = new DatabaseSync(tempDatabase, { readOnly: true })
      rows = queryFirefoxCookieRows(database)
    } catch (err) {
      throw new Error(`cannot read cookies.sqlite (${errMessage(err)})`)
    } finally {
      try {
        database?.close()
      } catch {
        // ignore
      }
    }

    const cookies = []
    let invalid = 0
    let degraded = 0
    for (const row of rows) {
      const mapped = mapFirefoxCookie(row)
      if (!mapped) {
        invalid += 1
        continue
      }
      if (mapped.degraded) degraded += 1
      cookies.push(mapped.cookie)
    }
    if (invalid > 0) {
      warnings.push(`${invalid} cookie(s) were skipped because they had no usable name or host`)
    }
    if (degraded > 0) {
      warnings.push(
        `${degraded} cookie(s) had SameSite=None without Secure and were downgraded to SameSite=Lax`,
      )
    }
    return { profile: candidate.name, cookies, invalid, degraded, warnings }
  } finally {
    await removeTempDir(tempDir)
  }
}

// ---------------------------------------------------------------------------
// engine application
// ---------------------------------------------------------------------------

async function applyCookies(engine, cookies, result, warnings, errors) {
  if (cookies.length === 0) return
  if (!engine || typeof engine.setCookies !== 'function') {
    result.failed += cookies.length
    errors.push('engine.setCookies() is not available, so no cookies were imported')
    return
  }
  try {
    const outcome = await engine.setCookies(cookies)
    result.imported += Number(outcome && outcome.set) || 0
    result.failed += Number(outcome && outcome.failed) || 0
    if (outcome && Array.isArray(outcome.errors)) {
      for (const item of outcome.errors.slice(0, 20)) {
        errors.push(sanitize(String(item), cookies))
      }
    }
  } catch (err) {
    result.failed += cookies.length
    errors.push(sanitize(`engine.setCookies() threw: ${errMessage(err)}`, cookies))
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Import cookies from an external browser into the built-in browser through
 * `engine.setCookies()`.
 *
 * @param {object} engine  Browser engine (needs `setCookies(cookies)`).
 * @param {{browser: 'chrome'|'edge'|'firefox', log?: object|Function,
 *          timeoutMs?: number, extraArgs?: string[], executable?: string,
 *          userDataDir?: string, profile?: string, profilesIni?: string}} options
 * @returns {Promise<{browser: string|null, profile: string|null, cookies: number,
 *   imported: number, failed: number, warnings: string[], errors: string[]}>}
 *   Cookie values are never included; `cookies` is only a count.
 */
export async function importCookies(engine, options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const requested = typeof opts.browser === 'string' ? opts.browser.trim().toLowerCase() : ''
  const browser = SUPPORTED_BROWSERS.includes(requested) ? requested : null
  const warnings = []
  const errors = []
  const result = {
    browser,
    profile: null,
    cookies: 0,
    imported: 0,
    failed: 0,
    warnings,
    errors,
  }
  const log = opts.log

  if (!browser) {
    warnings.push(`unsupported browser ${JSON.stringify(truncate(requested || String(opts.browser ?? ''), 40))}; expected chrome, edge or firefox`)
    logWarn(log, `[insider-browser] cookie import skipped: ${warnings[0]}`)
    return result
  }

  const timeoutMs = normalizeTimeout(opts.timeoutMs)
  const deadline = new Deadline(timeoutMs)

  try {
    if (browser === 'firefox') {
      const read = await readFirefoxCookies(opts, deadline)
      result.profile = read.profile
      result.cookies = read.cookies.length
      result.failed += read.invalid + read.degraded
      for (const warning of read.warnings) warnings.push(sanitize(warning, []))
      if (read.cookies.length === 0) {
        warnings.push(`no cookies were found in the Firefox profile "${read.profile}"`)
      } else {
        await applyCookies(engine, read.cookies, result, warnings, errors)
      }
    } else {
      const read = await readChromeCookies(browser, opts, deadline)
      result.profile = read.profile
      result.cookies = read.cookies.length
      result.failed += read.invalid
      for (const warning of read.warnings) warnings.push(sanitize(warning, []))
      if (read.cookies.length === 0) {
        warnings.push(`no cookies were found in the ${browserLabel(browser)} profile "${read.profile}"`)
      } else {
        await applyCookies(engine, read.cookies, result, warnings, errors)
      }
    }
  } catch (err) {
    const message = sanitize(`${browserLabel(browser)} cookie import failed: ${errMessage(err)}`, [])
    warnings.push(message)
    logWarn(log, `[insider-browser] ${message}`)
  }

  logInfo(
    log,
    `[insider-browser] cookie import from ${browser}` +
    `${result.profile ? ` profile "${result.profile}"` : ''}: ` +
    `read ${result.cookies}, imported ${result.imported}, failed ${result.failed}, ` +
    `${warnings.length} warning(s)`,
  )
  return result
}

/** Clear the built-in browser's cookie store. */
export async function clearCookies(engine) {
  if (!engine || typeof engine.clearCookies !== 'function') {
    throw new Error('clearCookies: engine.clearCookies() is not available')
  }
  await engine.clearCookies()
  return { cleared: true }
}

/**
 * Report which external browsers look importable. Never reads cookie values.
 */
export async function detectExternalBrowsers() {
  const outcome = {}

  for (const browser of ['chrome', 'edge']) {
    const label = browserLabel(browser)
    const info = {
      available: false,
      executable: findChromeExecutable(browser),
      userDataDir: findChromeUserDataDir(browser),
      profile: null,
      cookieDatabase: false,
      error: null,
    }
    try {
      if (!info.userDataDir) {
        info.error = 'user data directory was not found'
      } else {
        const localState = JSON.parse(await readFile(join(info.userDataDir, 'Local State'), 'utf8'))
        const profileNames = listChromeProfileNames(info.userDataDir, localState)
        const database = findChromeCookieDatabase(info.userDataDir, profileNames)
        info.cookieDatabase = Boolean(database)
        info.profile = database ? database.profileName : profileNames[0] || null
        if (!info.executable) info.error = `${label} executable was not found`
        else if (!database) info.error = 'cookie database was not found'
        else info.available = true
      }
    } catch (err) {
      info.error = `cannot read Local State (${errorCode(err)})`
    }
    outcome[browser] = info
  }

  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const profilesIni = join(appData, 'Mozilla', 'Firefox', 'profiles.ini')
  const firefox = {
    available: false,
    profilesIni,
    profile: null,
    cookieDatabase: false,
    error: null,
  }
  try {
    const { candidate, candidates, dbPath } = await findFirefoxCookieProfile(profilesIni, dirname(profilesIni))
    if (!candidate || !dbPath) {
      firefox.error = candidates.length === 0
        ? 'no Firefox profiles were found'
        : 'no cookies.sqlite was found'
    } else {
      firefox.profile = candidate.name
      firefox.cookieDatabase = true
      firefox.available = true
    }
  } catch (err) {
    firefox.error = errMessage(err)
  }
  outcome.firefox = firefox

  return outcome
}
