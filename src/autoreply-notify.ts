import {
  AUTOREPLY_NOTIFY_CHANNEL,
  AUTOREPLY_NOTIFY_WA_SESSION,
  AUTOREPLY_NOTIFY_WA_TO,
  AUTOREPLY_NOTIFY_WEBHOOK_TOKEN,
  AUTOREPLY_NOTIFY_WEBHOOK_URL,
  AUTOREPLY_SLACK_BOT_TOKEN,
  AUTOREPLY_SLACK_CHANNEL,
  AUTOREPLY_SLACK_WEBHOOK_URL,
  AUTOREPLY_TELEGRAM_BOT_TOKEN,
  AUTOREPLY_TELEGRAM_CHAT_ID,
  type NotifyChannel,
} from './autoreply-env.js'
import { sendTextReply } from './autoreply-wa.js'

function escapeTelegram(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

type MessageParts = {
  title: string
  chat: string
  session: string
  messageType: string
  incoming: string
  draft: string
  confidence: string
  reasons: string
  isInbound: boolean
}

function extractParts(payload: Record<string, unknown>): MessageParts {
  const kind = String(payload.kind ?? '').trim()
  return {
    title: kind === 'whatsapp_inbound' ? 'WhatsApp inbound' : 'WhatsApp draft',
    chat: String(payload.contact_label ?? payload.chat_jid ?? 'unknown').trim() || 'unknown',
    session: String(payload.session ?? 'main').trim() || 'main',
    messageType: String(payload.message_type ?? 'text').trim() || 'text',
    incoming: String(payload.incoming_text ?? '').trim() || '(empty)',
    draft: String(payload.draft_reply ?? '').trim() || '(empty)',
    confidence: payload.confidence == null ? 'n/a' : String(payload.confidence),
    reasons: Array.isArray(payload.reasons) ? payload.reasons.map((v) => `- ${String(v)}`).join('\n') : '',
    isInbound: kind === 'whatsapp_inbound',
  }
}

function renderTelegramMessage(payload: Record<string, unknown>): string {
  const p = extractParts(payload)
  if (p.isInbound) {
    return [
      '📩 *WhatsApp inbound*',
      `chat: ${escapeTelegram(p.chat)}`,
      `session: ${escapeTelegram(p.session)}`,
      `type: ${escapeTelegram(p.messageType)}`,
      '',
      '*Message*',
      escapeTelegram(p.incoming),
    ].join('\n')
  }
  return [
    '🟢 *WhatsApp draft*',
    `chat: ${escapeTelegram(p.chat)}`,
    '',
    '*Incoming*',
    escapeTelegram(p.incoming),
    '',
    '*Draft as operator*',
    escapeTelegram(p.draft),
    '',
    `confidence: *${escapeTelegram(p.confidence)}*`,
    p.reasons ? `reasons:\n${escapeTelegram(p.reasons)}` : '',
  ].filter(Boolean).join('\n')
}

// Plain-text render shared by Slack (mrkdwn tolerates plain text) and WhatsApp.
function renderPlainMessage(payload: Record<string, unknown>): string {
  const p = extractParts(payload)
  if (p.isInbound) {
    return [
      `📩 WhatsApp inbound`,
      `chat: ${p.chat}`,
      `session: ${p.session}`,
      `type: ${p.messageType}`,
      '',
      'Message:',
      p.incoming,
    ].join('\n')
  }
  return [
    `🟢 WhatsApp draft`,
    `chat: ${p.chat}`,
    '',
    'Incoming:',
    p.incoming,
    '',
    'Draft as operator:',
    p.draft,
    '',
    `confidence: ${p.confidence}`,
    p.reasons ? `reasons:\n${p.reasons}` : '',
  ].filter(Boolean).join('\n')
}

async function sendWebhookNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (!AUTOREPLY_NOTIFY_WEBHOOK_URL) return false
  const res = await fetch(AUTOREPLY_NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AUTOREPLY_NOTIFY_WEBHOOK_TOKEN ? { Authorization: `Bearer ${AUTOREPLY_NOTIFY_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  })
  return res.ok
}

async function sendTelegramNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (!AUTOREPLY_TELEGRAM_BOT_TOKEN || !AUTOREPLY_TELEGRAM_CHAT_ID) return false
  const res = await fetch(`https://api.telegram.org/bot${AUTOREPLY_TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: AUTOREPLY_TELEGRAM_CHAT_ID,
      text: renderTelegramMessage(payload),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  })
  return res.ok
}

async function sendSlackNotification(payload: Record<string, unknown>): Promise<boolean> {
  const text = renderPlainMessage(payload)
  if (AUTOREPLY_SLACK_WEBHOOK_URL) {
    const res = await fetch(AUTOREPLY_SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return res.ok
  }
  if (AUTOREPLY_SLACK_BOT_TOKEN && AUTOREPLY_SLACK_CHANNEL) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${AUTOREPLY_SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: AUTOREPLY_SLACK_CHANNEL, text }),
    })
    if (!res.ok) return false
    const body = await res.json().catch(() => null) as { ok?: boolean } | null
    return body?.ok === true
  }
  return false
}

// Sends the notification to the operator's own WhatsApp chat (self-chat or a
// second number) through the local bridge itself.
async function sendWhatsAppNotification(payload: Record<string, unknown>): Promise<boolean> {
  if (!AUTOREPLY_NOTIFY_WA_TO) return false
  const sent = await sendTextReply({
    to: AUTOREPLY_NOTIFY_WA_TO,
    text: renderPlainMessage(payload),
    ...(AUTOREPLY_NOTIFY_WA_SESSION ? { session: AUTOREPLY_NOTIFY_WA_SESSION } : {}),
  })
  return sent.ok !== false
}

const SENDERS: Record<NotifyChannel, (payload: Record<string, unknown>) => Promise<boolean>> = {
  webhook: sendWebhookNotification,
  telegram: sendTelegramNotification,
  slack: sendSlackNotification,
  whatsapp: sendWhatsAppNotification,
}

// Legacy fallback order, used only when AUTOREPLY_NOTIFY_CHANNEL is not set.
const AUTO_ORDER: NotifyChannel[] = ['webhook', 'telegram', 'slack', 'whatsapp']

export function hasConfiguredNotifyTransport(): boolean {
  const configured = (channel: NotifyChannel): boolean => {
    if (channel === 'webhook') return Boolean(AUTOREPLY_NOTIFY_WEBHOOK_URL)
    if (channel === 'telegram') return Boolean(AUTOREPLY_TELEGRAM_BOT_TOKEN && AUTOREPLY_TELEGRAM_CHAT_ID)
    if (channel === 'slack') return Boolean(AUTOREPLY_SLACK_WEBHOOK_URL || (AUTOREPLY_SLACK_BOT_TOKEN && AUTOREPLY_SLACK_CHANNEL))
    return Boolean(AUTOREPLY_NOTIFY_WA_TO)
  }
  return AUTOREPLY_NOTIFY_CHANNEL
    ? configured(AUTOREPLY_NOTIFY_CHANNEL)
    : AUTO_ORDER.some(configured)
}

export function isNotifyWhatsAppChat(chatJid: string | null | undefined): boolean {
  if (!AUTOREPLY_NOTIFY_WA_TO || !chatJid) return false
  const wantsWhatsApp = AUTOREPLY_NOTIFY_CHANNEL === 'whatsapp' || AUTOREPLY_NOTIFY_CHANNEL == null
  if (!wantsWhatsApp) return false
  const normalize = (value: string) => value.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''
  const target = normalize(AUTOREPLY_NOTIFY_WA_TO)
  return target.length > 0 && normalize(chatJid) === target
}

async function dispatchNotification(payload: Record<string, unknown>): Promise<boolean> {
  // Explicit channel selection: use only that channel, never fall back silently.
  if (AUTOREPLY_NOTIFY_CHANNEL) {
    return await SENDERS[AUTOREPLY_NOTIFY_CHANNEL](payload).catch(() => false)
  }
  for (const channel of AUTO_ORDER) {
    if (await SENDERS[channel](payload).catch(() => false)) return true
  }
  return false
}

export async function sendDraftNotification(payload: Record<string, unknown>): Promise<boolean> {
  return dispatchNotification(payload)
}

export async function sendInboundNotification(payload: Record<string, unknown>): Promise<boolean> {
  return dispatchNotification(payload)
}

// Escalations deliberately reuse the already configured private notification
// transport. They never introduce another credential path or a public sink.
export async function sendEscalationNotification(payload: Record<string, unknown>): Promise<boolean> {
  return dispatchNotification(payload)
}
