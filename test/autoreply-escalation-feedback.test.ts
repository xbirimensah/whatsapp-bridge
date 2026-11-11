import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'wa-autoreply-test-'))
process.env.AUTOREPLY_DATA_DIR = dataDir

const { attemptEscalation, writeEscalationConfig } = await import('../src/autoreply-escalation.js')
const { listFeedback, recordFeedback } = await import('../src/autoreply-feedback.js')

test.after(() => rmSync(dataDir, { recursive: true, force: true }))

test('escalation is opt-in and fails closed when no transport is configured', async () => {
  writeEscalationConfig({ enabled: false, cooldown_ms: 60_000, max_per_hour: 2 })
  let delivered = false
  const disabled = await attemptEscalation({
    session: 'main', chat_jid: 'one@s.whatsapp.net', message_id: 'm1', reason: 'review', payload: {},
  }, async () => { delivered = true; return true }, true)
  assert.deepEqual(disabled, { attempted: false, delivered: false, reason: 'disabled' })
  assert.equal(delivered, false)

  writeEscalationConfig({ enabled: true, cooldown_ms: 60_000, max_per_hour: 2 })
  const unconfigured = await attemptEscalation({
    session: 'main', chat_jid: 'one@s.whatsapp.net', message_id: 'm2', reason: 'review', payload: {},
  }, async () => { delivered = true; return true }, false)
  assert.deepEqual(unconfigured, { attempted: false, delivered: false, reason: 'transport_unconfigured' })
  assert.equal(delivered, false)
})

test('escalation is audited, delivered through the injected configured transport, and rate limited', async () => {
  writeEscalationConfig({ enabled: true, cooldown_ms: 60_000, max_per_hour: 2 })
  let calls = 0
  const input = { session: 'main', chat_jid: 'two@s.whatsapp.net', message_id: 'm3', reason: 'review', payload: { incoming_text: 'private' } }
  const first = await attemptEscalation(input, async () => { calls += 1; return true }, true)
  const second = await attemptEscalation({ ...input, message_id: 'm4' }, async () => { calls += 1; return true }, true)
  assert.deepEqual(first, { attempted: true, delivered: true, reason: 'delivered' })
  assert.deepEqual(second, { attempted: false, delivered: false, reason: 'cooldown' })
  assert.equal(calls, 1)
  const audit = readFileSync(join(dataDir, 'audit.ndjson'), 'utf8')
  assert.match(audit, /escalation_queued/)
  assert.match(audit, /escalation_delivered/)
  assert.match(audit, /escalation_skipped/)
})

test('operator feedback is bounded, private, and only metadata is audited', () => {
  const entry = recordFeedback({
    session: 'main', chat_jid: 'three@s.whatsapp.net', message_id: 'm5', draft_reply: 'draft text',
    correction: 'operator correction', outcome: 'corrected', note: 'keep it shorter',
  })
  assert.equal(listFeedback(1)[0]?.id, entry.id)
  const audit = readFileSync(join(dataDir, 'audit.ndjson'), 'utf8')
  assert.match(audit, /feedback_recorded/)
  assert.doesNotMatch(audit, /operator correction/)
})

test('operator feedback rejects unrecognized outcomes instead of accepting arbitrary policy signals', () => {
  assert.throws(() => recordFeedback({
    session: 'main', chat_jid: 'three@s.whatsapp.net', message_id: 'm6', draft_reply: 'draft',
    correction: 'correction', outcome: 'auto_apply' as never, note: null,
  }), /outcome/i)
})
