import type { Activity } from '../shared/types.ts'
import { HttpError, graphql } from './sync.ts'

const CACHE_MS = 10 * 60 * 1000
const CONCURRENCY = 5
type PageInfo = { hasNextPage: boolean; endCursor: string | null }
type Target = { url: string; repo: string; at?: string }

const itemUrl = (url: string) => url.split('#')[0]

async function reviewed(login: string, from: string): Promise<Target[]> {
  const query = `query($login: String!, $from: DateTime!, $cursor: String) {
    user(login: $login) { contributionsCollection(from: $from) { pullRequestReviewContributions(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor } nodes { occurredAt pullRequest { url repository { nameWithOwner } } }
    } } }
  }`
  const targets: Target[] = []
  let cursor: string | null = null
  do {
    type Page = { pageInfo: PageInfo; nodes: { occurredAt: string; pullRequest: { url: string; repository: { nameWithOwner: string } } }[] }
    const data: { user: { contributionsCollection: { pullRequestReviewContributions: Page } } | null } = await graphql(query, { login, from, cursor })
    const page = data.user?.contributionsCollection.pullRequestReviewContributions
    targets.push(...(page?.nodes ?? []).map((n) => ({ url: n.pullRequest.url, repo: n.pullRequest.repository.nameWithOwner, at: n.occurredAt })))
    cursor = page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)
  return targets
}

async function commented(login: string, from: string): Promise<Target[]> {
  const query = `query($login: String!, $cursor: String) {
    user(login: $login) { issueComments(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor } nodes { url createdAt updatedAt repository { nameWithOwner } }
    } }
  }`
  const targets: Target[] = []
  let cursor: string | null = null
  do {
    type Node = { url: string; createdAt: string; updatedAt: string; repository: { nameWithOwner: string } }
    const data: { user: { issueComments: { pageInfo: PageInfo; nodes: Node[] } } | null } = await graphql(query, { login, cursor })
    const page = data.user?.issueComments
    const nodes = page?.nodes ?? []
    targets.push(...nodes.filter((n) => n.createdAt >= from).map((n) => ({ url: itemUrl(n.url), repo: n.repository.nameWithOwner })))
    cursor = page?.pageInfo.hasNextPage && nodes.at(-1)!.updatedAt >= from ? page.pageInfo.endCursor : null
  } while (cursor)
  return targets
}

const cache = new Map<string, { at: number; value: Promise<{ reviewed: Target[]; commented: Target[] }> }>()

function load(login: string, from: string) {
  const key = `${login.toLowerCase()} ${from}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = Promise.all([reviewed(login, from), commented(login, from)]).then(
    ([r, c]) => ({ reviewed: r, commented: c }),
    (err) => {
      if (err instanceof HttpError && err.status === 404) return { reviewed: [], commented: [] }
      throw err
    },
  )
  value.catch(() => cache.delete(key))
  cache.set(key, { at: Date.now(), value })
  return value
}

const inScope = (targets: Target[], repos: Set<string>) => targets.filter((t) => repos.has(t.repo.toLowerCase()))
const distinct = (targets: Target[]) => new Set(targets.map((t) => t.url)).size

export async function activity(logins: string[], from: string, repos: string[]): Promise<Record<string, Activity>> {
  const scope = new Set(repos.map((r) => r.toLowerCase()))
  const results: Awaited<ReturnType<typeof load>>[] = []
  // ponytail: fixed batches, GitHub fails with "Something went wrong" on ~100 parallel contributionsCollection queries
  for (let i = 0; i < logins.length; i += CONCURRENCY) results.push(...(await Promise.all(logins.slice(i, i + CONCURRENCY).map((login) => load(login, from)))))
  return Object.fromEntries(
    logins.map((login, i) => {
      const reviewed = inScope(results[i].reviewed, scope)
      return [login, { reviewed: distinct(reviewed), commented: distinct(inScope(results[i].commented, scope)), reviews: reviewed.map((t) => ({ url: t.url, at: t.at! })) }]
    }),
  )
}
