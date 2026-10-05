import { mergeBlockers } from '../shared/merge.ts'
import type { Check, ItemAction, ItemDetails, MergeMethod, PrDetails, RepoOptions, Review, ReviewEvent } from '../shared/types.ts'
import { allItems, deleteItem, markRead, readAt, upsertItems } from './db.ts'
import { COMMON_FIELDS, HttpError, ISSUE_FIELDS, PR_FIELDS, advisoryItem, ensureOrgMembers, graphql, isAdvisoryId, isSyncedRepo, rest, toItem, type RawNode } from './sync.ts'

const MAX_COMMENT_LENGTH = 65536
const MAX_REF_LENGTH = 200
const MERGE_METHODS: MergeMethod[] = ['MERGE', 'SQUASH', 'REBASE']
const CLOSE_REASONS = ['COMPLETED', 'NOT_PLANNED']
const REVIEW_EVENTS: ReviewEvent[] = ['APPROVE', 'REQUEST_CHANGES']
const NO_RETRY = 1
const MAX_LIST_ENTRIES = 50
const OPTIONS_TTL_MS = 10 * 60 * 1000
const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const REVIEWER = /^(?:team:[\w.-]{1,100}|[A-Za-z0-9-]{1,39})$/
export const REPO_NAME = /^[\w.-]{1,39}\/[\w.-]{1,100}$/

const DETAIL_FIELDS = `
  bodyHTML viewerCanClose
  repository { nameWithOwner }
  recentComments: comments(last: 50) { nodes { author { login } createdAt bodyHTML url } }`

const PR_DETAIL_FIELDS = `
  headRefOid headRefName baseRefName mergeable additions deletions changedFiles viewerCanMergeAsAdmin
  latestReviews(first: 50) { nodes { author { login } state submittedAt } }
  repository { squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed viewerDefaultMergeMethod }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion status detailsUrl }
    ... on StatusContext { context state targetUrl }
  } } } } } }`

const DETAILS_QUERY = `query($id: ID!) { node(id: $id) {
  ... on Issue { ${COMMON_FIELDS} ${ISSUE_FIELDS} ${DETAIL_FIELDS} }
  ... on PullRequest { ${COMMON_FIELDS} ${PR_FIELDS} ${DETAIL_FIELDS} ${PR_DETAIL_FIELDS} }
} }`

type CheckContext =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; status: string; detailsUrl: string | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null }

type DetailNode = RawNode & {
  bodyHTML: string
  viewerCanClose: boolean
  repository: { nameWithOwner: string }
  recentComments: { nodes: { author: { login: string } | null; createdAt: string; bodyHTML: string; url: string }[] }
}

type PrNode = DetailNode & {
  headRefOid: string
  headRefName: string
  baseRefName: string
  mergeable: PrDetails['mergeable']
  additions: number
  deletions: number
  changedFiles: number
  viewerCanMergeAsAdmin: boolean
  latestReviews: { nodes: { author: { login: string } | null; state: Review['state']; submittedAt: string | null }[] }
  repository: { squashMergeAllowed: boolean; mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean; viewerDefaultMergeMethod: MergeMethod }
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] }
}

const toCheck = (c: CheckContext): Check =>
  c.__typename === 'CheckRun'
    ? { name: c.name, conclusion: c.conclusion ?? c.status, url: c.detailsUrl }
    : { name: c.context, conclusion: c.state, url: c.targetUrl }

function toPrDetails(node: PrNode): PrDetails {
  const allowed: Record<MergeMethod, boolean> = {
    MERGE: node.repository.mergeCommitAllowed,
    SQUASH: node.repository.squashMergeAllowed,
    REBASE: node.repository.rebaseMergeAllowed,
  }
  return {
    headOid: node.headRefOid,
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    mergeable: node.mergeable,
    checks: (node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
    reviews: node.latestReviews.nodes.map((r) => ({ author: r.author?.login ?? null, state: r.state, submittedAt: r.submittedAt })),
    mergeMethods: MERGE_METHODS.filter((m) => allowed[m]),
    defaultMergeMethod: node.repository.viewerDefaultMergeMethod,
    viewerCanMergeAsAdmin: node.viewerCanMergeAsAdmin,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
  }
}

async function fetchAdvisoryDetails(id: string): Promise<ItemDetails> {
  const known = allItems().find((i) => i.id === id)
  if (!known) throw new HttpError(404, 'Item not found')
  const advisory = await rest('GET', `/repos/${known.repo}/security-advisories/${id}`, undefined).catch((err) => {
    if (err instanceof HttpError && err.status === 404) {
      deleteItem(id)
      throw new HttpError(404, 'Advisory not found, removed it from the dashboard')
    }
    throw err
  })
  const raw = JSON.parse(advisory)
  const item = advisoryItem(raw)
  upsertItems([item])
  const text: string = raw.description?.trim() || '_No description._'
  return {
    item: { ...item, readAt: readAt(id) },
    bodyHTML: await rest('POST', '/markdown', { text, mode: 'gfm', context: item.repo }),
    comments: [],
    totalComments: item.comments,
    viewerCanClose: false,
    pr: null,
  }
}

export async function fetchDetails(id: string): Promise<ItemDetails> {
  await ensureOrgMembers()
  if (isAdvisoryId(id)) return fetchAdvisoryDetails(id)
  const node = await graphql<{ node: DetailNode | null }>(DETAILS_QUERY, { id }).then(
    (data) => data.node,
    (err) => {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    },
  )
  if (!node?.repository || !isSyncedRepo(node.repository.nameWithOwner)) {
    deleteItem(id)
    throw new HttpError(404, 'Item not found, removed it from the dashboard')
  }
  const item = toItem(node.repository.nameWithOwner, node)
  upsertItems([item])
  return {
    item: { ...item, readAt: readAt(id) },
    bodyHTML: node.bodyHTML,
    comments: node.recentComments.nodes.map((c) => ({ author: c.author?.login ?? null, createdAt: c.createdAt, bodyHTML: c.bodyHTML, url: c.url })),
    totalComments: node.comments.totalCount,
    viewerCanClose: node.viewerCanClose,
    pr: item.type === 'pr' ? toPrDetails(node as PrNode) : null,
  }
}

export function parseIssueRef(ref: string, currentRepo: string): { owner: string; name: string; number: number } | null {
  const [currentOwner, currentName] = currentRepo.split('/')
  const short = ref.trim().match(/^(?:(?:([\w.-]+)\/)?([\w.-]+))?#(\d+)$/)
  if (short) return { owner: short[1] ?? currentOwner, name: short[2] ?? currentName, number: Number(short[3]) }
  const url = ref.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i)
  if (url) return { owner: url[1], name: url[2], number: Number(url[3]) }
  return null
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_COMMENT_LENGTH

export function parseAction(body: unknown): ItemAction {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object')
  const a = body as Record<string, unknown>
  if (a.comment !== undefined && !(typeof a.comment === 'string' && a.comment.length <= MAX_COMMENT_LENGTH)) {
    throw new HttpError(400, `comment must be a string of at most ${MAX_COMMENT_LENGTH} characters`)
  }
  const comment = a.comment as string | undefined
  switch (a.type) {
    case 'comment':
      if (!isText(a.body)) throw new HttpError(400, `body must be a non-empty string of at most ${MAX_COMMENT_LENGTH} characters`)
      return { type: 'comment', body: a.body }
    case 'close':
      if (!CLOSE_REASONS.includes(a.reason as string)) throw new HttpError(400, `reason must be one of ${CLOSE_REASONS.join(', ')}`)
      return { type: 'close', reason: a.reason as 'COMPLETED' | 'NOT_PLANNED', comment }
    case 'duplicate':
      if (typeof a.of !== 'string' || a.of.length > MAX_REF_LENGTH || !parseIssueRef(a.of, 'owner/repo')) {
        throw new HttpError(400, `of must be '#123', 'repo#123', 'owner/repo#123' or a https://github.com/<owner>/<repo>/issues/<number> URL`)
      }
      return { type: 'duplicate', of: a.of, comment }
    case 'merge':
      if (!MERGE_METHODS.includes(a.method as MergeMethod)) throw new HttpError(400, `method must be one of ${MERGE_METHODS.join(', ')}`)
      if (typeof a.expectedHeadOid !== 'string' || !/^[0-9a-f]{40}$/.test(a.expectedHeadOid)) throw new HttpError(400, 'expectedHeadOid must be a commit SHA')
      if (typeof a.force !== 'boolean') throw new HttpError(400, 'force must be a boolean')
      return { type: 'merge', method: a.method as MergeMethod, expectedHeadOid: a.expectedHeadOid, force: a.force }
    case 'review':
      if (!REVIEW_EVENTS.includes(a.event as ReviewEvent)) throw new HttpError(400, `event must be one of ${REVIEW_EVENTS.join(', ')}`)
      if (typeof a.expectedHeadOid !== 'string' || !/^[0-9a-f]{40}$/.test(a.expectedHeadOid)) throw new HttpError(400, 'expectedHeadOid must be a commit SHA')
      if (a.event === 'REQUEST_CHANGES' && !comment?.trim()) throw new HttpError(400, 'Requesting changes needs a comment')
      return { type: 'review', event: a.event as ReviewEvent, expectedHeadOid: a.expectedHeadOid, comment }
    case 'labels':
    case 'assignees':
    case 'reviewers': {
      const valid = { labels: (v: string) => v.trim() !== '' && v.length <= 100, assignees: (v: string) => LOGIN.test(v), reviewers: (v: string) => REVIEWER.test(v) }[a.type]
      const list = (key: 'add' | 'remove') => {
        const v = a[key]
        if (!Array.isArray(v) || v.length > MAX_LIST_ENTRIES || !v.every((x) => typeof x === 'string' && valid(x))) {
          throw new HttpError(400, `${key} must be an array of at most ${MAX_LIST_ENTRIES} valid ${a.type}`)
        }
        return [...new Set(v as string[])]
      }
      const add = list('add')
      const remove = list('remove')
      if (!add.length && !remove.length) throw new HttpError(400, 'add or remove must not be empty')
      if (add.some((v) => remove.includes(v))) throw new HttpError(400, 'add and remove must not overlap')
      return { type: a.type, add, remove }
    }
    default:
      throw new HttpError(400, 'type must be one of comment, close, duplicate, merge, review, labels, assignees, reviewers')
  }
}

const mutate = (query: string, variables: Record<string, unknown>) => graphql(query, variables, NO_RETRY)

async function addComment(subjectId: string, body: string | undefined): Promise<void> {
  if (!body?.trim()) return
  await mutate(`mutation($subjectId: ID!, $body: String!) { addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId } }`, { subjectId, body })
}

async function closeIssue(issueId: string, stateReason: string, duplicateIssueId: string | null = null): Promise<void> {
  await mutate(
    `mutation($issueId: ID!, $stateReason: IssueClosedStateReason!, $duplicateIssueId: ID) {
      closeIssue(input: { issueId: $issueId, stateReason: $stateReason, duplicateIssueId: $duplicateIssueId }) { clientMutationId }
    }`,
    { issueId, stateReason, duplicateIssueId },
  )
}

async function resolveIssueId(ref: string, currentRepo: string): Promise<string> {
  const { owner, name, number } = parseIssueRef(ref, currentRepo)!
  const data = await graphql<{ repository: { issue: { id: string } | null } | null }>(
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`,
    { owner, name, number },
  )
  const id = data.repository?.issue?.id
  if (!id) throw new HttpError(400, `Issue ${ref} not found`)
  return id
}

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }

async function paginate<T>(query: string, variables: Record<string, unknown>, page: (data: any) => Page<T> | null): Promise<T[]> {
  const nodes: T[] = []
  let cursor: string | null = null
  do {
    const p = page(await graphql(query, { ...variables, cursor }))
    if (!p) throw new HttpError(404, 'Repository not found')
    nodes.push(...p.nodes)
    cursor = p.pageInfo.hasNextPage ? p.pageInfo.endCursor : null
  } while (cursor)
  return nodes
}

const PAGE = 'pageInfo { hasNextPage endCursor }'

type Options = {
  labels: { id: string; name: string; color: string; description: string | null }[]
  users: { id: string; login: string }[]
  teams: { id: string; slug: string }[]
}

async function loadOptions(repo: string): Promise<Options> {
  const [owner, name] = repo.split('/')
  const vars = { owner, name }
  const [labels, users, teams] = await Promise.all([
    paginate<Options['labels'][number]>(
      `query($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { labels(first: 100, after: $cursor) { ${PAGE} nodes { id name color description } } } }`,
      vars,
      (d) => d.repository?.labels,
    ),
    paginate<Options['users'][number]>(
      `query($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { assignableUsers(first: 100, after: $cursor) { ${PAGE} nodes { id login } } } }`,
      vars,
      (d) => d.repository?.assignableUsers,
    ),
    paginate<Options['teams'][number]>(
      `query($org: String!, $cursor: String) { organization(login: $org) { teams(first: 100, after: $cursor) { ${PAGE} nodes { id slug } } } }`,
      { org: owner },
      (d) => d.organization?.teams,
    ).catch((err) => {
      if (err instanceof HttpError && err.status === 404) return []
      throw err
    }),
  ])
  return { labels, users, teams }
}

const optionsCache = new Map<string, { at: number; options: Promise<Options> }>()

function repoOptions(repo: string): Promise<Options> {
  const key = repo.toLowerCase()
  const cached = optionsCache.get(key)
  if (cached && Date.now() - cached.at < OPTIONS_TTL_MS) return cached.options
  const options = loadOptions(repo)
  optionsCache.set(key, { at: Date.now(), options })
  options.catch(() => optionsCache.delete(key))
  return options
}

export async function fetchRepoOptions(repo: string): Promise<RepoOptions> {
  if (!REPO_NAME.test(repo)) throw new HttpError(400, 'Invalid repository name')
  const { labels, users, teams } = await repoOptions(repo)
  return {
    labels: labels.map(({ name, color, description }) => ({ name, color, description })),
    assignees: users.map((u) => u.login),
    teams: teams.map((t) => t.slug),
  }
}

async function userId(login: string, options: Options): Promise<string> {
  const known = options.users.find((u) => u.login.toLowerCase() === login.toLowerCase())
  if (known) return known.id
  const data = await graphql<{ user: { id: string } | null }>(`query($login: String!) { user(login: $login) { id } }`, { login })
  if (!data.user) throw new HttpError(400, `Unknown user ${login}`)
  return data.user.id
}

async function teamId(slug: string, repo: string, options: Options): Promise<string> {
  const known = options.teams.find((t) => t.slug.toLowerCase() === slug.toLowerCase())
  if (known) return known.id
  const data = await graphql<{ organization: { team: { id: string } | null } | null }>(
    `query($org: String!, $slug: String!) { organization(login: $org) { team(slug: $slug) { id } } }`,
    { org: repo.split('/')[0], slug },
  )
  if (!data.organization?.team) throw new HttpError(400, `Unknown team ${slug}`)
  return data.organization.team.id
}

function labelIds(names: string[], options: Options): string[] {
  return names.map((name) => {
    const label = options.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())
    if (!label) throw new HttpError(400, `Unknown label ${name}`)
    return label.id
  })
}

export async function runAction(id: string, action: ItemAction): Promise<ItemDetails> {
  if (isAdvisoryId(id)) throw new HttpError(400, 'Security advisories can only be changed on GitHub')
  const details = await fetchDetails(id)
  const { item, pr } = details
  switch (action.type) {
    case 'comment':
      await addComment(id, action.body)
      break
    case 'close':
      await addComment(id, action.comment)
      if (item.type === 'pr') await mutate(`mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { clientMutationId } }`, { id })
      else await closeIssue(id, action.reason)
      break
    case 'duplicate': {
      if (item.type !== 'issue') throw new HttpError(400, 'Only issues can be closed as duplicate')
      const duplicateOf = await resolveIssueId(action.of, item.repo)
      if (duplicateOf === id) throw new HttpError(400, 'An issue cannot be a duplicate of itself')
      await addComment(id, action.comment)
      await closeIssue(id, 'DUPLICATE', duplicateOf)
      break
    }
    case 'merge': {
      if (!pr) throw new HttpError(400, 'Only pull requests can be merged')
      if (!pr.mergeMethods.includes(action.method)) throw new HttpError(400, `Merge method ${action.method} is not allowed, use one of ${pr.mergeMethods.join(', ')}`)
      if (pr.headOid !== action.expectedHeadOid) throw new HttpError(409, 'The pull request head changed since it was viewed', { headOid: pr.headOid })
      const blockers = mergeBlockers(details)
      if (blockers.hard.length || (blockers.soft.length && !action.force)) {
        throw new HttpError(409, `Merge blocked: ${[...blockers.hard, ...blockers.soft].join('; ')}`, { blockers })
      }
      await mutate(
        `mutation($id: ID!, $method: PullRequestMergeMethod!, $oid: GitObjectID!) {
          mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, expectedHeadOid: $oid }) { clientMutationId }
        }`,
        { id, method: action.method, oid: action.expectedHeadOid },
      )
      break
    }
    case 'review':
      if (!pr) throw new HttpError(400, 'Only pull requests can be reviewed')
      if (pr.headOid !== action.expectedHeadOid) throw new HttpError(409, 'The pull request head changed since it was viewed', { headOid: pr.headOid })
      await mutate(
        `mutation($id: ID!, $event: PullRequestReviewEvent!, $oid: GitObjectID!, $body: String) {
          addPullRequestReview(input: { pullRequestId: $id, event: $event, commitOID: $oid, body: $body }) { clientMutationId }
        }`,
        { id, event: action.event, oid: action.expectedHeadOid, body: action.comment?.trim() || null },
      )
      break
    case 'labels': {
      const options = await repoOptions(item.repo)
      const add = labelIds(action.add, options)
      const remove = labelIds(action.remove, options)
      if (add.length) await mutate(`mutation($id: ID!, $ids: [ID!]!) { addLabelsToLabelable(input: { labelableId: $id, labelIds: $ids }) { clientMutationId } }`, { id, ids: add })
      if (remove.length) await mutate(`mutation($id: ID!, $ids: [ID!]!) { removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $ids }) { clientMutationId } }`, { id, ids: remove })
      break
    }
    case 'assignees': {
      const options = await repoOptions(item.repo)
      const add = await Promise.all(action.add.map((l) => userId(l, options)))
      const remove = await Promise.all(action.remove.map((l) => userId(l, options)))
      if (add.length) await mutate(`mutation($id: ID!, $ids: [ID!]!) { addAssigneesToAssignable(input: { assignableId: $id, assigneeIds: $ids }) { clientMutationId } }`, { id, ids: add })
      if (remove.length) await mutate(`mutation($id: ID!, $ids: [ID!]!) { removeAssigneesFromAssignable(input: { assignableId: $id, assigneeIds: $ids }) { clientMutationId } }`, { id, ids: remove })
      break
    }
    case 'reviewers': {
      if (!pr) throw new HttpError(400, 'Only pull requests have reviewers')
      const isTeam = (r: string) => r.startsWith('team:')
      const slug = (r: string) => r.slice('team:'.length)
      const has = (r: string) => item.reviewRequests.some((x) => x.toLowerCase() === r.toLowerCase())
      const add = action.add.filter((r) => !has(r))
      const remove = action.remove.filter(has)
      if (add.length) {
        const options = await repoOptions(item.repo)
        const userIds = await Promise.all(add.filter((r) => !isTeam(r)).map((l) => userId(l, options)))
        const teamIds = await Promise.all(add.filter(isTeam).map((t) => teamId(slug(t), item.repo, options)))
        await mutate(
          `mutation($id: ID!, $userIds: [ID!], $teamIds: [ID!]) { requestReviews(input: { pullRequestId: $id, userIds: $userIds, teamIds: $teamIds, union: true }) { clientMutationId } }`,
          { id, userIds, teamIds },
        )
      }
      if (remove.length) {
        await rest('DELETE', `/repos/${item.repo}/pulls/${item.number}/requested_reviewers`, {
          reviewers: remove.filter((r) => !isTeam(r)),
          team_reviewers: remove.filter(isTeam).map(slug),
        })
      }
      break
    }
  }
  const updated = await fetchDetails(id)
  return { ...updated, item: { ...updated.item, readAt: markRead([id], true)[id] ?? null } }
}

export async function renderMarkdown(body: unknown): Promise<{ html: string }> {
  const { text, repo } = (body ?? {}) as Record<string, unknown>
  if (typeof text !== 'string' || text.length > MAX_COMMENT_LENGTH) throw new HttpError(400, `text must be a string of at most ${MAX_COMMENT_LENGTH} characters`)
  if (typeof repo !== 'string' || !REPO_NAME.test(repo)) throw new HttpError(400, 'Invalid repository name')
  return { html: await rest('POST', '/markdown', { text, mode: 'gfm', context: repo }) }
}
