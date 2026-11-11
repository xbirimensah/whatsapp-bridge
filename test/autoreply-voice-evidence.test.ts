import assert from 'node:assert/strict'
import test from 'node:test'

import { applicableVoiceCorrections } from '../src/autoreply-feedback.js'
import { enforceVoiceEvidence, type DraftReply } from '../src/autoreply-generate.js'

const confidentDraft: DraftReply = {
  reply: 'bin gleich da',
  confidence: 0.95,
  should_send: true,
  needs_review: false,
  reasons: [],
}

test('holds an otherwise sendable draft when the chat has no human voice evidence', () => {
  const result = enforceVoiceEvidence(confidentDraft, [])

  assert.equal(result.should_send, false)
  assert.equal(result.needs_review, true)
  assert.deepEqual(result.reasons, ['no_same_chat_human_voice_evidence'])
})

test('preserves a sendable draft when this chat has human-written examples', () => {
  assert.deepEqual(enforceVoiceEvidence(confidentDraft, ['bin unterwegs']), confidentDraft)
})

test('returns only corrective feedback for the exact session and chat', () => {
  const corrections = applicableVoiceCorrections([
    { session: 'main', chat_jid: 'a@s.whatsapp.net', draft_reply: 'top, danke dir', correction: 'ja passt, ich meld mich später', outcome: 'corrected' },
    { session: 'main', chat_jid: 'b@s.whatsapp.net', draft_reply: 'top, danke dir', correction: 'danke dir', outcome: 'corrected' },
    { session: 'other', chat_jid: 'a@s.whatsapp.net', draft_reply: 'top, danke dir', correction: 'passt', outcome: 'rejected' },
    { session: 'main', chat_jid: 'a@s.whatsapp.net', draft_reply: 'ja', correction: 'ja', outcome: 'accepted' },
  ], { session: 'main', chatJids: ['a@s.whatsapp.net'] })

  assert.deepEqual(corrections, [
    'Avoid: top, danke dir\nPrefer: ja passt, ich meld mich später',
  ])
})
