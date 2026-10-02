import { execFileSync } from 'node:child_process'
import type { CiState, Item, ReviewDecision, SyncStatus } from '../shared/types.ts'
import { getMeta, setMeta, upsertItems } from './db.ts'

export const ORG = process.env.ORG ?? 'Euro-Office'
const CONCURRENCY = 4
const MAX_ATTEMPTS = 3

const token = process.env.GITHUB_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const status: SyncStatus = { running: false, lastSyncAt: getMeta('lastSyncAt'), error: null }

export function getSyncStatus(): SyncStatus {
  return { ...status }
}

type GraphQLResponse<T> = { data?: T; errors?: { message: string }[] }

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500
    if (retryable && attempt < MAX_ATTEMPTS) {
      const waitSeconds = Number(res.headers.get('retry-after')) || 5 * attempt
      console.warn(`GitHub ${res.status}, retrying in ${waitSeconds}s`)
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
      continue
    }
    if (!res.ok) {
      const reset = res.headers.get('x-ratelimit-reset')
      const resetInfo = res.headers.get('x-ratelimit-remaining') === '0' && reset ? ` (rate limited until ${new Date(Number(reset) * 1000).toISOString()})` : ''
      throw new Error(`GitHub HTTP ${res.status}${resetInfo}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as GraphQLResponse<T>
    if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
    return body.data as T
  }
}

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }

async function listRepos(): Promise<string[]> {
  const query = `query($org: String!, $cursor: String) {
    organization(login: $org) { repositories(first: 100, after: $cursor, isArchived: false) { pageInfo { hasNextPage endCursor } nodes { name } } }
  }`
  const names: string[] = []
  let cursor: string | null = null
  do {
    const data: { organization: { repositories: Page<{ name: string }> } } = await graphql(query, { org: ORG, cursor })
    const page = data.organization.repositories
    names.push(...page.nodes.map((r) => r.name))
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return names
}

const COMMON_FIELDS = `
  id number title url state createdAt updatedAt closedAt authorAssociation
  author { login }
  assignees(first: 20) { nodes { login } }
  labels(first: 30) { nodes { name color } }
  milestone { title }
  comments { totalCount }`

const PR_FIELDS = `
  isDraft reviewDecision
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

type RawNode = {
  id: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  updatedAt: string
  closedAt: string | null
  authorAssociation: string
  author: { login: string } | null
  assignees: { nodes: { login: string }[] }
  labels: { nodes: { name: string; color: string }[] }
  milestone: { title: string } | null
  comments: { totalCount: number }
  isDraft?: boolean
  reviewDecision?: ReviewDecision
  reviewRequests?: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] }
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState } | null } }[] }
}

function toItem(repo: string, node: RawNode): Item {
  const isPr = node.isDraft !== undefined
  return {
    id: node.id,
    type: isPr ? 'pr' : 'issue',
    repo,
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state === 'MERGED' ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed',
    draft: node.isDraft ?? false,
    author: node.author?.login ?? null,
    authorAssociation: node.authorAssociation,
    assignees: node.assignees.nodes.map((a) => a.login),
    labels: node.labels.nodes.map(({ name, color }) => ({ name, color })),
    milestone: node.milestone?.title ?? null,
    reviewRequests: (node.reviewRequests?.nodes ?? [])
      .map(({ requestedReviewer: r }) => (r?.login ? r.login : r?.slug ? `team:${r.slug}` : null))
      .filter((r): r is string => r !== null),
    reviewDecision: node.reviewDecision ?? null,
    ci: node.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    comments: node.comments.totalCount,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
  }
}

async function syncConnection(repo: string, connection: 'issues' | 'pullRequests', since: string | null): Promise<string | null> {
  const fields = connection === 'pullRequests' ? COMMON_FIELDS + PR_FIELDS : COMMON_FIELDS
  const query = `query($org: String!, $repo: String!, $cursor: String, $pageSize: Int!) {
    repository(owner: $org, name: $repo) {
      ${connection}(first: $pageSize, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
    }
  }`
  let newest: string | null = null
  let cursor: string | null = null
  do {
    const data: { repository: Record<string, Page<RawNode>> } = await graphql(query, { org: ORG, repo, cursor, pageSize: since ? 10 : 100 })
    const page = data.repository[connection]
    const fresh = page.nodes.filter((n) => !since || n.updatedAt >= since)
    upsertItems(fresh.map((n) => toItem(repo, n)))
    newest ??= fresh[0]?.updatedAt ?? null
    const reachedWatermark = fresh.length < page.nodes.length
    cursor = page.pageInfo.hasNextPage && !reachedWatermark ? page.pageInfo.endCursor : null
  } while (cursor)
  return newest
}

async function syncRepo(repo: string): Promise<void> {
  const key = `repo:${repo}:updatedAt`
  const since = getMeta(key)
  const newest = (await Promise.all([syncConnection(repo, 'issues', since), syncConnection(repo, 'pullRequests', since)]))
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1)
  if (newest) setMeta(key, newest)
}

async function runSync(): Promise<void> {
  const started = Date.now()
  const repos = await listRepos()
  const errors: string[] = []
  let next = 0
  const worker = async () => {
    while (next < repos.length) {
      const repo = repos[next++]
      try {
        await syncRepo(repo)
      } catch (err) {
        console.error(`sync ${repo} failed:`, err)
        errors.push(`${repo}: ${(err as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  status.error = errors.length ? errors.join('\n') : null
  status.lastSyncAt = new Date().toISOString()
  setMeta('lastSyncAt', status.lastSyncAt)
  console.log(`synced ${repos.length} repos in ${((Date.now() - started) / 1000).toFixed(1)}s${errors.length ? `, ${errors.length} failed` : ''}`)
}

export function startSync(): SyncStatus {
  if (!status.running) {
    status.running = true
    runSync()
      .catch((err: Error) => {
        console.error('sync failed:', err)
        status.error = err.message
      })
      .finally(() => {
        status.running = false
      })
  }
  return getSyncStatus()
}
