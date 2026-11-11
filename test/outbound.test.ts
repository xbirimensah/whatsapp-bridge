import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContactPayload,
  buildLocationPayload,
  buildPollPayload,
  buildReactionPayload,
  buildVoicePayload,
  parseMessageId,
} from '../src/outbound.js'

test('builds a WhatsApp location payload with optional address details', () => {
  assert.deepEqual(
    buildLocationPayload({ latitude: 51.4818, longitude: 7.2162, name: 'Bochum Hbf', address: 'Kurt-Schumacher-Platz 13' }),
    { location: { degreesLatitude: 51.4818, degreesLongitude: 7.2162, name: 'Bochum Hbf', address: 'Kurt-Schumacher-Platz 13' } },
  )
})

test('rejects unsafe latitude and longitude values', () => {
  assert.throws(() => buildLocationPayload({ latitude: 91, longitude: 7 }), /latitude/i)
  assert.throws(() => buildLocationPayload({ latitude: 51, longitude: -181 }), /longitude/i)
})

test('builds a contact card with a sanitized vCard', () => {
  const payload = buildContactPayload({ displayName: 'Ada Lovelace', phone: '+49 151 1234567' })
  assert.equal(payload.contacts.displayName, 'Ada Lovelace')
  assert.match(payload.contacts.contacts[0].vcard, /TEL;type=CELL:\+491511234567/)
  assert.deepEqual(payload.contacts.contacts[0].vcard.split('\n'), [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace', 'TEL;type=CELL:+491511234567', 'END:VCARD',
  ])
})

test('builds a WhatsApp poll and enforces WhatsApp option limits', () => {
  assert.deepEqual(buildPollPayload({ name: 'Where?', options: ['Park', 'Cafe'], selectableCount: 1 }), {
    poll: { name: 'Where?', values: ['Park', 'Cafe'], selectableCount: 1 },
  })
  assert.throws(() => buildPollPayload({ name: 'No', options: ['only one'] }), /2 to 12/i)
})

test('marks an audio payload as a voice note', () => {
  const data = Buffer.from('voice')
  assert.deepEqual(buildVoicePayload(data, 'audio/ogg; codecs=opus'), {
    audio: data,
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  })
})

test('normalizes bridge-local message IDs to native WhatsApp IDs', () => {
  assert.equal(parseMessageId('main:ABC', 'main'), 'ABC')
  assert.equal(parseMessageId('ABC', 'main'), 'ABC')
})

test('builds reactions only as native operations bound to a chat and message target', () => {
  assert.deepEqual(buildReactionPayload({ chatJid: '12025550100@s.whatsapp.net', messageId: 'ABC', emoji: '👍' }), {
    react: { text: '👍', key: { remoteJid: '12025550100@s.whatsapp.net', id: 'ABC', fromMe: false } },
  })
  assert.throws(() => buildReactionPayload({ chatJid: '', messageId: 'ABC', emoji: '👍' }), /chat_jid/i)
  assert.throws(() => buildReactionPayload({ chatJid: '12025550100@s.whatsapp.net', messageId: '', emoji: '👍' }), /message_id/i)
})
