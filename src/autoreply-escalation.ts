import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'
import { hasConfiguredNotifyTransport, sendEscalationNotification } from './autoreply-notify.js'
import { appendAudit } from './autoreply-store.js'

export interface EscalationConfig {
  enabled: boolean
  cooldown_ms: number
  max_per_hour: number
}

export type EscalationInput = {
  session: string | null | undefined
  chat_jid: string | null | undefined
  message_id: string | null | undefined
  reason: string
  payload: Record<string, unknown>
}

const CONFIG_PATH = join(AUTOREPLY_DATA_DIR, 'escalation.json')
const DEFAULT_CONFIG: EscalationConfig = { enabled: false, cooldown_ms: 15 * 60_000, max_per_hour: 12 }

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

export function readEscalationConfig(): EscalationConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<EscalationConfig>
    return {
      enabled: raw.enabled === true,
      cooldown_ms: boundedInt(raw.cooldown_ms, DEFAULT_CONFIG.cooldown_ms, 60_000, 24 * 60 * 60_000),
      max_per_hour: boundedInt(raw.max_per_hour, DEFAULT_CONFIG.max_per_hour, 1, 100),
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeEscalationConfig(next: EscalationConfig): EscalationConfig {
  const config: EscalationConfig = {
    enabled: next.enabled === true,
    cooldown_ms: boundedInt(next.cooldown_ms, DEFAULT_CONFIG.cooldown_ms, 60_000, 24 * 60 * 60_000),
    max_per_hour: boundedInt(next.max_per_hour, DEFAULT_CONFIG.max_per_hour, 1, 100),
  }
  mkdirSync(AUTOREPLY_DATA_DIR, { recursive: true, mode: 0o700 })
  const tempPath = `${CONFIG_PATH}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(tempPath, CONFIG_PATH)
  return config
}

function recentEscalations(session: string | null | undefined, chatJid: string | null | undefined, since: number): Array<Record<string, unknown>> {
  const auditPath = join(AUTOREPLY_DATA_DIR, 'audit.ndjson')
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8').trim().split('\n').slice(-500).flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { ts?: string; event?: string; data?: Record<string, unknown> }
      if (entry.event !== 'escalation_queued' || Date.parse(entry.ts ?? '') < since) return []
      if (entry.data?.session !== (session ?? null) || entry.data?.chat_jid !== (chatJid ?? null)) return []
      return [entry.data]
    } catch { return [] }
  })
}

export async function attemptEscalation(
  input: EscalationInput,
  deliver: (payload: Record<string, unknown>) => Promise<boolean> = sendEscalationNotification,
  transportConfigured = hasConfiguredNotifyTransport(),
): Promise<{ attempted: boolean; delivered: boolean; reason: string }> {
  const config = readEscalationConfig()
  if (!config.enabled) {
    appendAudit('escalation_skipped', { session: input.session ?? null, chat_jid: input.chat_jid ?? null, message_id: input.message_id ?? null, reason: 'escalation disabled' })
    return { attempted: false, delivered: false, reason: 'disabled' }
  }
  if (!transportConfigured) {
    appendAudit('escalation_skipped', { session: input.session ?? null, chat_jid: input.chat_jid ?? null, message_id: input.message_id ?? null, reason: 'no configured notification transport' })
    return { attempted: false, delivered: false, reason: 'transport_unconfigured' }
  }
  const now = Date.now()
  const recent = recentEscalations(input.session, input.chat_jid, now - 60 * 60_000)
  if (recent.length >= config.max_per_hour) {
    appendAudit('escalation_skipped', { session: input.session ?? null, chat_jid: input.chat_jid ?? null, message_id: input.message_id ?? null, reason: 'hourly escalation rate limit' })
    return { attempted: false, delivered: false, reason: 'hourly_rate_limit' }
  }
  if (recent.some((entry) => typeof entry.ts === 'number' && entry.ts >= now - config.cooldown_ms)) {
    appendAudit('escalation_skipped', { session: input.session ?? null, chat_jid: input.chat_jid ?? null, message_id: input.message_id ?? null, reason: 'chat escalation cooldown' })
    return { attempted: false, delivered: false, reason: 'cooldown' }
  }
  const auditData = { session: input.session ?? null, chat_jid: input.chat_jid ?? null, message_id: input.message_id ?? null, reason: input.reason, ts: now }
  appendAudit('escalation_queued', auditData)
  try {
    const delivered = await deliver({ kind: 'whatsapp_escalation', ...input.payload, escalation_reason: input.reason })
    appendAudit(delivered ? 'escalation_delivered' : 'escalation_failed', auditData)
    return { attempted: true, delivered, reason: delivered ? 'delivered' : 'delivery_failed' }
  } catch {
    appendAudit('escalation_failed', auditData)
    return { attempted: true, delivered: false, reason: 'delivery_failed' }
  }
}
