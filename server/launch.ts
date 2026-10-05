import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Item, LaunchRequest, LaunchResponse, Settings } from '../shared/types.ts'
import { dataDir, getMeta, setMeta } from './db.ts'

const run = promisify(execFile)


export const DEFAULT_SETTINGS: Settings = {
  terminal: 'iterm',
  agent: 'claude',
  agentCommand: '',
  reposDir: '~/repos',
  superproject: '',
  reviewPrompt: 'Review the pull request {url}. Read the diff and the discussion with gh, and report problems ordered by severity. Do not push or comment.',
}

export const getSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...JSON.parse(getMeta('settings') ?? '{}') })
export const setSettings = (settings: Settings) => setMeta('settings', JSON.stringify(settings))

const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir())
const scriptsDir = fileURLToPath(new URL('launch/', dataDir))

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

async function submodulePaths(superDir: string | null): Promise<Map<string, string>> {
  const gitmodules = superDir && join(superDir, '.gitmodules')
  if (!gitmodules || !existsSync(gitmodules)) return new Map()
  const { stdout } = await run('git', ['config', '--file', gitmodules, '--get-regexp', '^submodule\\..*\\.url$'])
  const entries = stdout.trim().split('\n').map((line) => {
    const [key, url] = line.split(' ')
    const path = key.replace(/^submodule\./, '').replace(/\.url$/, '')
    return [url.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase(), path] as const
  })
  return new Map(entries)
}

async function resolveCheckout({ repo }: Item): Promise<{ dir: string; prepare: () => Promise<void> }> {
  const name = repo.split('/')[1]
  const { reposDir, superproject } = getSettings()
  const base = expandHome(reposDir)
  const superDir = superproject ? join(base, superproject) : null
  const submodule = (await submodulePaths(superDir)).get(repo.toLowerCase())
  if (superDir && submodule) {
    const dir = join(superDir, submodule)
    const initialized = existsSync(dir) && readdirSync(dir).length > 0
    return { dir, prepare: async () => void (initialized || (await run('git', ['-C', superDir, 'submodule', 'update', '--init', submodule]))) }
  }
  const dir = join(base, name)
  return { dir, prepare: async () => void (existsSync(dir) || (await run('gh', ['repo', 'clone', repo, dir]))) }
}

function claudeArgs(name: string, { prompt, worktree, remoteControl }: LaunchRequest) {
  const args = ['claude', '-n', name]
  if (worktree) args.push('-w', name)
  if (remoteControl) args.push('--remote-control', name)
  return [...args, '--', prompt].map(shellQuote).join(' ')
}

export function agentCommand(item: Item, req: LaunchRequest, dir: string, { agent, agentCommand }: Pick<Settings, 'agent' | 'agentCommand'>) {
  const name = `${item.type}-${item.repo}-${item.type === 'advisory' ? item.id : item.number}`.replace(/[^\w.-]/g, '-')
  const agentPart =
    agent === 'custom' ? agentCommand.replace(/\{(prompt|name)\}/g, (_, key: string) => shellQuote(key === 'prompt' ? req.prompt : name)) : claudeArgs(name, req)
  return { name, command: `cd ${shellQuote(dir)} && ${agentPart}` }
}

async function openTerminal(terminal: Settings['terminal'], name: string, dir: string, script: string) {
  if (terminal === 'cmux') {
    await run('cmux', ['workspace', 'create', '--name', name, '--cwd', dir, '--command', `sh ${shellQuote(script)}`])
  } else if (terminal === 'iterm') {
    await run('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "iTerm" to create window with default profile command ("/bin/sh " & quoted form of item 1 of argv)',
      '-e', 'end run',
      script,
    ])
  } else {
    throw new Error(`Unsupported terminal "${terminal}", use iterm or cmux`)
  }
}

export async function launch(item: Item, req: LaunchRequest): Promise<LaunchResponse> {
  const settings = getSettings()
  const { dir, prepare } = await resolveCheckout(item)
  const { name, command } = agentCommand(item, req, dir, settings)
  if (req.dryRun) return { command, dir, launched: false }

  await prepare()
  mkdirSync(scriptsDir, { recursive: true })
  const script = join(scriptsDir, `${name}.sh`)
  writeFileSync(script, `export PATH=${shellQuote(process.env.PATH ?? '')}\n${command}\nexec "\${SHELL:-/bin/zsh}" -l\n`)
  await openTerminal(settings.terminal, name, dir, script)
  return { command, dir, launched: true }
}
