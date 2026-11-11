import pino from 'pino'

import { WEBHOOK_URL, WEBHOOK_TOKEN } from './env.js'
import { pushNameFor, phoneFor, type MessageInput } from './db.js'

const log = pino({ level: 'info' }).child({ mod: 'webhook' })

const RETRY_DELAYS_MS = [1_000, 3_000]
const PER_ATTEMPT_TIMEOUT_MS = 5_000

// Operator-set target, validated once for parity with the media-fetch SSRF
// guard. Loopback is the EXPECTED default (the autoreply sidecar on :8081), so
// unlike media_url it stays allowed; we hard-fail only clearly-wrong configs
// (bad scheme, embedded credentials) and warn once on private-LAN targets.
type WebhookUrlVerdict = { ok: true; warning?: string } | { ok: false; reason: string }

function classifyWebhookUrl(raw: string): WebhookUrlVerdict {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'WEBHOOK_URL is not a valid URL' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `WEBHOOK_URL must be http(s), got ${u.protocol}` }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'WEBHOOK_URL must not embed credentials' }
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  if (isLoopback) return { ok: true }
  const [a, b] = host.split('.').map(Number)
  const isPrivateV4 = Number.isInteger(a) && (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  )
  if (isPrivateV4 || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) {
    return { ok: true, warning: `WEBHOOK_URL targets a private-network host (${host}) - make sure that is intentional` }
  }
  return { ok: true }
}

let webhookUrlChecked = false
let webhookUrlUsable = true

function webhookUrlIsUsable(url: string): boolean {
  if (!webhookUrlChecked) {
    webhookUrlChecked = true
    const verdict = classifyWebhookUrl(url)
    if (!verdict.ok) {
      webhookUrlUsable = false
      log.error({ reason: verdict.reason }, 'WEBHOOK_URL rejected - webhook dispatch disabled')
    } else if (verdict.warning) {
      log.warn(verdict.warning)
    }
  }
  return webhookUrlUsable
}

async function postOnce(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (WEBHOOK_TOKEN) headers['Authorization'] = `Bearer ${WEBHOOK_TOKEN}`
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      // Operator-set URL, but don't follow redirects to private hosts via 30x.
      redirect: 'manual',
    })
  } finally {
    clearTimeout(timer)
  }
}

async function postWithRetry(url: string, body: unknown): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await postOnce(url, body)
      if (res.ok) return
      lastErr = new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastErr
}

function extractMentionJids(rawJson: string | null): string[] {
  if (!rawJson) return []

  const seen = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }

    const record = value as Record<string, unknown>
    const mentioned = record.mentionedJid
    if (Array.isArray(mentioned)) {
      for (const jid of mentioned) {
        if (typeof jid === 'string' && jid.trim()) seen.add(jid.trim())
      }
    }

    for (const nested of Object.values(record)) visit(nested)
  }

  try {
    visit(JSON.parse(rawJson))
  } catch {
    return []
  }

  return Array.from(seen)
}

export function buildPayload(message: MessageInput) {
  return {
    event: 'message',
    session: message.session,
    message: {
      id: message.id,
      ts: message.ts,
      direction: message.direction,
      chat_jid: message.chat_jid,
      from_jid: message.from_jid,
      type: message.type,
      body: message.body,
      from_display_name: pushNameFor(message.session, message.from_jid),
      from_phone: phoneFor(message.session, message.from_jid),
      chat_phone: phoneFor(message.session, message.chat_jid),
      mention_jids: extractMentionJids(message.raw_json),
      sent_by: message.sent_by,
      quoted_id: message.quoted_id,
    },
  }
}

export function dispatchInbound(message: MessageInput): void {
  if (!WEBHOOK_URL || !webhookUrlIsUsable(WEBHOOK_URL)) return
  const payload = buildPayload(message)
  postWithRetry(WEBHOOK_URL, payload).catch((err) => {
    log.error(
      { err: (err as Error).message, message_id: message.id },
      'webhook dispatch failed after retries',
    )
  })
}

export async function dispatchTest(): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!WEBHOOK_URL) return { ok: false, error: 'WEBHOOK_URL not configured' }
  if (!webhookUrlIsUsable(WEBHOOK_URL)) return { ok: false, error: 'WEBHOOK_URL rejected by validation (see logs)' }
  try {
    const res = await postOnce(WEBHOOK_URL, {
      event: 'test',
      ts: Date.now(),
      message: 'whatsapp-bridge webhook test ping',
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
