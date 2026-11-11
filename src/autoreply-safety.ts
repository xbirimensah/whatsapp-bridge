import {
  AUTOREPLY_ALLOW_GROUP_AUTO,
  AUTOREPLY_AUTO_SEND_COOLDOWN_MS,
  AUTOREPLY_DEFAULT_SESSION,
  AUTOREPLY_MIN_CONFIDENCE,
} from './autoreply-env.js'
import { type DraftReply } from './autoreply-generate.js'
import { hasAutoSentForMessage, hasRecentAutoSend } from './autoreply-store.js'
import { db, expandJidGroup } from './db.js'
import { isReplyLanguageCompatible, type ChatLanguage } from './autoreply-language.js'

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

// Compare a draft against all recent outbound text from this chat, not only
// previous agent sends. Otherwise the sidecar can paraphrase or repeat the
// operator's own just-sent greeting/question, which looks immediately fake.
function recentOutboundReplies(session: string | null | undefined, chatJid: string | null | undefined): string[] {
  const jids = cooldownJids(session, chatJid)
  if (jids.length === 0) return []
  try {
    const placeholders = jids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT body FROM messages
      WHERE session = ? AND chat_jid IN (${placeholders})
        AND direction = 'out'
        AND body IS NOT NULL AND TRIM(body) != ''
      ORDER BY ts DESC LIMIT 16
    `).all(session?.trim() || AUTOREPLY_DEFAULT_SESSION, ...jids) as Array<{ body: string }>
    return rows.map((row) => row.body)
  } catch {
    return []
  }
}

const REPETITION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'can', 'das', 'der', 'die', 'doch', 'ein', 'eine', 'es', 'for', 'i', 'ich', 'im', 'in', 'is', 'it', 'ja', 'mal', 'mir', 'of', 'ok', 'so', 'the', 'to', 'und', 'we', 'with', 'you',
])

function meaningfulTokens(text: string): string[] {
  return text.normalize('NFKC').toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.filter((token) => token.length > 1 && !REPETITION_STOP_WORDS.has(token)) ?? []
}

export function isMeaningfullyRepetitiveReply(candidate: string, recentReplies: string[]): boolean {
  const normalized = candidate.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!normalized) return false
  for (const previous of recentReplies) {
    const prior = previous.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    if (prior && prior === normalized) return true

    const candidateTokens = meaningfulTokens(candidate)
    const priorTokens = meaningfulTokens(previous)
    // Do not let a draft restate even a short operator-written phrase such as
    // "doing good, you?" in a new message. It is a common context-miss mode.
    if (candidateTokens.length >= 4 && priorTokens.length >= 2
      && candidateTokens.join(' ').includes(priorTokens.slice(0, Math.min(3, priorTokens.length)).join(' '))) return true

    // For substantive replies, an identical two-word lead is a strong sign
    // that the sidecar is falling back to the same stock phrasing.
    if (candidateTokens.length >= 4 && priorTokens.length >= 4
      && candidateTokens.slice(0, 2).join(' ') === priorTokens.slice(0, 2).join(' ')) return true
  }
  return false
}

const SENSITIVE_PATTERNS = [
  /\b(invoice|payment|paid|bank|iban|wire|refund|salary|budget|price|quote|contract|legal|lawyer|tax)\b/i,
  /\b(doctor|hospital|emergency|urgent|accident|police|passport|visa|address|otp|code|password)\b/i,
  /\b(schedule|reschedule|tomorrow|today|friday|monday|am|pm|calendar|meeting)\b/i,
]

// A model can rate an answer highly even when it commits the operator to a time,
// meeting, price, payment, or remedy. Check the generated text independently
// at the final send gate: this is stricter than checking the incoming message.
const OUTBOUND_AVAILABILITY_OR_MEETING_PATTERNS = [
  /\b(?:i\s+(?:can|will|am)|i['’]ll|we\s+can|let['’]s)\s+(?:make it|join|meet|schedule|be available|be free|available|free)\b/i,
  /\b(?:meeting|call|appointment)\s+(?:for|at|on)\s+(?:\d|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
]

const OUTBOUND_COMMERCIAL_COMMITMENT_PATTERNS = [
  /\b(?:the\s+)?(?:price|cost|rate|fee)\s+(?:is|will be)\b/i,
  /\b(?:i|we)\s+(?:can|will|['’]ll)\s+(?:offer|send|issue|refund|discount|charge|invoice)\b/i,
  /\b(?:a\s+)?(?:discount|refund|invoice|payment)\s+(?:is|will be|has been)\b/i,
]

// These messages close a loop or simply acknowledge that something worked.
// The operator wants to answer them personally (or let them end naturally), rather
// than having the autoreply manufacture one more message.
const TRIVIAL_ACKNOWLEDGEMENT_PATTERNS = [
  /^(?:yeah|yep|yup|yes|ok(?:ay)?|alright|sure|got it|makes sense|perfect|great|cool|nice|thanks|thank you|thx)(?:\s+(?:bro|brother|man|mate|fam|my guy))?[.!\s👍✅👌🙂]*$/i,
  /^(?:yeah[,.\s]+)?i can hear you(?: now)?[.!\s👍✅👌🙂]*$/i,
  /^(?:ja|jep|okay|ok|alles klar|verstanden|passt|perfekt|mega|danke|dankeschön)[.!\s👍✅👌🙂]*$/i,
  /^(?:ja[,.\s]+)?ich kann dich hören(?: jetzt)?[.!\s👍✅👌🙂]*$/i,
]

export type AutoSendSafetyDecision = {
  ok: boolean
  reasons: string[]
}

export function isEmojiOnlyReply(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  // A reaction-like reply can consist of pictographs, modifiers, variation
  // selectors and ZWJ sequences, but no letters or ordinary message text.
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|\s)+$/u.test(normalized)
}

export function isTrivialAcknowledgement(text: string): boolean {
  // Acknowledgements are lexical. Ignore casing, punctuation and emoji so
  // "OK!!!", "Ja 👍" and their full-width variants cannot reach text send.
  const normalized = text.normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return TRIVIAL_ACKNOWLEDGEMENT_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function evaluateAutoSendSafety(params: {
  session?: string | null
  chatJid?: string | null
  messageId?: string | null
  incomingText: string
  draft: DraftReply
  isGroup: boolean
  chatLanguage?: ChatLanguage
  // Used by focused tests; runtime reads all same-chat outbound history locally.
  recentGeneratedReplies?: string[]
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
  if (isEmojiOnlyReply(params.draft.reply)) reasons.push('emoji-only reply requires explicit native reaction')
  if (isTrivialAcknowledgement(params.draft.reply)) reasons.push('generated draft is a trivial acknowledgement')
  if (params.chatLanguage && !isReplyLanguageCompatible(params.draft.reply, params.chatLanguage)) {
    reasons.push('generated draft language is incompatible with chat language')
  }
  if (isMeaningfullyRepetitiveReply(
    params.draft.reply,
    params.recentGeneratedReplies ?? recentOutboundReplies(params.session, params.chatJid),
  )) reasons.push('generated draft repeats a recent sidecar reply in this chat')
  if (OUTBOUND_AVAILABILITY_OR_MEETING_PATTERNS.some((pattern) => pattern.test(params.draft.reply))) {
    reasons.push('generated draft makes an availability or meeting commitment')
  }
  if (OUTBOUND_COMMERCIAL_COMMITMENT_PATTERNS.some((pattern) => pattern.test(params.draft.reply))) {
    reasons.push('generated draft makes a commercial commitment')
  }
  if (params.draft.confidence < AUTOREPLY_MIN_CONFIDENCE) reasons.push('confidence below minimum threshold')
  if (!params.draft.should_send) reasons.push('model marked reply as should_send=false')
  if (params.draft.needs_review) reasons.push('model marked reply as needs_review=true')
  if (params.messageId && hasAutoSentForMessage(params.messageId)) reasons.push('message already auto-sent')
  if (hasRecentAutoSend(cooldownJids(params.session, params.chatJid), AUTOREPLY_AUTO_SEND_COOLDOWN_MS)) reasons.push('recent auto-send cooldown still active for this chat')
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(text))) reasons.push('message matches a sensitive-topic safety pattern')

  return { ok: reasons.length === 0, reasons }
}
