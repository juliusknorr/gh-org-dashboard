import { mergeBlockers } from '../shared/merge.ts'
import type { Check, ItemAction, ItemDetails, MergeMethod, PrDetails, Review } from '../shared/types.ts'
import { upsertItems } from './db.ts'
import { COMMON_FIELDS, HttpError, ORG, PR_FIELDS, graphql, toItem, type RawNode } from './sync.ts'

const MAX_COMMENT_LENGTH = 65536
const MAX_REF_LENGTH = 200
const MERGE_METHODS: MergeMethod[] = ['MERGE', 'SQUASH', 'REBASE']
const CLOSE_REASONS = ['COMPLETED', 'NOT_PLANNED']
const NO_RETRY = 1

const DETAIL_FIELDS = `
  bodyHTML viewerCanClose
  repository { name owner { login } }
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
  ... on Issue { ${COMMON_FIELDS} ${DETAIL_FIELDS} }
  ... on PullRequest { ${COMMON_FIELDS} ${PR_FIELDS} ${DETAIL_FIELDS} ${PR_DETAIL_FIELDS} }
} }`

type CheckContext =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; status: string; detailsUrl: string | null }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null }

type DetailNode = RawNode & {
  bodyHTML: string
  viewerCanClose: boolean
  repository: { name: string; owner: { login: string } }
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

export async function fetchDetails(id: string): Promise<ItemDetails> {
  const { node } = await graphql<{ node: DetailNode | null }>(DETAILS_QUERY, { id })
  if (!node?.repository || node.repository.owner.login.toLowerCase() !== ORG.toLowerCase()) throw new HttpError(404, 'Item not found')
  const item = toItem(node.repository.name, node)
  upsertItems([item])
  return {
    item,
    bodyHTML: node.bodyHTML,
    comments: node.recentComments.nodes.map((c) => ({ author: c.author?.login ?? null, createdAt: c.createdAt, bodyHTML: c.bodyHTML, url: c.url })),
    totalComments: node.comments.totalCount,
    viewerCanClose: node.viewerCanClose,
    pr: item.type === 'pr' ? toPrDetails(node as PrNode) : null,
  }
}

function parseIssueRef(ref: string): { repo: string | null; number: number } | null {
  const short = ref.trim().match(/^([\w.-]+)?#(\d+)$/)
  if (short) return { repo: short[1] ?? null, number: Number(short[2]) }
  const url = ref.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?(?:[?#].*)?$/i)
  if (url && url[1].toLowerCase() === ORG.toLowerCase()) return { repo: url[2], number: Number(url[3]) }
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
      if (typeof a.of !== 'string' || a.of.length > MAX_REF_LENGTH || !parseIssueRef(a.of)) {
        throw new HttpError(400, `of must be '#123', 'repo#123' or a https://github.com/${ORG}/<repo>/issues/<number> URL`)
      }
      return { type: 'duplicate', of: a.of, comment }
    case 'merge':
      if (!MERGE_METHODS.includes(a.method as MergeMethod)) throw new HttpError(400, `method must be one of ${MERGE_METHODS.join(', ')}`)
      if (typeof a.expectedHeadOid !== 'string' || !/^[0-9a-f]{40}$/.test(a.expectedHeadOid)) throw new HttpError(400, 'expectedHeadOid must be a commit SHA')
      if (typeof a.force !== 'boolean') throw new HttpError(400, 'force must be a boolean')
      return { type: 'merge', method: a.method as MergeMethod, expectedHeadOid: a.expectedHeadOid, force: a.force }
    default:
      throw new HttpError(400, 'type must be one of comment, close, duplicate, merge')
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
  const { repo, number } = parseIssueRef(ref)!
  const data = await graphql<{ repository: { issue: { id: string } | null } | null }>(
    `query($org: String!, $repo: String!, $number: Int!) { repository(owner: $org, name: $repo) { issue(number: $number) { id } } }`,
    { org: ORG, repo: repo ?? currentRepo, number },
  )
  const id = data.repository?.issue?.id
  if (!id) throw new HttpError(400, `Issue ${ref} not found`)
  return id
}

export async function runAction(id: string, action: ItemAction): Promise<ItemDetails> {
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
  }
  return fetchDetails(id)
}
