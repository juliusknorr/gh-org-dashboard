import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Item, LaunchRequest } from '../shared/types.ts'
import { agentCommand, findCheckouts, shellQuote } from './launch.ts'

test('shellQuote survives a round trip through sh', () => {
  for (const s of [`it's "quoted"`, '$(rm -rf ~) `id` $HOME', 'multi\nline\\', '']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' }), s)
  }
})

test('agentCommand passes the prompt verbatim to claude and custom agents', () => {
  const item = { type: 'pr', repo: 'my-org/app', number: 7, id: 'x' } as Item
  const prompt = `it's "$HOME" \`id\` $(whoami)`
  const req: LaunchRequest = { id: 'x', prompt, worktree: true, remoteControl: false }
  const argsOf = (agent: 'claude' | 'custom', template = '') => {
    const { command } = agentCommand(item, req, '/tmp', { agent, agentCommand: template })
    const printArgs = command.replace(/^cd \S+ && \w+/, 'printf "%s\\n"')
    return execFileSync('sh', ['-c', printArgs], { encoding: 'utf8' }).trimEnd().split('\n')
  }
  assert.deepEqual(argsOf('claude'), ['-n', 'pr-my-org-app-7', '-w', 'pr-my-org-app-7', '--', prompt])
  assert.deepEqual(argsOf('custom', 'codex --title {name} {prompt}'), ['--title', 'pr-my-org-app-7', prompt])
})

test('findCheckouts finds nested repos and submodules by any remote url', () => {
  const base = mkdtempSync(join(tmpdir(), 'repos-'))
  const gitConfig = (gitDir: string, ...urls: string[]) => {
    mkdirSync(join(base, gitDir), { recursive: true })
    writeFileSync(join(base, gitDir, 'config'), urls.map((url, i) => `[remote "r${i}"]\n\turl = ${url}\n`).join(''))
  }
  gitConfig('app/.git', 'git@github.com:other-org/app.git')
  gitConfig('team/fork/.git', 'https://github.com/me/app', 'https://github.com/My-Org/app.git')
  gitConfig('team/fork/apps-extra/deck/.git', 'git@github.com:nextcloud/deck.git')
  gitConfig('server/.git/modules/3rdparty', 'git@github.com:nextcloud/3rdparty.git')
  gitConfig('server/.git', 'git@github.com:nextcloud/server.git')
  writeFileSync(join(base, 'server/.git/config'), '[submodule "3rdparty"]\n\turl = git@github.com:nextcloud/3rdparty.git\n', { flag: 'a' })
  mkdirSync(join(base, 'server/3rdparty'), { recursive: true })
  writeFileSync(join(base, 'server/3rdparty/.git'), 'gitdir: ../.git/modules/3rdparty\n')
  gitConfig('elsewhere/deck/.git', 'https://github.com/nextcloud/deck')
  assert.deepEqual(findCheckouts(base, 'my-org/app'), [join(base, 'team/fork')])
  assert.deepEqual(findCheckouts(base, 'nextcloud/3rdparty'), [join(base, 'server/3rdparty')])
  assert.deepEqual(findCheckouts(base, 'nextcloud/deck').sort(), [join(base, 'elsewhere/deck'), join(base, 'team/fork/apps-extra/deck')])
  assert.deepEqual(findCheckouts(base, 'my-org/missing'), [])
})
