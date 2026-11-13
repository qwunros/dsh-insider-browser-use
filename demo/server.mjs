// Tiny static server for the built-in-browser demo page.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.DEMO_PORT || 8899)

createServer(async (req, res) => {
  try {
    const html = await readFile(join(here, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(html)
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`demo page: http://127.0.0.1:${port}`)
})
