import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAutoSendSafety, isMeaningfullyRepetitiveReply } from '../src/autoreply-safety.js'

const previous = ['I will take a proper look at that now']

test('detects exact and stock-opening repetition in substantive sidecar replies', () => {
  assert.equal(isMeaningfullyRepetitiveReply('I will take a proper look at that now', previous), true)
  assert.equal(isMeaningfullyRepetitiveReply('I will take a different look at this tomorrow', previous), true)
  assert.equal(isMeaningfullyRepetitiveReply('Let me check the details and come back to you', previous), false)
})

test('holds a repetitive draft for review rather than auto-sending it', () => {
  const decision = evaluateAutoSendSafety({
    chatJid: '12025550104@s.whatsapp.net',
    messageId: 'repetition-boundary-test',
    incomingText: 'Can you check this?',
    draft: {
      reply: 'I will take a proper look at that now',
      confidence: 0.99,
      should_send: true,
      needs_review: false,
      reasons: [],
    },
    isGroup: false,
    chatLanguage: 'en',
    recentGeneratedReplies: previous,
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.reasons.includes('generated draft repeats a recent sidecar reply in this chat'))
})

test('does not treat normal short replies as repetition', () => {
  assert.equal(isMeaningfullyRepetitiveReply('sure', ['sure thing']), false)
})

test('detects a draft that parrots a recent operator-written phrase', () => {
  assert.equal(
    isMeaningfullyRepetitiveReply(
      'haha nice one bro, doing good man, same thing, AIs and systems, how about you',
      ['doing good, you?'],
    ),
    true,
  )
})
