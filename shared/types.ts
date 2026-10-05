export type ItemType = 'issue' | 'pr' | 'advisory'
export type ItemState = 'open' | 'closed' | 'merged'
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
export type CiState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null

export interface Item {
  id: string
  type: ItemType
  repo: string
  number: number
  title: string
  url: string
  state: ItemState
  draft: boolean
  author: string | null
  member: boolean
  bot: boolean
  assignees: string[]
  labels: { name: string; color: string }[]
  milestone: string | null
  reviewRequests: string[]
  reviewDecision: ReviewDecision
  ci: CiState
  comments: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
  firstReviewAt: string | null
  triagedAt: string | null
  triagedBy: string | null
}

export interface SyncStatus {
  running: boolean
  lastSyncAt: string | null
  error: string | null
}

export interface ItemsResponse {
  presets: Record<string, string[]>
  items: Item[]
  sync: SyncStatus
}

export interface SavedView {
  name: string
  search: string
  preset: string | null
}

export interface LaunchRequest {
  id: string
  prompt: string
  worktree: boolean
  remoteControl: boolean
  dryRun?: boolean
}

export interface LaunchResponse {
  command: string
  dir: string
  launched: boolean
}

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE'

export interface Comment {
  author: string | null
  createdAt: string
  bodyHTML: string
  url: string
}

export interface Review {
  author: string | null
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  submittedAt: string | null
}

export interface Check {
  name: string
  conclusion: string | null
  url: string | null
}

export interface PrDetails {
  headOid: string
  headRef: string
  baseRef: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  checks: Check[]
  reviews: Review[]
  mergeMethods: MergeMethod[]
  defaultMergeMethod: MergeMethod
  viewerCanMergeAsAdmin: boolean
  additions: number
  deletions: number
  changedFiles: number
}

export interface ItemDetails {
  item: Item
  bodyHTML: string
  comments: Comment[]
  totalComments: number
  viewerCanClose: boolean
  pr: PrDetails | null
}

export type ItemAction =
  | { type: 'comment'; body: string }
  | { type: 'close'; reason: 'COMPLETED' | 'NOT_PLANNED'; comment?: string }
  | { type: 'duplicate'; of: string; comment?: string }
  | { type: 'merge'; method: MergeMethod; expectedHeadOid: string; force: boolean }
  | { type: 'labels'; add: string[]; remove: string[] }
  | { type: 'assignees'; add: string[]; remove: string[] }
  | { type: 'reviewers'; add: string[]; remove: string[] }

export interface RepoOptions {
  labels: { name: string; color: string; description: string | null }[]
  assignees: string[]
  teams: string[]
}
