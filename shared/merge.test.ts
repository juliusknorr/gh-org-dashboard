import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeBlockers } from './merge.ts'
import type { Item, ItemDetails, PrDetails } from './types.ts'

const details = (item: Partial<Item> = {}, pr: Partial<PrDetails> = {}): ItemDetails => ({
  item: { type: 'pr', state: 'open', draft: false, ci: 'SUCCESS', reviewDecision: 'APPROVED', ...item } as Item,
  bodyHTML: '',
  comments: [],
  totalComments: 0,
  viewerCanClose: true,
  pr: { mergeable: 'MERGEABLE', reviews: [], ...pr } as PrDetails,
})

test('mergeBlockers', () => {
  assert.deepEqual(mergeBlockers(details()), { hard: [], soft: [] })
  assert.deepEqual(mergeBlockers(details({ reviewDecision: null }, { reviews: [{ author: 'a', state: 'APPROVED', submittedAt: null }] })), { hard: [], soft: [] })
  assert.deepEqual(mergeBlockers(details({ reviewDecision: null, ci: null })), { hard: [], soft: ['No CI results', 'Not approved'] })
  assert.deepEqual(mergeBlockers(details({ ci: 'FAILURE', reviewDecision: 'CHANGES_REQUESTED' })).soft, ['CI is failure', 'Changes requested'])
  assert.deepEqual(mergeBlockers(details({ draft: true }, { mergeable: 'CONFLICTING' })).hard, ['Pull request is a draft', 'Merge conflicts with the base branch'])
})
