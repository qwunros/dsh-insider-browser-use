#!/usr/bin/env node
/**
 * Live check against a running DSH + insider-browser plugin.
 *
 * Verifies the two things that made the sidebar mirror look broken:
 *   1. a navigation produces at least one new screencast frame;
 *   2. the first human input right after a navigation is dispatched quickly
 *      (Chrome stalls hidden pages for ~5s) and the page reports visible.
 *
 * Usage: node tools/live-check.mjs [url] [baseUrl]
 * Both arguments are optional; the defaults use the bundled demo server.
 */
const url = process.argv[2] || 'http://127.0.0.1:8899/?probe=live-check'
const base = process.argv[3] || 'http://127.0.0.1:3080'
const prefix = base + '/dsh-insider-browser'
const origin = new URL(base).origin

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function action(payload) {
  const started = Date.now()
  const response = await fetch(prefix + '/action', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json().catch(() => null)
  return { ms: Date.now() - started, status: response.status, body }
}

async function state() {
  const response = await fetch(prefix + '/state', { headers: { origin } })
  const body = await response.json()
  return body.status
}

const initial = await state()
check('browser is running', initial.running === true, initial.url || '(no page)')

let frames = 0
let lastSeq = 0
const response = await fetch(prefix + '/events', {
  headers: { origin, accept: 'text/event-stream' },
})
check('SSE stream opens', response.ok === true, response.headers.get('content-type') || '')
const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const pump = (async () => {
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let message
        try {
          message = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (message.type === 'frame') {
          frames += 1
          lastSeq = Number(message.seq) || lastSeq
        }
      }
    }
  }
})()

await sleep(400)
const nav = await action({ action: 'navigate', url })
check('navigation succeeds', nav.body && nav.body.ok === true, JSON.stringify(nav.body))
await sleep(2500)
check('navigation paints at least one frame', frames > 0, `${frames} frame(s), last seq ${lastSeq}`)

const inputStarted = Date.now()
const input = await action({
  action: 'input',
  events: [
    { t: 'm', a: 'move', x: 120, y: 120 },
    { t: 'm', a: 'down', x: 120, y: 120, button: 'left', clickCount: 1 },
    { t: 'm', a: 'up', x: 120, y: 120, button: 'left', clickCount: 1 },
  ],
})
const inputMs = Date.now() - inputStarted
check('input is dispatched', input.body && input.body.dispatched === 3, JSON.stringify(input.body))
check('first input is not stalled', inputMs < 1000, `${inputMs}ms`)

await sleep(600)
const final = await state()
check('page reports visible and focused', final.visible === true && final.focused === true, JSON.stringify({ visible: final.visible, focused: final.focused }))
check('page after navigation matches the target', final.url === url, `${final.url} (want ${url})`)

try {
  await reader.cancel()
} catch {
  /* the stream is already closed */
}
await pump.catch(() => {})
console.log(failures === 0 ? '\nlive check passed' : `\n${failures} live check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
