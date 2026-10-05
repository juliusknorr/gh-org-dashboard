import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHES = { 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64' }

const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
const arch = ARCHES[triple]
if (!arch) throw new Error(`No Node download for ${triple}`)
const binDir = fileURLToPath(new URL('../src-tauri/binaries/', import.meta.url))
const target = join(binDir, `node-${triple}`)
if (existsSync(target)) process.exit(0)

const name = `node-${process.version}-${arch}`
const base = `https://nodejs.org/dist/${process.version}/`
console.log(`downloading ${name}`)
const [tarball, sums] = await Promise.all([
  fetch(`${base}${name}.tar.gz`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status} for ${name}.tar.gz`)))),
  fetch(`${base}SHASUMS256.txt`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status} for SHASUMS256.txt`)))),
])
const expected = sums.split('\n').find((line) => line.endsWith(`  ${name}.tar.gz`))?.split(' ')[0]
const actual = createHash('sha256').update(Buffer.from(tarball)).digest('hex')
if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${name}.tar.gz`)

const tmp = mkdtempSync(join(tmpdir(), 'node-'))
writeFileSync(join(tmp, 'node.tar.gz'), Buffer.from(tarball))
execFileSync('tar', ['-xzf', join(tmp, 'node.tar.gz'), '-C', tmp, `${name}/bin/node`])
mkdirSync(binDir, { recursive: true })
renameSync(join(tmp, name, 'bin', 'node'), target)
console.log(`saved ${target}`)
