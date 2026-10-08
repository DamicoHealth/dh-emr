// Tiny zero-dependency static server for local preview of the site.
// Usage: node serve.mjs [port]   (default 4180)
// Serves ./public with directory index.html resolution and a 404 page,
// mirroring how GitHub Pages will serve the deployed tree.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'public')
const port = Number(process.argv[2] ?? 4180)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    if (path.endsWith('/')) path += 'index.html'
    let file = join(root, path)
    if (!file.startsWith(root)) throw new Error('outside root')
    let body
    try {
      body = await readFile(file)
    } catch {
      // Directory without trailing slash, then 404 fallback.
      try {
        body = await readFile(join(root, path, 'index.html'))
        file = 'index.html'
      } catch {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
        res.end(await readFile(join(root, '404.html')).catch(() => 'Not found'))
        return
      }
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(500)
    res.end('Server error')
  }
}).listen(port, () => {
  console.log(`site preview on http://localhost:${port}`)
})
