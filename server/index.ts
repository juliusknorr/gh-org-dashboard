import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ItemsResponse, LaunchRequest } from '../shared/types.ts'
import { allItems } from './db.ts'
import { fetchDetails, fetchRepoOptions, parseAction, runAction } from './items.ts'
import { launch } from './launch.ts'
import { HttpError, ORG, getSyncStatus, startSync } from './sync.ts'

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

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

function sendJson(res: ServerResponse, body: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const MAX_BODY_BYTES = 256 * 1024
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1'])

const isLocal = (value: string | undefined) => {
  try {
    return !!value && LOCAL_HOSTNAMES.has(new URL(value.includes('://') ? value : `http://${value}`).hostname)
  } catch {
    return false
  }
}

const isTrustedPost = (req: IncomingMessage) => isLocal(req.headers.origin) && req.headers['content-type'] === 'application/json'

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Body too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const filePath = normalize(join(distDir, decodeURIComponent(pathname)))
  const candidate = filePath.startsWith(distDir) && !filePath.endsWith(sep) ? filePath : join(distDir, 'index.html')
  for (const path of [candidate, join(distDir, 'index.html')]) {
    try {
      const data = await readFile(path)
      const type = contentTypes[extname(path)] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, ...(type.startsWith('text/html') && { 'content-security-policy': CONTENT_SECURITY_POLICY }) })
      res.end(data)
      return
    } catch {}
  }
  res.writeHead(404).end('Not found')
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  const itemRoute = pathname.match(/^\/api\/items\/([\w=-]{1,100})(\/actions)?$/)
  const optionsRoute = pathname.match(/^\/api\/repos\/([^/]+)\/options$/)
  try {
    if (pathname.startsWith('/api/')) {
      if (!isLocal(req.headers.host) || (req.method === 'POST' && !isTrustedPost(req))) return sendJson(res, { error: 'Forbidden' }, 403)
    }
    if (pathname === '/api/items' && req.method === 'GET') {
      const body: ItemsResponse = { org: ORG, items: allItems(), sync: getSyncStatus() }
      return sendJson(res, body)
    }
    if (itemRoute && !itemRoute[2] && req.method === 'GET') return sendJson(res, await fetchDetails(itemRoute[1]))
    if (itemRoute?.[2] && req.method === 'POST') return sendJson(res, await runAction(itemRoute[1], parseAction(await readJson(req))))
    if (optionsRoute && req.method === 'GET') return sendJson(res, await fetchRepoOptions(optionsRoute[1]))
    if (pathname === '/api/sync' && req.method === 'POST') return sendJson(res, startSync())
    if (pathname === '/api/launch' && req.method === 'POST') {
      const body = await readJson<LaunchRequest>(req)
      const item = allItems().find((i) => i.id === body.id)
      if (!item || typeof body.prompt !== 'string' || !body.prompt.trim()) return sendJson(res, { error: 'Unknown item or empty prompt' }, 400)
      try {
        return sendJson(res, await launch(item, { ...body, worktree: body.worktree === true, remoteControl: body.remoteControl === true }))
      } catch (err) {
        return sendJson(res, { error: (err as Error).message }, 500)
      }
    }
    if (pathname.startsWith('/api/')) return sendJson(res, { error: 'Not found' }, 404)
    await serveStatic(pathname, res)
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, { error: err.message, ...err.extra }, err.status)
    console.error(err)
    sendJson(res, { error: 'Internal error' }, 500)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`listening on http://localhost:${PORT}`))

startSync()
setInterval(startSync, SYNC_INTERVAL_MS)
