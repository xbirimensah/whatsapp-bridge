import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectTextLanguage,
  findOffLanguageFillers,
  isReplyLanguageCompatible,
  resolveChatLanguage,
} from '../src/autoreply-language.js'
import { enforceDraftLanguage } from '../src/autoreply-generate.js'
import { evaluateAutoSendSafety, isTrivialAcknowledgement } from '../src/autoreply-safety.js'
import { shouldRetrieveStyleExamples } from '../src/autoreply-style-rag.js'

test('uses recent operator replies to resolve a short German chat message', () => {
  assert.equal(detectTextLanguage('ich bin morgen da'), 'de')
  assert.equal(resolveChatLanguage('passt?', ['ja klar', 'ich bin morgen da', 'bis später']), 'de')
  assert.equal(resolveChatLanguage('yo?', [
    { body: 'mhm', language: 'de' },
    { body: 'jo', language: 'de' },
  ]), 'de')
})

test('flags Portuguese filler in a German or English draft', () => {
  assert.deepEqual(findOffLanguageFillers('isso', 'de'), ['isso'])
  assert.deepEqual(findOffLanguageFillers('isso, sounds good', 'en'), ['isso'])
  assert.deepEqual(findOffLanguageFillers('ja passt', 'de'), [])
  assert.equal(isReplyLanguageCompatible('isso', 'de'), false)
  assert.equal(isReplyLanguageCompatible('ja passt', 'de'), true)
})

test('blocks an off-language generated reply from auto-send while retaining it for review', () => {
  const result = enforceDraftLanguage({
    reply: 'isso, passt', confidence: 0.92, should_send: true, needs_review: false, reasons: [],
  }, 'de')
  assert.equal(result.reply, 'isso, passt')
  assert.equal(result.should_send, false)
  assert.equal(result.needs_review, true)
  assert.deepEqual(result.reasons, ['off_language_filler'])
})

test('language safety is lexical across casing and punctuation at the send boundary', () => {
  assert.equal(isReplyLanguageCompatible('ISSO!!!', 'de'), false)
  const decision = evaluateAutoSendSafety({
    chatJid: '12025550100@s.whatsapp.net',
    messageId: 'language-boundary-test',
    incomingText: 'ich bin gleich da',
    draft: { reply: 'ISSO!!!', confidence: 0.99, should_send: true, needs_review: false, reasons: [] },
    isGroup: false,
    chatLanguage: 'de',
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.reasons.includes('generated draft language is incompatible with chat language'))
})

test('generated trivial acknowledgements are never eligible for text auto-send', () => {
  assert.equal(isTrivialAcknowledgement('OK!!! 👍'), true)
  const decision = evaluateAutoSendSafety({
    chatJid: '12025550101@s.whatsapp.net',
    messageId: 'trivial-draft-test',
    incomingText: 'can you call me later?',
    draft: { reply: 'OK!!! 👍', confidence: 0.99, should_send: true, needs_review: false, reasons: [] },
    isGroup: false,
    chatLanguage: 'en',
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.reasons.includes('generated draft is a trivial acknowledgement'))
})

test('lets contextual acknowledgement continuations pass the final safety gate', () => {
  assert.equal(isTrivialAcknowledgement('Nice brother'), true)
  const decision = evaluateAutoSendSafety({
    chatJid: '12025550102@s.whatsapp.net',
    messageId: 'contextual-ack-test',
    incomingText: 'Nice brother',
    draft: { reply: 'love bro. how did the client call end up going?', confidence: 0.99, should_send: true, needs_review: false, reasons: [] },
    isGroup: false,
    chatLanguage: 'en',
  })
  assert.equal(decision.ok, true)
})

test('generated emoji-only replies cannot auto-send as text and require an explicit native reaction', () => {
  const decision = evaluateAutoSendSafety({
    chatJid: '12025550101@s.whatsapp.net',
    messageId: 'emoji-only-draft-test',
    incomingText: 'good news!',
    draft: { reply: '👍', confidence: 0.99, should_send: true, needs_review: false, reasons: [] },
    isGroup: false,
    chatLanguage: 'en',
  })
  assert.equal(decision.ok, false)
  assert.ok(decision.reasons.includes('emoji-only reply requires explicit native reaction'))
})

test('never performs broad style retrieval when chat language is unknown', () => {
  assert.equal(shouldRetrieveStyleExamples('unknown'), false)
  assert.equal(shouldRetrieveStyleExamples('de'), true)
  assert.equal(shouldRetrieveStyleExamples('en'), true)
})
