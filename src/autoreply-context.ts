// The drafter keeps a compact chronological window from the active chat. Older
// facts are retrieved separately through the private pgvector second brain, so
// we do not burn prompt space on broad keyword matches from unrelated chats.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  AUTOREPLY_DEFAULT_SESSION,
  AUTOREPLY_HISTORY_MESSAGE_LIMIT,
  AUTOREPLY_STYLE_CORPUS_PATH,
} from './autoreply-env.js'
import { db, expandJidGroup } from './db.js'

type HistoryRow = {
  ts: number
  direction: string
  chat_jid: string
  content: string
}

const DEFAULT_HISTORY_MESSAGE_LIMIT = 50
const MAX_HISTORY_MESSAGE_LIMIT = 500
const HISTORY_ROW_MAX_CHARS = 100

// Baileys-generated message IDs start with 3EB0 right after the "session:"
// prefix; messages typed on the phone never do. Filtering on this marker keeps
// auto-sent and API-sent replies out of the operator's own style sample, so
// the anchor cannot drift toward the bot's earlier output.
const BRIDGE_MESSAGE_ID_MARKER = ':3EB0'
const DEFAULT_STYLE_ANCHOR_LIMIT = 30
const STYLE_ANCHOR_ROW_MAX_CHARS = 90

export function resolveHistoryMessageLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_HISTORY_MESSAGE_LIMIT
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_HISTORY_MESSAGE_LIMIT
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_HISTORY_MESSAGE_LIMIT
  return Math.min(parsed, MAX_HISTORY_MESSAGE_LIMIT)
}

function formatRow(row: HistoryRow): string {
  const who = row.direction === 'out' ? 'me' : 'them'
  const text = row.content.replace(/\s+/g, ' ').trim().slice(0, HISTORY_ROW_MAX_CHARS)
  return `- [${new Date(row.ts).toISOString().slice(0, 10)}] ${who}: ${text}`
}

// Synchronous by design: better-sqlite3 is synchronous and this same-chat
// indexed query is bounded by the owner-selected message limit.
export function fetchWhatsAppHistoryContext(params: {
  chatJid?: string | null
  session?: string | null
  messageLimit?: number
}): string {
  const session = params.session?.trim() || AUTOREPLY_DEFAULT_SESSION
  const messageLimit = params.messageLimit ?? resolveHistoryMessageLimit(AUTOREPLY_HISTORY_MESSAGE_LIMIT)
  if (!params.chatJid || messageLimit === 0) return ''

  try {
    const jids = expandJidGroup(session, params.chatJid)
    const placeholders = jids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT ts, direction, chat_jid, COALESCE(body, transcript) AS content
      FROM messages
      WHERE session = ? AND chat_jid IN (${placeholders})
        AND COALESCE(body, transcript) IS NOT NULL
        AND TRIM(COALESCE(body, transcript)) != ''
      ORDER BY ts DESC
      LIMIT ?
    `).all(session, ...jids, messageLimit) as HistoryRow[]
    if (rows.length === 0) return ''
    return [
      `Recent conversation with this chat (${rows.length} messages, oldest first):`,
      ...rows.reverse().map(formatRow),
    ].join('\n')
  } catch {
    return ''
  }
}

export function formatStyleAnchor(messages: string[]): string {
  const cleaned = messages
    .map((message) => message.replace(/\s+/g, ' ').trim().slice(0, STYLE_ANCHOR_ROW_MAX_CHARS))
    .filter((message) => message.length > 0)
  if (cleaned.length === 0) return ''
  return [
    'How the operator ACTUALLY texts in this exact chat (verbatim recent messages, oldest first). This register outranks every other style source:',
    ...cleaned.map((message) => `- ${message}`),
  ].join('\n')
}

// Verbatim operator-typed messages from the same chat: the strongest possible
// style signal. Bridge-sent messages are excluded (see marker above).
export function fetchOperatorStyleAnchor(params: {
  chatJid?: string | null
  session?: string | null
  limit?: number
}): string {
  const session = params.session?.trim() || AUTOREPLY_DEFAULT_SESSION
  const limit = params.limit ?? DEFAULT_STYLE_ANCHOR_LIMIT
  if (!params.chatJid || limit <= 0) return ''

  try {
    const jids = expandJidGroup(session, params.chatJid)
    const placeholders = jids.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT COALESCE(body, transcript) AS content
      FROM messages
      WHERE session = ? AND chat_jid IN (${placeholders})
        AND direction = 'out'
        AND id NOT LIKE '%${BRIDGE_MESSAGE_ID_MARKER}%'
        AND COALESCE(body, transcript) IS NOT NULL
        AND TRIM(COALESCE(body, transcript)) != ''
      ORDER BY ts DESC
      LIMIT ?
    `).all(session, ...jids, limit) as Array<{ content: string }>
    return formatStyleAnchor(rows.reverse().map((row) => row.content))
  } catch {
    return ''
  }
}

// Builds a WhatsApp-only style corpus from the operator's own sent messages
// when no corpus file exists yet. `npm run autoreply:build-corpus` still
// produces the richer version; this is the zero-setup fallback.
export function ensureStyleCorpus(): void {
  try {
    if (existsSync(AUTOREPLY_STYLE_CORPUS_PATH) && statSync(AUTOREPLY_STYLE_CORPUS_PATH).size > 0) return

    const rows = db.prepare(`
      SELECT ts, chat_jid, type, COALESCE(body, transcript) AS content
      FROM messages
      WHERE direction = 'out'
        AND COALESCE(body, transcript) IS NOT NULL
        AND TRIM(COALESCE(body, transcript)) != ''
      ORDER BY ts DESC
      LIMIT 1200
    `).all() as Array<{ ts: number; chat_jid: string; type: string; content: string }>
    if (rows.length === 0) return

    const lines = [
      '# Autoreply style corpus (auto-built from WhatsApp outbound history)',
      '',
      `Generated at: ${new Date().toISOString()}`,
      `Sampled messages: ${rows.length}`,
      '',
      'Recent outbound samples (newest first):',
      '',
      ...rows.map((row) => {
        const clean = row.content.replace(/\s+/g, ' ').trim()
        return `- ts=${row.ts} chat=${row.chat_jid} type=${row.type} text=${JSON.stringify(clean)}`
      }),
      '',
    ]

    mkdirSync(dirname(AUTOREPLY_STYLE_CORPUS_PATH), { recursive: true })
    writeFileSync(AUTOREPLY_STYLE_CORPUS_PATH, lines.join('\n'))
  } catch {
    // Non-fatal: drafting still works without a corpus, just less in-voice.
  }
}
