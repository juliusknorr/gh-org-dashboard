import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Item, LaunchRequest, LaunchResponse } from '../shared/types.ts'

const run = promisify(execFile)

const TERMINAL = process.env.TERMINAL ?? 'iterm'
const REPOS_DIR = (process.env.REPOS_DIR ?? '~/repos/euro-office').replace(/^~(?=\/|$)/, homedir())
const SUPERPROJECT = process.env.SUPERPROJECT ?? 'DocumentServer'
const scriptsDir = new URL('../data/launch/', import.meta.url).pathname

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

async function submodulePaths(): Promise<Map<string, string>> {
  const gitmodules = join(REPOS_DIR, SUPERPROJECT, '.gitmodules')
  if (!existsSync(gitmodules)) return new Map()
  const { stdout } = await run('git', ['config', '--file', gitmodules, '--get-regexp', '^submodule\\..*\\.url$'])
  const entries = stdout.trim().split('\n').map((line) => {
    const [key, url] = line.split(' ')
    const path = key.replace(/^submodule\./, '').replace(/\.url$/, '')
    return [url.replace(/\.git$/, '').split('/').at(-1)!, path] as const
  })
  return new Map(entries)
}

async function resolveCheckout({ repo, url }: Item): Promise<{ dir: string; prepare: () => Promise<void> }> {
  const submodule = (await submodulePaths()).get(repo)
  if (submodule) {
    const superDir = join(REPOS_DIR, SUPERPROJECT)
    const dir = join(superDir, submodule)
    const initialized = existsSync(dir) && readdirSync(dir).length > 0
    return { dir, prepare: async () => void (initialized || (await run('git', ['-C', superDir, 'submodule', 'update', '--init', submodule]))) }
  }
  const dir = join(REPOS_DIR, repo)
  return { dir, prepare: async () => void (existsSync(dir) || (await run('gh', ['repo', 'clone', new URL(url).pathname.split('/').slice(1, 3).join('/'), dir]))) }
}

function claudeCommand(item: Item, { prompt, worktree, remoteControl }: LaunchRequest, dir: string) {
  const name = `${item.type === 'pr' ? 'pr' : 'issue'}-${item.repo}-${item.number}`.replace(/[^\w.-]/g, '-')
  const args = ['claude', '-n', name]
  if (worktree) args.push('-w', name)
  if (remoteControl) args.push('--remote-control', name)
  return { name, command: `cd ${shellQuote(dir)} && ${[...args.map(shellQuote), shellQuote(prompt)].join(' ')}` }
}

async function openTerminal(name: string, dir: string, script: string) {
  if (TERMINAL === 'cmux') {
    await run('cmux', ['workspace', 'create', '--name', name, '--cwd', dir, '--command', `sh ${shellQuote(script)}`])
  } else if (TERMINAL === 'iterm') {
    await run('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "iTerm" to create window with default profile command ("/bin/sh " & quoted form of item 1 of argv)',
      '-e', 'end run',
      script,
    ])
  } else {
    throw new Error(`Unsupported TERMINAL "${TERMINAL}", use iterm or cmux`)
  }
}

export async function launch(item: Item, req: LaunchRequest): Promise<LaunchResponse> {
  const { dir, prepare } = await resolveCheckout(item)
  const { name, command } = claudeCommand(item, req, dir)
  if (req.dryRun) return { command, dir, launched: false }

  await prepare()
  mkdirSync(scriptsDir, { recursive: true })
  const script = join(scriptsDir, `${name}.sh`)
  writeFileSync(script, `export PATH=${shellQuote(process.env.PATH ?? '')}\n${command}\nexec "\${SHELL:-/bin/zsh}" -l\n`)
  await openTerminal(name, dir, script)
  return { command, dir, launched: true }
}
