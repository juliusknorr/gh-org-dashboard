import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { shellQuote } from './launch.ts'

test('shellQuote survives a round trip through sh', () => {
  for (const s of [`it's "quoted"`, '$(rm -rf ~) `id` $HOME', 'multi\nline\\', '']) {
    assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(s)}`], { encoding: 'utf8' }), s)
  }
})
