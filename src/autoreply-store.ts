import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'

export type AutoReplyMode = 'draft' | 'auto' | 'off'
export type AutoReplyScope = 'all' | 'contacts' | 'groups' | 'mixed'

export interface ActiveHours {
  start: string
  end: string
  timezone: string
}

export interface AutoReplyPolicy {
  mode: AutoReplyMode
  scope: AutoReplyScope
  contacts: string[]
  groups: string[]
  // Persistent blacklist: these chats NEVER get an autoreply, regardless of
  // mode/scope/time windows. Matched by normalized JID (phone or group id), so
  // a bare phone number matches its @s.whatsapp.net JID. Highest priority.
  blocklist: string[]
  active_until: string | null
  active_hours: ActiveHours | null
  notes: string | null
  updated_at: string
}

export interface AutoReplyAuditEntry {
  ts: string
  event:
    | 'webhook_received'
    | 'webhook_enrichment_failed'
    | 'policy_read'
    | 'policy_updated'
    | 'draft_logged'
    | 'auto_sent'
    | 'safety_blocked'
    | 'notify_chat_skipped'
    | 'model_read'
    | 'model_updated'
    | 'model_test'
  data: Record<string, unknown>
}

export interface DecisionContext {
  chat_jid?: string | null
  // Every known JID alias of the chat (e.g. the @lid form plus its
  // @s.whatsapp.net canonical). ACL matching considers all of them, so a
  // blocklist/allowlist entry hits no matter which form a message arrives
  // under. The caller resolves these via expandJidGroup.
  chat_jid_aliases?: string[]
  is_group?: boolean | null
  now?: Date
}

const POLICY_PATH = join(AUTOREPLY_DATA_DIR, 'policy.json')
const AUDIT_PATH = join(AUTOREPLY_DATA_DIR, 'audit.ndjson')
const DRAFTS_PATH = join(AUTOREPLY_DATA_DIR, 'drafts.ndjson')

function readNdjson(path: string, limit = 500): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  return lines.slice(-limit).flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

const DEFAULT_POLICY: AutoReplyPolicy = {
  mode: 'draft',
  scope: 'all',
  contacts: [],
  groups: [],
  blocklist: [],
  active_until: null,
  active_hours: null,
  notes: 'Default draft-only mode for all chats.',
  updated_at: new Date(0).toISOString(),
}

// Normalize a JID (or bare phone / group id) to a comparable key: the local
// part, minus any device suffix, lowercased. Lets a blocklist/allowlist entry
// of "491234567890" match "491234567890@s.whatsapp.net", and full-JID entries
// keep matching exactly.
function aclKey(jid: string | null | undefined): string | null {
  if (!jid) return null
  const local = jid.split('@')[0]?.split(':')[0]?.trim().toLowerCase()
  return local || null
}

function listMatches(list: string[], jids: Array<string | null | undefined>): boolean {
  const keys = new Set(jids.map(aclKey).filter((key): key is string => key !== null))
  if (keys.size === 0) return false
  return list.some((entry) => {
    const key = aclKey(entry)
    return key !== null && keys.has(key)
  })
}

function chatCandidates(context: Pick<DecisionContext, 'chat_jid' | 'chat_jid_aliases'>): string[] {
  const candidates = [context.chat_jid, ...(context.chat_jid_aliases ?? [])]
  return candidates.filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
}

function ensureDataDir(): void {
  mkdirSync(AUTOREPLY_DATA_DIR, { recursive: true })
}

export function getDefaultPolicy(): AutoReplyPolicy {
  return structuredClone(DEFAULT_POLICY)
}

export function readPolicy(): AutoReplyPolicy {
  ensureDataDir()
  if (!existsSync(POLICY_PATH)) return getDefaultPolicy()
  try {
    const raw = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Partial<AutoReplyPolicy>
    return {
      ...getDefaultPolicy(),
      ...raw,
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      groups: Array.isArray(raw.groups) ? raw.groups : [],
      blocklist: Array.isArray(raw.blocklist) ? raw.blocklist : [],
      active_hours: raw.active_hours ?? null,
      active_until: raw.active_until ?? null,
      notes: raw.notes ?? null,
      updated_at: raw.updated_at ?? getDefaultPolicy().updated_at,
    }
  } catch {
    return getDefaultPolicy()
  }
}

export function writePolicy(next: Omit<AutoReplyPolicy, 'updated_at'>): AutoReplyPolicy {
  ensureDataDir()
  const policy: AutoReplyPolicy = {
    ...next,
    contacts: Array.from(new Set(next.contacts.map((v) => v.trim()).filter(Boolean))),
    groups: Array.from(new Set(next.groups.map((v) => v.trim()).filter(Boolean))),
    blocklist: Array.from(new Set(next.blocklist.map((v) => v.trim()).filter(Boolean))),
    updated_at: new Date().toISOString(),
  }
  writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2))
  return policy
}

export function appendAudit(event: AutoReplyAuditEntry['event'], data: Record<string, unknown>): void {
  ensureDataDir()
  const entry: AutoReplyAuditEntry = {
    ts: new Date().toISOString(),
    event,
    data,
  }
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n')
}

export function appendDraft(data: Record<string, unknown>): void {
  ensureDataDir()
  appendFileSync(
    DRAFTS_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n',
  )
}

export function hasDraftForMessage(messageId: string | null | undefined): boolean {
  if (!messageId) return false
  return readNdjson(DRAFTS_PATH, 500).some((entry) => entry.message_id === messageId)
}

export function hasRecentAutoSend(chatJid: string | string[] | null | undefined, windowMs: number): boolean {
  const chatJids = (Array.isArray(chatJid) ? chatJid : [chatJid]).filter(
    (jid): jid is string => typeof jid === 'string' && jid.length > 0,
  )
  if (chatJids.length === 0 || windowMs <= 0) return false
  const jidSet = new Set(chatJids)
  const cutoff = Date.now() - windowMs
  return readNdjson(AUDIT_PATH, 500).some((entry) => {
    if (entry.event !== 'auto_sent') return false
    const data = entry.data as Record<string, unknown> | undefined
    if (!data || typeof data.chat_jid !== 'string' || !jidSet.has(data.chat_jid)) return false
    const ts = typeof data.ts === 'number' ? data.ts : Date.parse(String(entry.ts ?? ''))
    return Number.isFinite(ts) && ts >= cutoff
  })
}

function isWithinUntil(activeUntil: string | null, now: Date): boolean {
  if (!activeUntil) return true
  const untilMs = Date.parse(activeUntil)
  return Number.isFinite(untilMs) && now.getTime() <= untilMs
}

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function isWithinHours(activeHours: ActiveHours | null, now: Date): boolean {
  if (!activeHours) return true
  const start = toMinutes(activeHours.start)
  const end = toMinutes(activeHours.end)
  if (start == null || end == null) return false

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: activeHours.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  const current = hour * 60 + minute

  if (start === end) return true
  if (start < end) return current >= start && current <= end
  return current >= start || current <= end
}

function scopeAllows(policy: AutoReplyPolicy, chatJids: string[], isGroup: boolean | null | undefined): boolean {
  if (policy.scope === 'all') return true
  if (chatJids.length === 0) return false
  if (policy.scope === 'contacts') return !isGroup && listMatches(policy.contacts, chatJids)
  if (policy.scope === 'groups') return !!isGroup && listMatches(policy.groups, chatJids)
  if (policy.scope === 'mixed') {
    if (isGroup) return listMatches(policy.groups, chatJids)
    return listMatches(policy.contacts, chatJids)
  }
  return false
}

export function evaluatePolicy(policy: AutoReplyPolicy, context: DecisionContext): {
  active: boolean
  mode: AutoReplyMode
  reason: string
} {
  const now = context.now ?? new Date()
  const chatJids = chatCandidates(context)
  if (policy.mode === 'off') return { active: false, mode: 'off', reason: 'policy mode is off' }
  // Blacklist is absolute: a blocklisted chat never gets an autoreply, whatever
  // the mode, scope, or time window says.
  if (listMatches(policy.blocklist, chatJids)) {
    return { active: false, mode: policy.mode, reason: 'chat is blocklisted' }
  }
  if (!isWithinUntil(policy.active_until, now)) {
    return { active: false, mode: policy.mode, reason: 'outside active_until window' }
  }
  if (!isWithinHours(policy.active_hours, now)) {
    return { active: false, mode: policy.mode, reason: 'outside active_hours window' }
  }
  if (!scopeAllows(policy, chatJids, context.is_group)) {
    return { active: false, mode: policy.mode, reason: 'chat is outside configured scope' }
  }
  return { active: true, mode: policy.mode, reason: 'policy active' }
}
