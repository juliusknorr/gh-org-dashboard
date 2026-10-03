import { execFileSync } from 'node:child_process'
import type { CiState, Item, ReviewDecision, SyncStatus } from '../shared/types.ts'
import { deleteItemsOutside, getMeta, setMeta, upsertItems } from './db.ts'

export const ORG = process.env.ORG ?? 'Euro-Office'
const CONCURRENCY = 4
const MAX_ATTEMPTS = 3
const MIN_RATE_BUDGET = 500
const SEARCH_OVERLAP_MS = 5 * 60 * 1000
const SEARCH_RESULT_CAP = 1000
const NEVER = new Date(0).toISOString()

const token = process.env.GITHUB_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()

const status: SyncStatus = { running: false, lastSyncAt: getMeta('lastSyncAt'), error: null }
const rateLimit = { remaining: Infinity, resetAt: 0 }

export function getSyncStatus(): SyncStatus {
  return { ...status }
}

export class HttpError extends Error {
  status: number
  extra: Record<string, unknown>
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const graphqlErrorStatus: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403 }

type GraphQLResponse<T> = { data?: T; errors?: { message: string; type?: string }[] }

export async function rest(method: string, path: string, body: unknown): Promise<string> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : res.status, `GitHub HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.text()
}

export async function graphql<T>(query: string, variables: Record<string, unknown>, maxAttempts = MAX_ATTEMPTS): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (res.headers.has('x-ratelimit-remaining')) {
      rateLimit.remaining = Number(res.headers.get('x-ratelimit-remaining'))
      rateLimit.resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000
    }
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500
    if (retryable && attempt < maxAttempts) {
      const waitSeconds = Number(res.headers.get('retry-after')) || 5 * attempt
      console.warn(`GitHub ${res.status}, retrying in ${waitSeconds}s`)
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
      continue
    }
    if (!res.ok) {
      const reset = res.headers.get('x-ratelimit-reset')
      const resetInfo = res.headers.get('x-ratelimit-remaining') === '0' && reset ? ` (rate limited until ${new Date(Number(reset) * 1000).toISOString()})` : ''
      throw new HttpError(res.status >= 500 ? 502 : res.status, `GitHub HTTP ${res.status}${resetInfo}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as GraphQLResponse<T>
    if (body.errors?.length) {
      throw new HttpError(graphqlErrorStatus[body.errors[0].type ?? ''] ?? 422, `GitHub GraphQL: ${body.errors.map((e) => e.message).join('; ')}`)
    }
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

export const COMMON_FIELDS = `
  id number title url state createdAt updatedAt closedAt
  author { __typename login }
  assignees(first: 20) { nodes { login } }
  labels(first: 30) { nodes { name color } }
  milestone { title }
  comments { totalCount }`

export const ISSUE_FIELDS = `
  triageEvents: timelineItems(first: 30, itemTypes: [ISSUE_COMMENT, LABELED_EVENT]) { nodes {
    ... on IssueComment { createdAt author { login } }
    ... on LabeledEvent { createdAt actor { login } }
  } }`

export const PR_FIELDS = `
  isDraft reviewDecision
  firstReviews: reviews(first: 10) { nodes { author { __typename login } submittedAt } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`

export type RawNode = {
  id: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  updatedAt: string
  closedAt: string | null
  author: Author | null
  assignees: { nodes: { login: string }[] }
  labels: { nodes: { name: string; color: string }[] }
  milestone: { title: string } | null
  comments: { totalCount: number }
  isDraft?: boolean
  reviewDecision?: ReviewDecision
  firstReviews?: { nodes: { author: Author | null; submittedAt: string | null }[] }
  reviewRequests?: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] }
  commits?: { nodes: { commit: { statusCheckRollup: { state: CiState } | null } }[] }
  triageEvents?: { nodes: { createdAt: string; author?: { login: string } | null; actor?: { login: string } | null }[] }
}

type Author = { __typename?: string; login: string }

const isBot = (author: Author | null | undefined) => !!author && (author.__typename === 'Bot' || author.login.endsWith('[bot]'))

const orgMembers = new Set<string>(JSON.parse(getMeta('orgMembers') ?? '[]'))

export const isOrgMember = (login: string | null) => login !== null && orgMembers.has(login)

export async function loadOrgMembers(): Promise<void> {
  const query = `query($org: String!, $cursor: String) {
    organization(login: $org) { membersWithRole(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { login } } }
  }`
  const logins: string[] = []
  let cursor: string | null = null
  do {
    const data: { organization: { membersWithRole: Page<{ login: string }> } } = await graphql(query, { org: ORG, cursor })
    logins.push(...data.organization.membersWithRole.nodes.map((m) => m.login))
    cursor = data.organization.membersWithRole.pageInfo.hasNextPage ? data.organization.membersWithRole.pageInfo.endCursor : null
  } while (cursor)
  orgMembers.clear()
  for (const login of logins) orgMembers.add(login)
  setMeta('orgMembers', JSON.stringify(logins))
}

export const ensureOrgMembers = () => (orgMembers.size ? Promise.resolve() : loadOrgMembers())

function triage(node: RawNode): { triagedAt: string | null; triagedBy: string | null } {
  if (node.isDraft !== undefined) return { triagedAt: null, triagedBy: null }
  const author = node.author?.login
  if (isBot(node.author)) return { triagedAt: node.createdAt, triagedBy: null }
  if (author && orgMembers.has(author)) return { triagedAt: node.createdAt, triagedBy: author }
  const first = (node.triageEvents?.nodes ?? [])
    .map((e) => ({ at: e.createdAt, by: (e.author ?? e.actor)?.login }))
    .filter((e) => e.by && orgMembers.has(e.by))
    .sort((a, b) => a.at.localeCompare(b.at))[0]
  return { triagedAt: first?.at ?? null, triagedBy: first?.by ?? null }
}

export function toItem(repo: string, node: RawNode): Item {
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
    member: isOrgMember(node.author?.login ?? null),
    bot: isBot(node.author),
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
    firstReviewAt:
      node.firstReviews?.nodes
        .filter((r) => r.submittedAt && r.author?.login !== node.author?.login && !isBot(r.author))
        .map((r) => r.submittedAt!)
        .sort()[0] ?? null,
    ...triage(node),
  }
}

async function syncConnection(repo: string, connection: 'issues' | 'pullRequests', since: string | null): Promise<string | null> {
  const fields = connection === 'pullRequests' ? COMMON_FIELDS + PR_FIELDS : COMMON_FIELDS + ISSUE_FIELDS
  const query = `query($org: String!, $repo: String!, $cursor: String, $pageSize: Int!) {
    repository(owner: $org, name: $repo) {
      ${connection}(first: $pageSize, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
    }
  }`
  const overlapSince = since && new Date(Date.parse(since) - SEARCH_OVERLAP_MS).toISOString()
  let newest: string | null = null
  let cursor: string | null = null
  do {
    const data: { repository: Record<string, Page<RawNode>> } = await graphql(query, { org: ORG, repo, cursor, pageSize: since ? 10 : 100 })
    const page = data.repository[connection]
    const fresh = page.nodes.filter((n) => !overlapSince || n.updatedAt >= overlapSince)
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
  setMeta(key, newest ?? since ?? NEVER)
}

async function searchSync(since: string): Promise<boolean> {
  const from = new Date(Date.parse(since) - SEARCH_OVERLAP_MS).toISOString().replace(/\.\d+Z$/, 'Z')
  const query = `query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 50, after: $cursor) {
      issueCount pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue { repository { name } ${COMMON_FIELDS} ${ISSUE_FIELDS} }
        ... on PullRequest { repository { name } ${COMMON_FIELDS} ${PR_FIELDS} }
      }
    }
  }`
  let cursor: string | null = null
  do {
    type SearchNode = RawNode & { repository: { name: string } }
    const { search }: { search: Page<SearchNode> & { issueCount: number } } = await graphql(query, { q: `org:${ORG} updated:>=${from}`, cursor })
    if (search.issueCount > SEARCH_RESULT_CAP) return false
    upsertItems(search.nodes.map((n) => toItem(n.repository.name, n)))
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
  } while (cursor)
  return true
}

async function syncRepos(repos: string[], errors: string[]): Promise<void> {
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
}

async function runSync(): Promise<void> {
  if (rateLimit.remaining < MIN_RATE_BUDGET && Date.now() < rateLimit.resetAt) {
    status.error = `GitHub rate limit low (${rateLimit.remaining} left), sync paused until ${new Date(rateLimit.resetAt).toISOString()}`
    return
  }
  const started = Date.now()
  await loadOrgMembers()
  const repos = await listRepos()
  if (repos.length) deleteItemsOutside(repos)
  const errors: string[] = []
  const unsynced = repos.filter((repo) => !getMeta(`repo:${repo}:updatedAt`))
  await syncRepos(unsynced, errors)
  const searchedAt = getMeta('searchedAt')
  const viaSearch = searchedAt !== null && (await searchSync(searchedAt))
  if (!viaSearch) await syncRepos(repos.filter((r) => !unsynced.includes(r)), errors)
  if (viaSearch || !errors.length) setMeta('searchedAt', new Date(started).toISOString())
  status.error = errors.length ? errors.join('\n') : null
  status.lastSyncAt = new Date().toISOString()
  setMeta('lastSyncAt', status.lastSyncAt)
  const mode = [unsynced.length && `${unsynced.length} full`, viaSearch ? 'search' : 'per repo'].filter(Boolean).join(' + ')
  console.log(`synced ${repos.length} repos (${mode}) in ${((Date.now() - started) / 1000).toFixed(1)}s, ${rateLimit.remaining} API points left${errors.length ? `, ${errors.length} failed` : ''}`)
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
