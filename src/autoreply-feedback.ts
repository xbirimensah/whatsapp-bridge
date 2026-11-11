import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'
import { appendAudit } from './autoreply-store.js'

export type FeedbackOutcome = 'accepted' | 'corrected' | 'rejected'

export interface OperatorFeedback {
  id: string
  created_at: string
  session: string
  chat_jid: string
  message_id: string | null
  draft_reply: string
  correction: string
  outcome: FeedbackOutcome
  note: string | null
}

const FEEDBACK_PATH = join(AUTOREPLY_DATA_DIR, 'feedback.json')
const MAX_FEEDBACK_ENTRIES = 500
const FEEDBACK_OUTCOMES: readonly FeedbackOutcome[] = ['accepted', 'corrected', 'rejected']

function isFeedbackOutcome(value: unknown): value is FeedbackOutcome {
  return typeof value === 'string' && FEEDBACK_OUTCOMES.includes(value as FeedbackOutcome)
}

function readAll(): OperatorFeedback[] {
  if (!existsSync(FEEDBACK_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(FEEDBACK_PATH, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is OperatorFeedback => Boolean(item) && typeof item === 'object') : []
  } catch { return [] }
}

function clean(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function recordFeedback(input: Omit<OperatorFeedback, 'id' | 'created_at'>): OperatorFeedback {
  const session = clean(input.session, 100)
  const chatJid = clean(input.chat_jid, 300)
  const draftReply = clean(input.draft_reply, 1_000)
  const correction = clean(input.correction, 1_000)
  if (!session || !chatJid || !draftReply || !correction) throw new Error('session, chat_jid, draft_reply, and correction are required')
  if (!isFeedbackOutcome(input.outcome)) throw new Error('outcome must be accepted, corrected, or rejected')
  const entry: OperatorFeedback = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    session,
    chat_jid: chatJid,
    message_id: input.message_id ? clean(input.message_id, 300) : null,
    draft_reply: draftReply,
    correction,
    outcome: input.outcome,
    note: input.note ? clean(input.note, 1_000) : null,
  }
  mkdirSync(AUTOREPLY_DATA_DIR, { recursive: true, mode: 0o700 })
  const tempPath = `${FEEDBACK_PATH}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify([...readAll(), entry].slice(-MAX_FEEDBACK_ENTRIES), null, 2), { mode: 0o600 })
  renameSync(tempPath, FEEDBACK_PATH)
  // Only metadata is audited: private draft/correction text stays in the
  // review file and is never used to change policy or model behavior.
  appendAudit('feedback_recorded', { id: entry.id, session, chat_jid: chatJid, message_id: entry.message_id, outcome: entry.outcome })
  return entry
}

export function listFeedback(limit = 50): OperatorFeedback[] {
  const bounded = Math.max(0, Math.min(Math.floor(limit), MAX_FEEDBACK_ENTRIES))
  return readAll().slice(-bounded).reverse()
}

// Corrections are a chat-scoped voice reference, never an implicit global
// training signal. Only an explicit correction/rejection changes what the
// drafter sees, and the text remains in the private feedback store.
export function applicableVoiceCorrections(
  entries: ReadonlyArray<Pick<OperatorFeedback, 'session' | 'chat_jid' | 'draft_reply' | 'correction' | 'outcome'>>,
  params: { session: string; chatJids: readonly string[]; limit?: number },
): string[] {
  const allowedChats = new Set(params.chatJids)
  const limit = Math.max(0, Math.min(params.limit ?? 5, 10))
  return entries
    .filter((entry) => entry.session === params.session
      && allowedChats.has(entry.chat_jid)
      && (entry.outcome === 'corrected' || entry.outcome === 'rejected')
      && entry.draft_reply.trim()
      && entry.correction.trim())
    .slice(-limit)
    .map((entry) => `Avoid: ${clean(entry.draft_reply, 240)}\nPrefer: ${clean(entry.correction, 240)}`)
}

export function voiceCorrectionsForChat(params: { session: string; chatJids: readonly string[]; limit?: number }): string[] {
  return applicableVoiceCorrections(readAll(), params)
}
