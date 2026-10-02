import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Item } from '../shared/types.ts'

const dataDir = new URL('../data/', import.meta.url)
mkdirSync(dataDir, { recursive: true })

const db = new DatabaseSync(new URL('dashboard.db', dataDir).pathname)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, repo TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS items_updated_at ON items (updated_at DESC);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

const upsertStmt = db.prepare(
  'INSERT INTO items (id, repo, updated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, updated_at = excluded.updated_at, json = excluded.json',
)
const allStmt = db.prepare('SELECT json FROM items ORDER BY updated_at DESC')
const getMetaStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
const setMetaStmt = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')

export function upsertItems(items: Item[]): void {
  db.exec('BEGIN')
  try {
    for (const item of items) upsertStmt.run(item.id, item.repo, item.updatedAt, JSON.stringify(item))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function allItems(): Item[] {
  return allStmt.all().map((row) => JSON.parse(row.json as string) as Item)
}

export function getMeta(key: string): string | null {
  return (getMetaStmt.get(key)?.value as string | undefined) ?? null
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value)
}
