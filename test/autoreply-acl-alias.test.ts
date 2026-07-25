import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluatePolicy, getDefaultPolicy, type AutoReplyPolicy } from '../src/autoreply-store.js'

const LID_JID = '111222333444555@lid'
const PHONE_JID = '12025550100@s.whatsapp.net'

function autoPolicy(overrides: Partial<AutoReplyPolicy>): AutoReplyPolicy {
  return { ...getDefaultPolicy(), mode: 'auto', ...overrides }
}

test('blocklist entry matches a message arriving under an aliased JID form', () => {
  const policy = autoPolicy({ blocklist: [PHONE_JID] })
  const decision = evaluatePolicy(policy, {
    chat_jid: LID_JID,
    chat_jid_aliases: [LID_JID, PHONE_JID],
    is_group: false,
  })
  assert.equal(decision.active, false)
  assert.equal(decision.reason, 'chat is blocklisted')
})

test('blocklist entry as a bare phone number matches via alias expansion', () => {
  const policy = autoPolicy({ blocklist: ['12025550100'] })
  const decision = evaluatePolicy(policy, {
    chat_jid: LID_JID,
    chat_jid_aliases: [LID_JID, PHONE_JID],
    is_group: false,
  })
  assert.equal(decision.active, false)
  assert.equal(decision.reason, 'chat is blocklisted')
})

test('exact-form blocklist matching still works without aliases', () => {
  const policy = autoPolicy({ blocklist: [PHONE_JID] })
  const decision = evaluatePolicy(policy, { chat_jid: PHONE_JID, is_group: false })
  assert.equal(decision.active, false)
  assert.equal(decision.reason, 'chat is blocklisted')
})

test('non-blocklisted chat stays active regardless of aliases', () => {
  const policy = autoPolicy({ blocklist: ['12025550199@s.whatsapp.net'] })
  const decision = evaluatePolicy(policy, {
    chat_jid: LID_JID,
    chat_jid_aliases: [LID_JID, PHONE_JID],
    is_group: false,
  })
  assert.equal(decision.active, true)
})

test('contacts allowlist matches through an aliased JID form', () => {
  const policy = autoPolicy({ scope: 'contacts', contacts: [PHONE_JID] })
  const allowed = evaluatePolicy(policy, {
    chat_jid: LID_JID,
    chat_jid_aliases: [LID_JID, PHONE_JID],
    is_group: false,
  })
  assert.equal(allowed.active, true)

  const denied = evaluatePolicy(policy, {
    chat_jid: '999999999@lid',
    chat_jid_aliases: ['999999999@lid', '4900000000@s.whatsapp.net'],
    is_group: false,
  })
  assert.equal(denied.active, false)
  assert.equal(denied.reason, 'chat is outside configured scope')
})
