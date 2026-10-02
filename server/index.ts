import { readFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ItemsResponse } from '../shared/types.ts'
import { allItems } from './db.ts'
import { ORG, getSyncStatus, startSync } from './sync.ts'

const PORT = Number(process.env.PORT ?? 3001)
const SYNC_INTERVAL_MS = 5 * 60 * 1000
const distDir = fileURLToPath(new URL('../web/dist/', import.meta.url))

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function sendJson(res: ServerResponse, body: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const filePath = normalize(join(distDir, decodeURIComponent(pathname)))
  const candidate = filePath.startsWith(distDir) && !filePath.endsWith(sep) ? filePath : join(distDir, 'index.html')
  for (const path of [candidate, join(distDir, 'index.html')]) {
    try {
      const data = await readFile(path)
      res.writeHead(200, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' })
      res.end(data)
      return
    } catch {}
  }
  res.writeHead(404).end('Not found')
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (pathname === '/api/items' && req.method === 'GET') {
      const body: ItemsResponse = { org: ORG, items: allItems(), sync: getSyncStatus() }
      return sendJson(res, body)
    }
    if (pathname === '/api/sync' && req.method === 'POST') return sendJson(res, startSync())
    if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404)
    await serveStatic(pathname, res)
  } catch (err) {
    console.error(err)
    sendJson(res, { error: 'Internal error' }, 500)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`listening on http://localhost:${PORT}`))

startSync()
setInterval(startSync, SYNC_INTERVAL_MS)
