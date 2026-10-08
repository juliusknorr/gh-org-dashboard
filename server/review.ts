import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { AiReview, AiReviewRequest, AiReviewSummary, AiReviewTurn, Item, Settings } from '../shared/types.ts'
import { allAiReviews, dataDir, deleteAiReview, getAiReview, setAiReview } from './db.ts'
import { getSettings, resolveCheckout, sessionName, shellQuote } from './launch.ts'
import { HttpError, graphql } from './sync.ts'

const run = promisify(execFile)
const reviewsDir = fileURLToPath(new URL('reviews/', dataDir))
const TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// Background runs read untrusted PR content unattended, so only read-only tools are allowed and nothing asks for permission.
const READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Skill',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git blame:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
  'Bash(gh pr checks:*)',
  'Bash(gh issue view:*)',
]

const running = new Set<string>()

const withLiveStatus = (id: string, review: AiReview): AiReview =>
  review.status === 'running' && !running.has(id) ? { ...review, status: 'failed', pending: null, error: 'Interrupted by a server restart' } : review

export function getReview(id: string): AiReview | null {
  const review = getAiReview(id)
  return review && withLiveStatus(id, review)
}

export function listReviews(): AiReviewSummary[] {
  return allAiReviews().map(({ id, review, item }) => {
    const { status, pending, turns, worktree, error } = withLiveStatus(id, review)
    return { id, item, status, pending, turns: turns.length, lastAt: turns.at(-1)?.at ?? null, worktree: existsSync(worktree), error }
  })
}

export async function pruneReview(id: string): Promise<void> {
  if (running.has(id)) throw new HttpError(409, 'Wait for the running review to finish')
  const review = getAiReview(id)
  if (!review) throw new HttpError(404, 'No AI review for this item')
  if (existsSync(review.worktree)) {
    // The main checkout may be gone, then deleting the folder is enough and git prunes the stale entry later.
    await run('git', ['-C', review.worktree, 'worktree', 'remove', '--force', review.worktree]).catch(() => rmSync(review.worktree, { recursive: true, force: true }))
  }
  deleteAiReview(id)
}

type Step = { kind: AiReviewTurn['kind']; prompt: string; resume: boolean }

export function nextStep(item: Item, settings: Settings, prev: AiReview | null, headSha: string, req: AiReviewRequest): Step {
  const canResume = settings.agent === 'claude' && !!prev?.sessionId
  if (req.question) return { kind: 'question', prompt: withHistory(req.question, prev, canResume), resume: canResume }
  if (!prev?.turns.length || req.fresh) return { kind: 'review', prompt: settings.reviewPrompt.replaceAll('{url}', item.url), resume: false }
  const update =
    prev.headSha === headSha
      ? `Review the pull request ${item.url} again and give the updated full review.`
      : `The pull request ${item.url} was updated from ${prev.headSha} to ${headSha}, which is now checked out. ` +
        `Review what changed (git diff ${prev.headSha}..${headSha}, or gh pr diff after a force push) and give the updated full review.`
  return { kind: 'rerun', prompt: withHistory(update, prev, canResume), resume: canResume }
}

// Custom agents can't resume a session, so they get the earlier turns as context instead.
function withHistory(prompt: string, prev: AiReview | null, canResume: boolean) {
  if (canResume || !prev?.turns.length) return prompt
  const history = prev.turns.map((t) => `## ${t.kind} at ${t.headSha}\n\n${t.kind === 'question' ? `Question: ${t.prompt}\n\n` : ''}${t.result}`).join('\n\n')
  return `Earlier review conversation:\n\n${history}\n\n---\n\n${prompt}`
}

export function agentArgs(settings: Settings, prompt: string, sessionId: string, resume: boolean): [string, string[]] {
  if (settings.agent === 'custom') return ['sh', ['-c', settings.reviewCommand.replaceAll('{prompt}', shellQuote(prompt))]]
  return [
    'claude',
    ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS.join(','), ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])],
  ]
}

async function headSha(item: Item): Promise<string> {
  const data = await graphql<{ node: { headRefOid: string } | null }>('query($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid } } }', { id: item.id })
  if (!data.node) throw new HttpError(404, 'Pull request not found')
  return data.node.headRefOid
}

async function checkoutHead(item: Item, checkout: { dir: string; prepare: () => Promise<void> } | null, worktree: string, sha: string) {
  const fetchPr = (cwd: string) => run('git', ['-C', cwd, 'fetch', '--quiet', `https://github.com/${item.repo}.git`, `pull/${item.number}/head`])
  if (!checkout) {
    await fetchPr(worktree)
    await run('git', ['-C', worktree, 'checkout', '--quiet', '--detach', sha])
    return
  }
  await checkout.prepare()
  await fetchPr(checkout.dir)
  mkdirSync(reviewsDir, { recursive: true })
  await run('git', ['-C', checkout.dir, 'worktree', 'add', '--quiet', '--detach', worktree, sha])
}

async function runAgent(settings: Settings, cwd: string, prompt: string, sessionId: string, resume: boolean) {
  const [cmd, args] = agentArgs(settings, prompt, sessionId, resume)
  const pending = run(cmd, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES })
  pending.child.stdin?.end(settings.agent === 'claude' ? prompt : '')
  const { stdout } = await pending
  if (settings.agent === 'custom') return { result: stdout.trim(), sessionId: null }
  const out = JSON.parse(stdout) as { result: string; session_id: string; is_error: boolean }
  if (out.is_error) throw new Error(out.result || 'Claude reported an error')
  return { result: out.result, sessionId: out.session_id }
}

export async function startReview(item: Item, req: AiReviewRequest): Promise<AiReview> {
  if (item.type !== 'pr') throw new HttpError(400, 'Only pull requests can be reviewed')
  if (running.has(item.id)) throw new HttpError(409, 'A review is already running')
  const settings = getSettings()
  if (settings.agent === 'custom' && !settings.reviewCommand.includes('{prompt}')) throw new HttpError(400, 'Set a background review command in Settings')
  const prev = getReview(item.id)
  if (req.question && !prev?.turns.length) throw new HttpError(400, 'Run a review before asking about it')

  const worktree = prev?.worktree ?? join(reviewsDir, sessionName(item))
  const checkout = existsSync(worktree) ? null : await resolveCheckout(item, req.dir)
  const sha = await headSha(item)
  const step = nextStep(item, settings, prev, sha, req)
  const sessionId = step.resume ? prev!.sessionId! : randomUUID()
  const started: AiReview = {
    status: 'running',
    headSha: prev?.headSha ?? sha,
    sessionId: prev?.sessionId ?? null,
    worktree,
    turns: prev?.turns ?? [],
    pending: step.kind,
    error: null,
  }
  setAiReview(item.id, started)
  running.add(item.id)

  ;(async () => {
    try {
      const reviewedSha = step.kind === 'question' && !checkout ? started.headSha : sha
      if (reviewedSha === sha) await checkoutHead(item, checkout, worktree, sha)
      const out = await runAgent(settings, worktree, step.prompt, sessionId, step.resume)
      const turn: AiReviewTurn = { kind: step.kind, prompt: req.question ?? step.prompt, result: out.result, headSha: reviewedSha, at: new Date().toISOString() }
      const turns = step.kind === 'review' ? [turn] : [...started.turns, turn]
      setAiReview(item.id, { ...started, status: 'done', headSha: reviewedSha, sessionId: out.sessionId, turns, pending: null })
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string }
      setAiReview(item.id, { ...started, status: 'failed', pending: null, error: (e.stderr?.trim() || e.message).slice(-2000) })
    } finally {
      running.delete(item.id)
    }
  })()
  return started
}
