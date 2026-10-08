import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CiState, Item, ReviewDecision, SyncStatus } from '../shared/types.ts'
import { deleteItemsOutside, getMeta, replaceAdvisories, setMeta, upsertItems } from './db.ts'

const presetsFile = process.env.PRESETS_FILE ?? fileURLToPath(new URL('../presets.json', import.meta.url))
export const configDir = dirname(presetsFile)
const SOURCE = /^[\w.-]{1,39}(\/[\w.-]{1,100})?$/

type Presets = Record<string, string[]>

function validatePresets(presets: unknown): Presets {
  if (!presets || typeof presets !== 'object' || Array.isArray(presets) || !Object.keys(presets).length) throw new Error('Define at least one preset')
  for (const [name, sources] of Object.entries(presets)) {
    if (!name.trim() || name.length > 100) throw new Error('Preset names must be 1 to 100 characters')
    if (!Array.isArray(sources) || !sources.length || sources.length > 200 || !sources.every((s) => typeof s === 'string' && SOURCE.test(s))) {
      throw new Error(`"${name}" needs a list of "org" or "owner/repo" entries`)
    }
  }
  return presets as Presets
}

const loadPresets = (): Presets => (existsSync(presetsFile) ? validatePresets(JSON.parse(readFileSync(presetsFile, 'utf8'))) : {})

const sourcesOf = (presets: Presets) => [...new Set(Object.values(presets).flat())]

let PRESETS = loadPresets()
let SOURCES = sourcesOf(PRESETS)

export const getPresets = () => PRESETS
const sourceRepos: Record<string, string[]> = JSON.parse(getMeta('sourceRepos') ?? '{}')

export const presetRepos = (): Record<string, string[]> =>
  Object.fromEntries(Object.entries(PRESETS).map(([name, sources]) => [name, sources.flatMap((s) => sourceRepos[s] ?? (s.includes('/') ? [s] : []))]))

export const isSyncedRepo = (repo: string) =>
  SOURCES.some((s) => (sourceRepos[s] ?? [s]).some((r) => r.toLowerCase() === repo.toLowerCase()))

const ownerOf = (repo: string) => repo.split('/')[0].toLowerCase()
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

function describe(query: string, variables: Record<string, unknown>): string {
  const [first, second] = [...query.matchAll(/(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => n !== 'query' && n !== 'mutation')
  const field = first === 'repository' || first === 'organization' ? `${first}.${second}` : first
  const args = Object.entries(variables)
    .filter(([key, value]) => key !== 'cursor' && value != null)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
  return `${field}(${args.join(' ')})`
}

function rateInfo(headers: Headers): string {
  const remaining = headers.get('x-ratelimit-remaining')
  if (remaining === null) return 'no rate limit headers'
  const reset = new Date(Number(headers.get('x-ratelimit-reset')) * 1000).toLocaleTimeString()
  return `${remaining}/${headers.get('x-ratelimit-limit')} points left, resets ${reset}`
}

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
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitSeconds = retryAfter || 5 * attempt
      const reason = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
      console.warn(
        `GitHub ${res.status} on ${describe(query, variables)}, attempt ${attempt}/${maxAttempts}, ${rateInfo(res.headers)}: ${reason || 'no body'}. ` +
          `Retrying in ${waitSeconds}s${retryAfter ? ' (retry-after header)' : ''}`,
      )
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

async function listRepos(org: string): Promise<string[]> {
  const query = `query($org: String!, $cursor: String) {
    organization(login: $org) { repositories(first: 100, after: $cursor, isArchived: false) { pageInfo { hasNextPage endCursor } nodes { nameWithOwner } } }
  }`
  const names: string[] = []
  let cursor: string | null = null
  do {
    const data: { organization: { repositories: Page<{ nameWithOwner: string }> } } = await graphql(query, { org, cursor })
    const page = data.organization.repositories
    names.push(...page.nodes.map((r) => r.nameWithOwner))
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

const members = new Map<string, Set<string>>(Object.entries(JSON.parse(getMeta('members') ?? '{}') as Record<string, string[]>).map(([o, l]) => [o, new Set(l)]))

export const isOrgMember = (repo: string, login: string | null | undefined) => !!login && !!members.get(ownerOf(repo))?.has(login)

async function loadOwnerMembers(owner: string): Promise<string[]> {
  const query = `query($org: String!, $cursor: String) {
    organization(login: $org) { membersWithRole(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { login } } }
  }`
  const logins: string[] = []
  let cursor: string | null = null
  do {
    const data: { organization: { membersWithRole: Page<{ login: string }> } } = await graphql(query, { org: owner, cursor })
    logins.push(...data.organization.membersWithRole.nodes.map((m) => m.login))
    cursor = data.organization.membersWithRole.pageInfo.hasNextPage ? data.organization.membersWithRole.pageInfo.endCursor : null
  } while (cursor)
  return logins
}

export async function loadOrgMembers(): Promise<void> {
  const owners = [...new Set(SOURCES.map(ownerOf))]
  const lists = await Promise.all(
    owners.map((owner) =>
      loadOwnerMembers(owner).catch((err) => {
        if (err instanceof HttpError && err.status === 404) return [owner]
        throw err
      }),
    ),
  )
  members.clear()
  owners.forEach((owner, i) => members.set(owner, new Set(lists[i])))
  setMeta('members', JSON.stringify(Object.fromEntries(owners.map((o, i) => [o, lists[i]]))))
}

let viewer: Promise<string | null> | null = null
export const viewerLogin = () =>
  (viewer ??= graphql<{ viewer: { login: string } }>('query { viewer { login } }', {}).then(
    (d) => d.viewer.login,
    () => (viewer = null),
  ))

export const ensureOrgMembers = () => (members.size ? Promise.resolve() : loadOrgMembers())

function triage(repo: string, node: RawNode): { triagedAt: string | null; triagedBy: string | null } {
  if (node.isDraft !== undefined) return { triagedAt: null, triagedBy: null }
  const author = node.author?.login
  if (isBot(node.author)) return { triagedAt: node.createdAt, triagedBy: null }
  if (author && isOrgMember(repo, author)) return { triagedAt: node.createdAt, triagedBy: author }
  const first = (node.triageEvents?.nodes ?? [])
    .map((e) => ({ at: e.createdAt, by: (e.author ?? e.actor)?.login }))
    .filter((e) => isOrgMember(repo, e.by))
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
    member: isOrgMember(repo, node.author?.login),
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
    ...triage(repo, node),
  }
}

async function syncConnection(repo: string, connection: 'issues' | 'pullRequests', since: string | null): Promise<{ newest: string | null; count: number }> {
  const fields = connection === 'pullRequests' ? COMMON_FIELDS + PR_FIELDS : COMMON_FIELDS + ISSUE_FIELDS
  const [owner, name] = repo.split('/')
  const query = `query($owner: String!, $name: String!, $cursor: String, $pageSize: Int!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      ${connection}(first: $pageSize, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${fields} } }
    }
  }`
  const overlapSince = since && new Date(Date.parse(since) - SEARCH_OVERLAP_MS).toISOString()
  let newest: string | null = null
  let count = 0
  let cursor: string | null = null
  do {
    const data: { repository: { nameWithOwner: string } & Record<string, Page<RawNode>> } = await graphql(query, { owner, name, cursor, pageSize: since ? 10 : 100 })
    const page = data.repository[connection]
    const fresh = page.nodes.filter((n) => !overlapSince || n.updatedAt >= overlapSince)
    upsertItems(fresh.map((n) => toItem(data.repository.nameWithOwner, n)))
    count += fresh.length
    if (!since && page.pageInfo.hasNextPage && count % 1000 < fresh.length) console.log(`full sync ${repo}: ${count} ${connection} so far`)
    newest ??= fresh[0]?.updatedAt ?? null
    const reachedWatermark = fresh.length < page.nodes.length
    cursor = page.pageInfo.hasNextPage && !reachedWatermark ? page.pageInfo.endCursor : null
  } while (cursor)
  return { newest, count }
}

async function syncRepo(repo: string): Promise<void> {
  const key = `repo:${repo}:updatedAt`
  const since = getMeta(key)
  const started = Date.now()
  const [issues, prs] = await Promise.all([syncConnection(repo, 'issues', since), syncConnection(repo, 'pullRequests', since)])
  const newest = [issues.newest, prs.newest]
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1)
  setMeta(key, newest ?? since ?? NEVER)
  if (!since) console.log(`full sync ${repo} done: ${issues.count} issues, ${prs.count} PRs in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

async function searchSync(source: string, since: string): Promise<boolean> {
  const from = new Date(Date.parse(since) - SEARCH_OVERLAP_MS).toISOString().replace(/\.\d+Z$/, 'Z')
  const query = `query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 50, after: $cursor) {
      issueCount pageInfo { hasNextPage endCursor }
      nodes {
        ... on Issue { repository { nameWithOwner } ${COMMON_FIELDS} ${ISSUE_FIELDS} }
        ... on PullRequest { repository { nameWithOwner } ${COMMON_FIELDS} ${PR_FIELDS} }
      }
    }
  }`
  let cursor: string | null = null
  do {
    type SearchNode = RawNode & { repository: { nameWithOwner: string } }
    const q = `${source.includes('/') ? 'repo' : 'org'}:${source} updated:>=${from}`
    const { search }: { search: Page<SearchNode> & { issueCount: number } } = await graphql(query, { q, cursor })
    if (search.issueCount > SEARCH_RESULT_CAP) return false
    upsertItems(search.nodes.map((n) => toItem(n.repository.nameWithOwner, n)))
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
  } while (cursor)
  return true
}

type Advisory = {
  ghsa_id: string
  url: string
  html_url: string
  summary: string
  description: string | null
  state: 'triage' | 'draft' | 'published' | 'closed' | 'withdrawn'
  severity: string | null
  author: { login: string; type: string } | null
  comments?: number
  created_at: string
  updated_at: string
  published_at: string | null
  closed_at: string | null
  withdrawn_at: string | null
}

export const isAdvisoryId = (id: string) => id.startsWith('GHSA-')
const SEVERITY_COLORS: Record<string, string> = { critical: 'b60205', high: 'd93f0b', medium: 'fbca04', low: 'c5def5' }
const OPEN_ADVISORY_STATES = ['triage', 'draft']

export function advisoryItem(a: Advisory): Item {
  const repo = a.url.split('/repos/')[1].split('/security-advisories')[0]
  const open = OPEN_ADVISORY_STATES.includes(a.state)
  const author = a.author && { __typename: a.author.type, login: a.author.login }
  return {
    id: a.ghsa_id,
    type: 'advisory',
    repo,
    number: 0,
    title: a.summary,
    url: a.html_url,
    state: open ? 'open' : 'closed',
    draft: false,
    author: a.author?.login ?? null,
    member: isOrgMember(repo, a.author?.login),
    bot: isBot(author),
    assignees: [],
    labels: [
      { name: `advisory:${a.state}`, color: 'ededed' },
      ...(a.severity ? [{ name: `severity:${a.severity}`, color: SEVERITY_COLORS[a.severity] ?? 'ededed' }] : []),
    ],
    milestone: null,
    reviewRequests: [],
    reviewDecision: null,
    ci: null,
    comments: a.comments ?? 0,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    closedAt: open ? null : (a.closed_at ?? a.withdrawn_at ?? a.published_at ?? a.updated_at),
    firstReviewAt: null,
    triagedAt: null,
    triagedBy: null,
  }
}

export async function restList<T>(path: string): Promise<T[]> {
  const all: T[] = []
  let url: string | null = `https://api.github.com${path}`
  while (url) {
    const res: Response = await fetch(url, { headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new HttpError(res.status, `GitHub HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`)
    all.push(...((await res.json()) as T[]))
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null
  }
  return all
}

const advisoriesDenied = new Set<string>()

async function syncAdvisories(sources: string[], errors: string[]): Promise<number> {
  let count = 0
  for (const source of sources) {
    const path = `${source.includes('/') ? '/repos' : '/orgs'}/${source}/security-advisories?per_page=100`
    try {
      const items = (await restList<Advisory>(path)).map(advisoryItem).filter((i) => isSyncedRepo(i.repo))
      replaceAdvisories(sourceRepos[source], items)
      count += items.length
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        if (!advisoriesDenied.has(source)) console.warn(`no access to security advisories of ${source}, skipping: ${err.message}`)
        advisoriesDenied.add(source)
        continue
      }
      console.error(`sync advisories of ${source} failed:`, err)
      errors.push(`${source} advisories: ${(err as Error).message}`)
    }
  }
  return count
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
  const sources = SOURCES
  for (const source of sources) sourceRepos[source] = source.includes('/') ? [source] : await listRepos(source)
  setMeta('sourceRepos', JSON.stringify(sourceRepos))
  const repos = [...new Set(sources.flatMap((s) => sourceRepos[s]))]
  if (repos.length) deleteItemsOutside(repos)
  const errors: string[] = []
  const unsynced = repos.filter((repo) => !getMeta(`repo:${repo}:updatedAt`))
  await syncRepos(unsynced, errors)
  const searchedAt = getMeta('searchedAt')
  const perRepo = new Set<string>()
  for (const source of sources) {
    if (searchedAt === null || !(await searchSync(source, searchedAt))) for (const r of sourceRepos[source]) perRepo.add(r)
  }
  const failedBefore = errors.length
  await syncRepos([...perRepo].filter((r) => !unsynced.includes(r)), errors)
  const viaSearch = !perRepo.size
  const advisories = await syncAdvisories(sources, errors)
  if (errors.length === failedBefore) setMeta('searchedAt', new Date(started).toISOString())
  status.error = errors.length ? errors.join('\n') : null
  status.lastSyncAt = new Date().toISOString()
  setMeta('lastSyncAt', status.lastSyncAt)
  const mode = [unsynced.length && `${unsynced.length} full`, viaSearch ? 'search' : 'per repo'].filter(Boolean).join(' + ')
  console.log(`synced ${repos.length} repos (${mode}) and ${advisories} advisories in ${((Date.now() - started) / 1000).toFixed(1)}s, ${rateLimit.remaining} API points left${errors.length ? `, ${errors.length} failed` : ''}`)
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
        if (syncAgain) {
          syncAgain = false
          startSync()
        }
      })
  }
  return getSyncStatus()
}

let syncAgain = false

function requestSync(): void {
  if (status.running) syncAgain = true
  else startSync()
}

async function missingSources(sources: string[]): Promise<string[]> {
  const unknown = sources.filter((s) => !SOURCES.includes(s))
  const found = await Promise.all(
    unknown.map(async (source) => {
      const [owner, name] = source.split('/')
      const query = name
        ? 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }'
        : 'query($owner: String!) { organization(login: $owner) { id } }'
      try {
        const data = await graphql<{ repository?: { id: string } | null; organization?: { id: string } | null }>(query, name ? { owner, name } : { owner }, 1)
        return !!(data.repository ?? data.organization)
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return false
        throw err
      }
    }),
  )
  return unknown.filter((_, i) => !found[i])
}

export async function savePresets(body: unknown): Promise<Presets> {
  let presets: Presets
  try {
    presets = validatePresets(body)
  } catch (err) {
    throw new HttpError(400, (err as Error).message)
  }
  const missing = await missingSources(sourcesOf(presets))
  if (missing.length) throw new HttpError(400, `Not found on GitHub or not accessible: ${missing.join(', ')}`)
  writeFileSync(presetsFile, `${JSON.stringify(presets, null, 2)}\n`)
  PRESETS = presets
  SOURCES = sourcesOf(presets)
  requestSync()
  return presets
}
