import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAutoSendSafety } from '../src/autoreply-safety.js'

function decisionFor(reply: string) {
  return evaluateAutoSendSafety({
    chatJid: '12025550103@s.whatsapp.net',
    messageId: `commitment-${reply}`,
    incomingText: 'Can you let me know?',
    draft: { reply, confidence: 0.99, should_send: true, needs_review: false, reasons: [] },
    isGroup: false,
    chatLanguage: 'en',
  })
}

test('requires review when an auto-reply commits the operator to availability or a meeting', () => {
  for (const reply of [
    'I can make it at 4pm.',
    'I will join the call tomorrow.',
    'Let’s schedule a meeting for Friday.',
    'I am available this afternoon.',
  ]) {
    const decision = decisionFor(reply)
    assert.equal(decision.ok, false, reply)
    assert.ok(decision.reasons.includes('generated draft makes an availability or meeting commitment'), reply)
  }
})

test('requires review when an auto-reply commits the operator to a commercial term', () => {
  for (const reply of [
    'The price is $2,000.',
    'I can offer you a discount.',
    'I will send the invoice today.',
    'We can refund that payment.',
  ]) {
    const decision = decisionFor(reply)
    assert.equal(decision.ok, false, reply)
    assert.ok(decision.reasons.includes('generated draft makes a commercial commitment'), reply)
  }
})

test('leaves non-committal factual replies eligible when other gates pass', () => {
  const decision = decisionFor('I’ll take a look and get back to you.')
  assert.equal(decision.reasons.includes('generated draft makes an availability or meeting commitment'), false)
  assert.equal(decision.reasons.includes('generated draft makes a commercial commitment'), false)
})
