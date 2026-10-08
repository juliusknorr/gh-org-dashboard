import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import type { AiReview, Item, Settings } from '../shared/types.ts'
import { agentArgs, nextStep } from './review.ts'

const item = { type: 'pr', repo: 'my-org/app', number: 7, id: 'x', url: 'https://github.com/my-org/app/pull/7' } as Item
const claude = { agent: 'claude', reviewPrompt: 'review {url}', reviewCommand: '' } as Settings
const custom = { agent: 'custom', reviewPrompt: 'review {url}', reviewCommand: 'codex exec {prompt}' } as Settings
const prev: AiReview = {
  status: 'done',
  headSha: 'aaa',
  sessionId: 's1',
  worktree: '/tmp/wt',
  turns: [{ kind: 'review', prompt: 'review', result: 'Looks risky', headSha: 'aaa', at: '' }],
  pending: null,
  error: null,
}

test('nextStep reviews first, then resumes claude with the delta or a question', () => {
  assert.deepEqual(nextStep(item, claude, null, 'aaa', {}), { kind: 'review', prompt: `review ${item.url}`, resume: false })
  assert.deepEqual(nextStep(item, claude, prev, 'bbb', { fresh: true }), { kind: 'review', prompt: `review ${item.url}`, resume: false })
  const rerun = nextStep(item, claude, prev, 'bbb', {})
  assert.equal(rerun.kind, 'rerun')
  assert.equal(rerun.resume, true)
  assert.match(rerun.prompt, /git diff aaa\.\.bbb/)
  assert.deepEqual(nextStep(item, claude, prev, 'aaa', { question: 'why?' }), { kind: 'question', prompt: 'why?', resume: true })
})

test('nextStep replays earlier turns for agents without sessions', () => {
  const step = nextStep(item, custom, prev, 'aaa', { question: 'why?' })
  assert.equal(step.resume, false)
  assert.match(step.prompt, /Looks risky[\s\S]*why\?$/)
})

test('agentArgs keeps claude read-only and quotes the prompt for custom commands', () => {
  const [cmd, args] = agentArgs(claude, 'p', 's1', true)
  assert.equal(cmd, 'claude')
  assert.deepEqual(args.slice(-2), ['--resume', 's1'])
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.doesNotMatch(args[args.indexOf('--allowedTools') + 1], /Edit|Write|gh api|git push/)
  const prompt = `it's "$HOME" $(whoami)`
  const [sh, shArgs] = agentArgs({ ...custom, reviewCommand: 'printf %s {prompt}' }, prompt, 's1', false)
  assert.equal(execFileSync(sh, shArgs, { encoding: 'utf8' }), prompt)
})
