export type LocationInput = {
  latitude: number
  longitude: number
  name?: string
  address?: string
}

export type ContactInput = {
  displayName: string
  phone: string
}

export type PollInput = {
  name: string
  options: string[]
  selectableCount?: number
}

export type ReactionInput = {
  chatJid: string
  messageId: string
  emoji: string
}

const MAX_LOCATION_TEXT = 1024
const MAX_POLL_NAME = 255
const MAX_POLL_OPTION = 100

function boundedText(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > max) throw new Error(`${field} must be at most ${max} characters`)
  return normalized
}

export function parseMessageId(id: string, session: string): string {
  const prefix = `${session}:`
  const parsed = id.startsWith(prefix) ? id.slice(prefix.length) : id
  if (!parsed) throw new Error('message_id is required')
  return parsed
}

// Reactions are native WhatsApp operations, not tiny text messages. Keeping
// the target fields together makes the invariant explicit at the lowest
// shared layer: an emoji is never enough to construct a reaction payload.
export function buildReactionPayload(input: ReactionInput) {
  const remoteJid = input.chatJid.trim()
  const id = input.messageId.trim()
  if (!remoteJid || !id) throw new Error('reaction requires chat_jid and message_id')
  if (typeof input.emoji !== 'string') throw new Error('reaction emoji must be a string')
  return { react: { text: input.emoji, key: { remoteJid, id, fromMe: false } } }
}

export function buildLocationPayload(input: LocationInput) {
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    throw new Error('latitude must be between -90 and 90')
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    throw new Error('longitude must be between -180 and 180')
  }
  return {
    location: {
      degreesLatitude: input.latitude,
      degreesLongitude: input.longitude,
      ...(boundedText(input.name, 'name', MAX_LOCATION_TEXT) ? { name: boundedText(input.name, 'name', MAX_LOCATION_TEXT) } : {}),
      ...(boundedText(input.address, 'address', MAX_LOCATION_TEXT) ? { address: boundedText(input.address, 'address', MAX_LOCATION_TEXT) } : {}),
    },
  }
}

export function buildContactPayload(input: ContactInput) {
  const displayName = boundedText(input.displayName, 'display_name', 255)!
  const digits = input.phone.replace(/[^0-9+]/g, '')
  if (!/^\+?[1-9]\d{5,14}$/.test(digits)) throw new Error('phone must be a valid international phone number')
  const phone = digits.startsWith('+') ? digits : `+${digits}`
  const escapedName = displayName.replace(/[\r\n]/g, ' ').replace(/;/g, '\\;').replace(/,/g, '\\,')
  return {
    contacts: {
      displayName,
      contacts: [{ displayName, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${escapedName}\nTEL;type=CELL:${phone}\nEND:VCARD` }],
    },
  }
}

export function buildPollPayload(input: PollInput) {
  const name = boundedText(input.name, 'poll name', MAX_POLL_NAME)!
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 12) {
    throw new Error('poll options must contain 2 to 12 entries')
  }
  const values = input.options.map((option, index) => boundedText(option, `poll option ${index + 1}`, MAX_POLL_OPTION)!)
  if (new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length) {
    throw new Error('poll options must be unique')
  }
  const selectableCount = input.selectableCount ?? 1
  if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > values.length) {
    throw new Error('selectable_count must be between 1 and the number of options')
  }
  return { poll: { name, values, selectableCount } }
}

export function buildVoicePayload(data: Buffer, mime = 'audio/ogg; codecs=opus') {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('voice note data is required')
  return { audio: data, mimetype: mime, ptt: true }
}
