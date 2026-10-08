import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { CheckoutOptions, Item, LaunchRequest, LaunchResponse, Settings } from '../shared/types.ts'
import { dataDir, getMeta, setMeta } from './db.ts'
import { HttpError } from './sync.ts'

const run = promisify(execFile)


export const DEFAULT_SETTINGS: Settings = {
  terminal: 'iterm',
  agent: 'claude',
  agentCommand: '',
  reposDir: '~/repos',
  superproject: '',
  reviewPrompt: 'Review the pull request {url}. Read the diff and the discussion with gh, and report problems ordered by severity. Do not push or comment.',
  reviewCommand: '',
}

export const getSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...JSON.parse(getMeta('settings') ?? '{}') })
export const setSettings = (settings: Settings) => setMeta('settings', JSON.stringify(settings))

export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir())
const scriptsDir = fileURLToPath(new URL('launch/', dataDir))

export const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

const repoSlug = (url: string) => url.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('/').toLowerCase()

// Submodules and worktrees have a .git file pointing at their git dir, worktree git dirs carry no remotes.
function remoteSlugs(dir: string): string[] {
  const dotGit = join(dir, '.git')
  try {
    const gitDir = statSync(dotGit).isDirectory() ? dotGit : resolve(dir, readFileSync(dotGit, 'utf8').replace(/^gitdir:/, '').trim())
    const remotes = readFileSync(join(gitDir, 'config'), 'utf8').split(/^\s*(?=\[)/m).filter((section) => section.startsWith('[remote '))
    return remotes.flatMap((section) => [...section.matchAll(/^\s*url\s*=\s*(\S+)/gm)].map((m) => repoSlug(m[1])))
  } catch {
    return []
  }
}

// ponytail: walks up to 4 levels on every launch, cache the index if repo folders get large
export function findCheckouts(base: string, repo: string, depth = 4): string[] {
  const found = remoteSlugs(base).includes(repo.toLowerCase()) ? [base] : []
  if (depth === 0) return found
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return found
  }
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
  return [...found, ...subdirs.flatMap((e) => findCheckouts(join(base, e.name), repo, depth - 1))]
}

const mappingFile = process.env.MAPPING_FILE ?? new URL('../mapping.json', import.meta.url)
const loadMapping = (): Record<string, string> => (existsSync(mappingFile) ? JSON.parse(readFileSync(mappingFile, 'utf8')) : {})
const collapseHome = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path)

function saveMapping(repo: string, dir: string) {
  const mapping = { ...loadMapping(), [repo.toLowerCase()]: collapseHome(dir) }
  writeFileSync(mappingFile, `${JSON.stringify(mapping, null, 2)}\n`)
}

async function submodulePaths(superDir: string | null): Promise<Map<string, string>> {
  const gitmodules = superDir && join(superDir, '.gitmodules')
  if (!gitmodules || !existsSync(gitmodules)) return new Map()
  const { stdout } = await run('git', ['config', '--file', gitmodules, '--get-regexp', '^submodule\\..*\\.url$'])
  const entries = stdout.trim().split('\n').map((line) => {
    const [key, url] = line.split(' ')
    const path = key.replace(/^submodule\./, '').replace(/\.url$/, '')
    return [repoSlug(url), path] as const
  })
  return new Map(entries)
}

async function superprojectCheckout(repo: string, base: string, superproject: string) {
  const superDir = superproject ? join(base, superproject) : null
  const submodule = (await submodulePaths(superDir)).get(repo.toLowerCase())
  return superDir && submodule ? { superDir, submodule, dir: join(superDir, submodule) } : null
}

export async function checkoutOptions({ repo }: Item): Promise<CheckoutOptions> {
  const { reposDir, superproject } = getSettings()
  const base = expandHome(reposDir)
  const mapped = loadMapping()[repo.toLowerCase()]
  const mappedDir = mapped && existsSync(expandHome(mapped)) ? expandHome(mapped) : null
  const fromSuperproject = await superprojectCheckout(repo, base, superproject)
  const dirs = [...new Set([mappedDir, fromSuperproject?.dir, ...findCheckouts(base, repo)].filter((d): d is string => !!d))]
  return { dirs, selected: mappedDir ?? (dirs.length === 1 ? dirs[0] : null) }
}

export async function resolveCheckout(item: Item, requested?: string) {
  const { dirs, selected } = await checkoutOptions(item)
  if (requested && !dirs.includes(requested)) throw new HttpError(400, `${requested} is not a checkout of ${item.repo}`)
  if (!requested && !selected && dirs.length > 1) throw new HttpError(409, `Choose a checkout of ${item.repo}`, { dirs })
  const { reposDir, superproject } = getSettings()
  const base = expandHome(reposDir)
  const dir = requested ?? selected ?? join(base, item.repo.split('/')[1])
  const remember = dirs.length > 1 && dir !== selected
  const fromSuperproject = await superprojectCheckout(item.repo, base, superproject)
  const prepare = async () => {
    if (existsSync(dir) && readdirSync(dir).length > 0) return
    if (fromSuperproject?.dir === dir) await run('git', ['-C', fromSuperproject.superDir, 'submodule', 'update', '--init', fromSuperproject.submodule])
    else await run('gh', ['repo', 'clone', item.repo, dir])
  }
  return { dir, prepare, remember }
}

function claudeArgs(name: string, { prompt, worktree, remoteControl }: LaunchRequest) {
  const args = ['claude', '-n', name]
  if (worktree) args.push('-w', name)
  if (remoteControl) args.push('--remote-control', name)
  return [...args, '--', prompt].map(shellQuote).join(' ')
}

export const sessionName = (item: Item) => `${item.type}-${item.repo}-${item.type === 'advisory' ? item.id : item.number}`.replace(/[^\w.-]/g, '-')

export function agentCommand(item: Item, req: LaunchRequest, dir: string, { agent, agentCommand }: Pick<Settings, 'agent' | 'agentCommand'>) {
  const name = sessionName(item)
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
  const { dir, prepare, remember } = await resolveCheckout(item, req.dir)
  const { name, command } = agentCommand(item, req, dir, settings)
  if (req.dryRun) return { command, dir, launched: false }
  if (remember) saveMapping(item.repo, dir)

  await prepare()
  mkdirSync(scriptsDir, { recursive: true })
  const script = join(scriptsDir, `${name}.sh`)
  writeFileSync(script, `export PATH=${shellQuote(process.env.PATH ?? '')}\n${command}\nexec "\${SHELL:-/bin/zsh}" -l\n`)
  await openTerminal(settings.terminal, name, dir, script)
  return { command, dir, launched: true }
}
