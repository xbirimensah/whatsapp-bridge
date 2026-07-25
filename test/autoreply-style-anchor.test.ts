import assert from 'node:assert/strict'
import test from 'node:test'

import { formatStyleAnchor } from '../src/autoreply-context.js'
import { COMPACT_STYLE_GUIDE } from '../src/autoreply-style-rag.js'

test('returns empty string when there are no operator messages', () => {
  assert.equal(formatStyleAnchor([]), '')
  assert.equal(formatStyleAnchor(['', '   ', '\n']), '')
})

test('renders verbatim messages as a labeled bullet list', () => {
  const anchor = formatStyleAnchor(['digga, was labbert er den?', 'ja ja ja'])
  assert.match(anchor, /verbatim recent messages/)
  assert.match(anchor, /- digga, was labbert er den\?/)
  assert.match(anchor, /- ja ja ja/)
})

test('collapses whitespace and truncates long messages to the row cap', () => {
  const long = `a${'b'.repeat(200)}`
  const anchor = formatStyleAnchor([`hey\n\n  du   da`, long])
  assert.match(anchor, /- hey du da/)
  const longLine = anchor.split('\n').find((line) => line.startsWith('- ab'))
  assert.ok(longLine)
  assert.equal(longLine.length, '- '.length + 90)
})

test('drops rows that become empty after cleaning but keeps the rest', () => {
  const anchor = formatStyleAnchor(['  ', 'easy'])
  const bullets = anchor.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 1)
  assert.equal(bullets[0], '- easy')
})

test('style guide bans the comma-appended acknowledgment opener pattern', () => {
  assert.match(COMPACT_STYLE_GUIDE, /BANNED pattern/)
  assert.match(COMPACT_STYLE_GUIDE, /"top,"/)
  assert.match(COMPACT_STYLE_GUIDE, /1-6 words/)
  assert.match(COMPACT_STYLE_GUIDE, /lowercase starts/)
})
