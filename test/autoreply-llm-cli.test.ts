import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Claude CLI drafting does not pass an empty setting-sources argument', () => {
  const source = readFileSync(new URL('../src/autoreply-llm.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(
    source,
    /'--setting-sources',\s*''/,
    'an empty setting-sources value makes Claude CLI wait for stdin and prevents auto-replies',
  )
})
