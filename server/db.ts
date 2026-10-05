import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Item } from '../shared/types.ts'

export const dataDir = process.env.DATA_DIR ? pathToFileURL(`${process.env.DATA_DIR}/`) : new URL('../data/', import.meta.url)
mkdirSync(dataDir, { recursive: true })

const db = new DatabaseSync(fileURLToPath(new URL('dashboard.db', dataDir)), { timeout: 5000 })
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, repo TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS items_updated_at ON items (updated_at DESC);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

const SCHEMA_VERSION = '5'

const upsertStmt = db.prepare(
  'INSERT INTO items (id, repo, updated_at, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, updated_at = excluded.updated_at, json = excluded.json WHERE excluded.updated_at >= items.updated_at',
)
const allStmt = db.prepare('SELECT json FROM items ORDER BY updated_at DESC')
const deleteStmt = db.prepare('DELETE FROM items WHERE id = ?')
const deleteOutsideStmt = db.prepare('DELETE FROM items WHERE lower(repo) NOT IN (SELECT lower(value) FROM json_each(?))')
const deleteWatermarksOutsideStmt = db.prepare(
  "DELETE FROM meta WHERE key LIKE 'repo:%:updatedAt' AND lower(substr(key, 6, length(key) - 15)) NOT IN (SELECT lower(value) FROM json_each(?))",
)
const deleteAdvisoriesStmt = db.prepare(
  "DELETE FROM items WHERE json_extract(json, '$.type') = 'advisory' AND lower(repo) IN (SELECT lower(value) FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?))",
)
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

export function deleteItem(id: string): void {
  deleteStmt.run(id)
}

export function deleteItemsOutside(repos: string[]): void {
  deleteWatermarksOutsideStmt.run(JSON.stringify(repos))
  const { changes } = deleteOutsideStmt.run(JSON.stringify(repos))
  if (changes) console.log(`removed ${changes} items from repos no longer in a preset`)
}

export function replaceAdvisories(repos: string[], items: Item[]): void {
  upsertItems(items)
  deleteAdvisoriesStmt.run(JSON.stringify(repos), JSON.stringify(items.map((i) => i.id)))
}

export function getMeta(key: string): string | null {
  return (getMetaStmt.get(key)?.value as string | undefined) ?? null
}

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value)
}

if (getMeta('schemaVersion') !== SCHEMA_VERSION) {
  db.prepare("DELETE FROM meta WHERE key LIKE 'repo:%:updatedAt'").run()
  setMeta('schemaVersion', SCHEMA_VERSION)
}
