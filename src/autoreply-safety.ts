import {
  AUTOREPLY_ALLOW_GROUP_AUTO,
  AUTOREPLY_AUTO_SEND_COOLDOWN_MS,
  AUTOREPLY_DEFAULT_SESSION,
  AUTOREPLY_MIN_CONFIDENCE,
} from './autoreply-env.js'
import { type DraftReply } from './autoreply-generate.js'
import { hasDraftForMessage, hasRecentAutoSend } from './autoreply-store.js'
import { expandJidGroup } from './db.js'

// The cooldown must hold across JID forms of the same chat (@lid vs
// @s.whatsapp.net), otherwise a chat switching forms mid-conversation would
// dodge it.
function cooldownJids(session: string | null | undefined, chatJid: string | null | undefined): string[] {
  if (!chatJid) return []
  try {
    return expandJidGroup(session?.trim() || AUTOREPLY_DEFAULT_SESSION, chatJid)
  } catch {
    return [chatJid]
  }
}

const SENSITIVE_PATTERNS = [
  /\b(invoice|payment|paid|bank|iban|wire|refund|salary|budget|price|quote|contract|legal|lawyer|tax)\b/i,
  /\b(doctor|hospital|emergency|urgent|accident|police|passport|visa|address|otp|code|password)\b/i,
  /\b(schedule|reschedule|tomorrow|today|friday|monday|am|pm|calendar|meeting)\b/i,
]

// These messages close a loop or simply acknowledge that something worked.
// Obiri wants to answer them personally (or let them end naturally), rather
// than having the autoreply manufacture one more message.
const TRIVIAL_ACKNOWLEDGEMENT_PATTERNS = [
  /^(?:yeah|yep|yup|yes|ok(?:ay)?|alright|sure|got it|makes sense|perfect|great|cool|nice|thanks|thank you|thx)[.!\s👍✅👌🙂]*$/i,
  /^(?:yeah[,.\s]+)?i can hear you(?: now)?[.!\s👍✅👌🙂]*$/i,
  /^(?:ja|jep|okay|ok|alles klar|verstanden|passt|perfekt|mega|danke|dankeschön)[.!\s👍✅👌🙂]*$/i,
  /^(?:ja[,.\s]+)?ich kann dich hören(?: jetzt)?[.!\s👍✅👌🙂]*$/i,
]

export type AutoSendSafetyDecision = {
  ok: boolean
  reasons: string[]
}

export function isTrivialAcknowledgement(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ')
  return TRIVIAL_ACKNOWLEDGEMENT_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function evaluateAutoSendSafety(params: {
  session?: string | null
  chatJid?: string | null
  messageId?: string | null
  incomingText: string
  draft: DraftReply
  isGroup: boolean
}): AutoSendSafetyDecision {
  const reasons: string[] = []
  const text = params.incomingText.trim()

  if (!params.chatJid) reasons.push('missing chat_jid')
  if (!params.messageId) reasons.push('missing inbound message id')
  if (params.isGroup && !AUTOREPLY_ALLOW_GROUP_AUTO) reasons.push('group auto-send disabled')
  if (!text) reasons.push('incoming text empty')
  if (text.length > 280) reasons.push('incoming message too long for safe auto-send')
  if ((text.match(/\n/g) ?? []).length >= 2) reasons.push('incoming message spans multiple lines')
  if (params.draft.reply.trim().length === 0) reasons.push('draft reply empty')
  if (params.draft.reply.trim().length > 280) reasons.push('draft reply too long')
  if (params.draft.confidence < AUTOREPLY_MIN_CONFIDENCE) reasons.push('confidence below minimum threshold')
  if (!params.draft.should_send) reasons.push('model marked reply as should_send=false')
  if (params.draft.needs_review) reasons.push('model marked reply as needs_review=true')
  if (params.messageId && hasDraftForMessage(params.messageId)) reasons.push('message already processed into a draft')
  if (hasRecentAutoSend(cooldownJids(params.session, params.chatJid), AUTOREPLY_AUTO_SEND_COOLDOWN_MS)) reasons.push('recent auto-send cooldown still active for this chat')
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('message matches a sensitive-topic safety pattern')

  return { ok: reasons.length === 0, reasons }
}
