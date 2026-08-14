import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'

import { AUTOREPLY_DEFAULT_SESSION, AUTOREPLY_HOST, AUTOREPLY_PORT, AUTOREPLY_TOKEN } from './autoreply-env.js'
import { expandJidGroup } from './db.js'
import { generateDraftReply } from './autoreply-generate.js'
import { attemptEscalation } from './autoreply-escalation.js'
import { resolveChatLanguage } from './autoreply-language.js'
import { isNotifyWhatsAppChat, sendDraftNotification, sendInboundNotification } from './autoreply-notify.js'
import {
  PROVIDERS,
  describeProviders,
  readModelConfig,
  verifyModel,
  writeModelConfig,
} from './autoreply-model.js'
import { evaluateAutoSendSafety, isTrivialAcknowledgement } from './autoreply-safety.js'
import {
  appendAudit,
  appendDraft,
  evaluatePolicy,
  getDefaultPolicy,
  hasAutoSentForMessage,
  readPolicy,
  writePolicy,
  type AutoReplyPolicy,
} from './autoreply-store.js'
import { resolvePreferredChatLabel, sendTextReply, waitForInboundMessageContext } from './autoreply-wa.js'

const app = Fastify({ logger: false })

const webhookMessageSchema = z.object({
  id: z.string().optional(),
  ts: z.number().optional(),
  direction: z.string().optional(),
  chat_jid: z.string().optional(),
  from_jid: z.string().optional(),
  type: z.string().optional(),
  body: z.string().nullable().optional(),
  from_display_name: z.string().nullable().optional(),
  from_phone: z.string().nullable().optional(),
  chat_phone: z.string().nullable().optional(),
}).passthrough()

const webhookSchema = z.object({
  event: z.string().default('message'),
  session: z.string().optional(),
  message: z.union([webhookMessageSchema, z.string()]).optional(),
}).passthrough()

const activeHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().min(1),
})

const modelConfigSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).nullable().optional(),
  base_url: z.string().url().nullable().optional(),
})

const updateModelSchema = modelConfigSchema.extend({
  // Persist even if the connectivity check fails. Off by default so a switch
  // only lands when the provider + model actually respond.
  force: z.boolean().optional(),
})

const updatePolicySchema = z.object({
  mode: z.enum(['draft', 'auto', 'off']).default('draft'),
  scope: z.enum(['all', 'contacts', 'groups', 'mixed']).default('all'),
  contacts: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
  // Optional so a PUT that omits it PRESERVES the existing blocklist rather
  // than wiping it (e.g. `npm run autoreply:off`). Pass [] to clear explicitly.
  blocklist: z.array(z.string()).optional(),
  active_until: z.string().datetime({ offset: true }).nullable().optional(),
  active_hours: activeHoursSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
})

const AI_REPLY_PREFIX_EN = "Hi — this is the operator's AI assistant. They're currently unavailable, so I'm replying on their behalf."
const AI_REPLY_SUFFIX_EN = "— Sent by the operator's AI agent."
const AI_REPLY_PREFIX_DE = 'Hi — hier schreibt der KI-Assistent des Betreibers. Er ist gerade nicht verfügbar, deshalb antworte ich in seinem Namen.'
const AI_REPLY_SUFFIX_DE = '— Gesendet vom KI-Agenten des Betreibers.'

function normalizeJidKey(jid: string | null | undefined): string | null {
  if (!jid) return null
  const local = jid.split('@')[0]?.split(':')[0]?.trim().toLowerCase()
  return local || null
}

function sessionOwnJids(session: string | null | undefined): string[] {
  const sessionName = session?.trim() || AUTOREPLY_DEFAULT_SESSION
  const credsPath = resolve(process.cwd(), 'auth', sessionName, 'creds.json')
  if (!existsSync(credsPath)) return []

  try {
    const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as { me?: { id?: string | null } }
    const meId = raw.me?.id?.trim()
    if (!meId) return []
    return Array.from(new Set([meId, ...expandJidGroup(sessionName, meId)]))
  } catch {
    return []
  }
}

function isExplicitlyTaggedForOperator(session: string | null | undefined, message: Record<string, unknown> | null): boolean {
  if (!message) return false
  const mentionJids = Array.isArray(message.mention_jids)
    ? message.mention_jids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  if (mentionJids.length === 0) return false

  const ownKeys = new Set(sessionOwnJids(session).map(normalizeJidKey).filter((value): value is string => Boolean(value)))
  if (ownKeys.size === 0) return false

  return mentionJids.some((jid) => {
    const key = normalizeJidKey(jid)
    return !!key && ownKeys.has(key)
  })
}

function prefersGerman(text: string): boolean {
  return /\b(hallo|hi|bitte|danke|und|oder|nicht|gerade|link|links|nachricht|sprachnachricht|anruf|whatsapp|schick|sende|kannst|könntest|mir|dir|ihm)\b|[äöüß]/i.test(text)
}

function presentReply(reply: string, _incomingText: string): string {
  // Reply in the operator's own voice with no AI disclosure — strip any prefix/suffix
  // the model may have echoed from prior examples.
  let body = reply.trim()
  body = body
    .replace(new RegExp(`^${escapeForRegExp(AI_REPLY_PREFIX_DE)}\\s*`, 'i'), '')
    .replace(new RegExp(`^${escapeForRegExp(AI_REPLY_PREFIX_EN)}\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*${escapeForRegExp(AI_REPLY_SUFFIX_DE)}$`, 'i'), '')
    .replace(new RegExp(`\\s*${escapeForRegExp(AI_REPLY_SUFFIX_EN)}$`, 'i'), '')
    .trim()
  return body
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!AUTOREPLY_TOKEN) {
    reply.code(500).send({ error: 'AUTOREPLY_TOKEN not configured' })
    return false
  }
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : ''
  const given = Buffer.from(bearer, 'utf8')
  const expected = Buffer.from(AUTOREPLY_TOKEN, 'utf8')
  const ok = given.length === expected.length && timingSafeEqual(given, expected)
  if (!ok) {
    reply.code(401).send({ error: 'unauthorized' })
    return false
  }
  return true
}

app.get('/health', async () => ({
  ok: true,
  service: 'wa-autoreply',
  policy: readPolicy(),
  default_policy: getDefaultPolicy(),
  ts: Date.now(),
}))

app.get('/policy', async (req, reply) => {
  if (!authorized(req, reply)) return
  const policy = readPolicy()
  appendAudit('policy_read', { ip: req.ip })
  return policy
})

app.put('/policy', async (req, reply) => {
  if (!authorized(req, reply)) return
  const parsed = updatePolicySchema.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }
  const previous = readPolicy()
  const nextInput: Omit<AutoReplyPolicy, 'updated_at'> = {
    mode: parsed.data.mode,
    scope: parsed.data.scope,
    contacts: parsed.data.contacts,
    groups: parsed.data.groups,
    blocklist: parsed.data.blocklist ?? previous.blocklist,
    active_until: parsed.data.active_until ?? null,
    active_hours: parsed.data.active_hours ? {
      start: parsed.data.active_hours.start,
      end: parsed.data.active_hours.end,
      timezone: parsed.data.active_hours.timezone,
    } : null,
    notes: parsed.data.notes ?? null,
  }
  const next = writePolicy(nextInput)
  appendAudit('policy_updated', { ip: req.ip, previous, next })
  return next
})

app.get('/model', async (req, reply) => {
  if (!authorized(req, reply)) return
  const config = readModelConfig()
  appendAudit('model_read', { ip: req.ip })
  return { config, providers: describeProviders() }
})

app.post('/model/test', async (req, reply) => {
  if (!authorized(req, reply)) return
  // Body optional: test the given provider/model, or the active one when empty.
  const parsed = modelConfigSchema.partial().safeParse(req.body ?? {})
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }
  const current = readModelConfig()
  const target = {
    provider: parsed.data.provider ?? current.provider,
    model: parsed.data.model ?? current.model,
    base_url: parsed.data.base_url ?? current.base_url,
  }
  const result = await verifyModel(target)
  appendAudit('model_test', { ip: req.ip, target, ok: result.ok, detail: result.detail })
  reply.code(result.ok ? 200 : 502)
  return result
})

app.put('/model', async (req, reply) => {
  if (!authorized(req, reply)) return
  const parsed = updateModelSchema.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }
  const previous = readModelConfig()
  const target = {
    provider: parsed.data.provider,
    model: parsed.data.model ?? null,
    base_url: parsed.data.base_url ?? null,
  }
  const verify = await verifyModel(target)
  if (!verify.ok && !parsed.data.force) {
    reply.code(502)
    return { error: 'not_connected', verify, hint: 'pass force:true to switch anyway' }
  }
  const next = writeModelConfig(target)
  appendAudit('model_updated', { ip: req.ip, previous, next, verify, forced: Boolean(parsed.data.force) })
  return { config: next, verify }
})

// A chat can appear under multiple JID forms (@lid and its @s.whatsapp.net
// canonical). Resolving the full alias group here lets policy ACLs match a
// blocklist/allowlist entry regardless of which form the message arrived under.
function resolveChatJidAliases(session: string | null | undefined, chatJid: unknown): string[] {
  if (typeof chatJid !== 'string' || chatJid.length === 0) return []
  try {
    return expandJidGroup(session?.trim() || AUTOREPLY_DEFAULT_SESSION, chatJid)
  } catch {
    return []
  }
}

app.post('/webhook', async (req, reply) => {
  if (!authorized(req, reply)) return
  const parsed = webhookSchema.safeParse(req.body)
  if (!parsed.success) {
    reply.code(400).send({ error: 'validation', issues: parsed.error.issues })
    return
  }

  const payload = parsed.data
  const message = typeof payload.message === 'string' ? null : payload.message
  const isTestEvent = payload.event === 'test'

  // WhatsApp statuses (status@broadcast) and broadcast lists are not
  // conversations - never draft, notify, or auto-reply for them.
  if (!isTestEvent && typeof message?.chat_jid === 'string' && message.chat_jid.endsWith('@broadcast')) {
    return { ok: true, skipped: 'broadcast' }
  }

  // When drafts are delivered to the operator's own WhatsApp chat, never
  // process messages from that chat - it would loop notifications into drafts.
  if (!isTestEvent && isNotifyWhatsAppChat(message?.chat_jid)) {
    appendAudit('notify_chat_skipped', {
      session: payload.session ?? null,
      message_id: message?.id ?? null,
      chat_jid: message?.chat_jid ?? null,
    })
    return { ok: true, skipped: 'notify_channel_chat' }
  }

  const isGroup = typeof message?.chat_jid === 'string' ? message.chat_jid.endsWith('@g.us') : false
  const policy = readPolicy()
  const decision = evaluatePolicy(policy, {
    chat_jid: message?.chat_jid,
    chat_jid_aliases: resolveChatJidAliases(payload.session, message?.chat_jid),
    is_group: isGroup,
  })

  const enrichedMessage = decision.active && message?.chat_jid && message?.id && message?.direction !== 'out'
    ? await waitForInboundMessageContext({
        jid: message.chat_jid,
        messageId: message.id,
        session: payload.session,
        desiredType: message.type ?? null,
      }).catch((error: unknown) => {
        appendAudit('webhook_enrichment_failed', {
          message_id: message.id,
          chat_jid: message.chat_jid,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      })
    : null

  appendAudit('webhook_received', {
    ip: req.ip,
    event: payload.event,
    session: payload.session ?? null,
    message_id: message?.id ?? null,
    chat_jid: message?.chat_jid ?? null,
    from_jid: message?.from_jid ?? null,
    type: message?.type ?? null,
    direction: message?.direction ?? null,
    resolved_body: enrichedMessage?.body ?? message?.body ?? (typeof payload.message === 'string' ? payload.message : null),
    resolved_transcript: enrichedMessage?.transcript ?? null,
    decision,
  })

  if (isTestEvent) {
    return {
      ok: true,
      policy_mode: policy.mode,
      decision,
      test: true,
    }
  }

  const incomingText = (enrichedMessage?.transcript || enrichedMessage?.body || message?.body || '').trim()
  const contactLabel = message?.from_display_name?.trim()
    || message?.from_phone?.trim()
    || message?.chat_phone?.trim()
    || await resolvePreferredChatLabel(
      message?.from_jid ?? message?.chat_jid ?? null,
      payload.session ?? undefined,
    ).catch(() => null)
    || message?.chat_jid
    || 'unknown'

  if (!isTestEvent && message?.direction !== 'out' && message?.chat_jid !== 'status@broadcast') {
    await sendInboundNotification({
      kind: 'whatsapp_inbound',
      session: payload.session ?? null,
      chat_jid: message?.chat_jid ?? null,
      contact_label: contactLabel,
      from_jid: message?.from_jid ?? null,
      message_type: enrichedMessage?.type ?? message?.type ?? null,
      incoming_text: incomingText,
    }).catch(() => false)
  }

  if (decision.active && isGroup && !isExplicitlyTaggedForOperator(payload.session ?? AUTOREPLY_DEFAULT_SESSION, message ?? null)) {
    appendAudit('safety_blocked', {
      session: payload.session ?? null,
      message_id: message?.id ?? null,
      chat_jid: message?.chat_jid ?? null,
      reason: 'group message without explicit operator tag',
    })
    return {
      ok: true,
      policy_mode: policy.mode,
      decision,
      skipped: 'group_not_tagged',
    }
  }

  // Do not draft or auto-send another acknowledgement after a conversation
  // has already naturally closed. Inbound notifications still reach Obiri, so
  // he can answer personally when he wants to.
  if (decision.active && message?.direction !== 'out' && isTrivialAcknowledgement(incomingText)) {
    appendAudit('safety_blocked', {
      session: payload.session ?? null,
      message_id: message?.id ?? null,
      chat_jid: message?.chat_jid ?? null,
      reason: 'trivial acknowledgement left for Obiri',
    })
    return {
      ok: true,
      policy_mode: policy.mode,
      decision,
      skipped: 'trivial_acknowledgement',
    }
  }

  if (decision.active && message?.direction !== 'out' && incomingText) {
    // Webhooks may be retried after a transient bridge failure. A draft is not
    // delivery: only suppress the event once an auto-send was persisted.
    if (decision.mode === 'auto' && hasAutoSentForMessage(message?.id ?? null)) {
      appendAudit('safety_blocked', {
        session: payload.session ?? null,
        message_id: message?.id ?? null,
        chat_jid: message?.chat_jid ?? null,
        reason: 'message already auto-sent',
      })
      return { ok: true, policy_mode: policy.mode, decision, skipped: 'already_auto_sent' }
    }

    const draft = await generateDraftReply({
      incomingText,
      contactName: message?.from_display_name ?? null,
      isGroup,
      chatJid: message?.chat_jid ?? null,
      session: payload.session ?? null,
    }).catch((error: unknown) => {
      appendAudit('safety_blocked', {
        session: payload.session ?? null,
        message_id: message?.id ?? null,
        chat_jid: message?.chat_jid ?? null,
        reason: 'draft generation failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    })

    if (draft) {
      // Resolve once again at the decision boundary. `generateDraftReply`
      // applies the same guard for review metadata, but this boundary is what
      // authorizes a real text send and must remain safe if generation changes.
      const chatLanguage = resolveChatLanguage(incomingText, [])
      const preparedDraft = {
        ...draft,
        reply: presentReply(draft.reply, incomingText),
      }
      const autoSafety = decision.mode === 'auto'
        ? evaluateAutoSendSafety({
            session: payload.session ?? null,
            chatJid: message?.chat_jid ?? null,
            messageId: message?.id ?? null,
            incomingText,
            draft: preparedDraft,
            isGroup,
            chatLanguage,
          })
        : null

      appendDraft({
        source: 'webhook',
        session: payload.session ?? null,
        message_id: message?.id ?? null,
        chat_jid: message?.chat_jid ?? null,
        from_jid: message?.from_jid ?? null,
        body: enrichedMessage?.body ?? message?.body ?? null,
        transcript: enrichedMessage?.transcript ?? null,
        type: enrichedMessage?.type ?? message?.type ?? null,
        draft_reply: preparedDraft.reply,
        confidence: preparedDraft.confidence,
        should_send: preparedDraft.should_send,
        needs_review: preparedDraft.needs_review,
        reasons: preparedDraft.reasons,
      })

      if (decision.mode === 'draft') {
        await sendDraftNotification({
          kind: 'whatsapp_draft',
          session: payload.session ?? null,
          chat_jid: message?.chat_jid ?? null,
          contact_label: contactLabel,
          from_jid: message?.from_jid ?? null,
          incoming_text: incomingText,
          draft_reply: preparedDraft.reply,
          confidence: preparedDraft.confidence,
          should_send: preparedDraft.should_send,
          needs_review: preparedDraft.needs_review,
          reasons: preparedDraft.reasons,
        }).catch(() => false)
      }

      if (decision.mode === 'auto') {
        if (autoSafety?.ok) {
          const sent = await sendTextReply({
            session: payload.session ?? undefined,
            to: message?.chat_jid ?? '',
            text: preparedDraft.reply,
            quoted_id: message?.id ?? null,
          }).catch((error: unknown) => {
            appendAudit('safety_blocked', {
              session: payload.session ?? null,
              message_id: message?.id ?? null,
              chat_jid: message?.chat_jid ?? null,
              reason: 'auto send failed',
              error: error instanceof Error ? error.message : String(error),
            })
            return null
          })

          if (sent) {
            appendAudit('auto_sent', {
              session: payload.session ?? null,
              inbound_message_id: message?.id ?? null,
              outbound_message_id: sent.id,
              chat_jid: sent.jid,
              ts: sent.ts,
              reply: preparedDraft.reply,
              confidence: preparedDraft.confidence,
            })
          }
        } else {
          appendAudit('safety_blocked', {
            session: payload.session ?? null,
            message_id: message?.id ?? null,
            chat_jid: message?.chat_jid ?? null,
            reason: 'auto mode active but safety gates blocked send',
            confidence: preparedDraft.confidence,
            should_send: preparedDraft.should_send,
            needs_review: preparedDraft.needs_review,
            reasons: [...preparedDraft.reasons, ...(autoSafety?.reasons ?? [])],
          })
          await sendDraftNotification({
            kind: 'whatsapp_draft',
            session: payload.session ?? null,
            chat_jid: message?.chat_jid ?? null,
            contact_label: contactLabel,
            from_jid: message?.from_jid ?? null,
            incoming_text: incomingText,
            draft_reply: preparedDraft.reply,
            confidence: preparedDraft.confidence,
            should_send: preparedDraft.should_send,
            needs_review: true,
            reasons: [...preparedDraft.reasons, ...(autoSafety?.reasons ?? [])],
          }).catch(() => false)
          await attemptEscalation({
            session: payload.session ?? null,
            chat_jid: message?.chat_jid ?? null,
            message_id: message?.id ?? null,
            reason: 'auto_send_safety_blocked',
            payload: {
              session: payload.session ?? null,
              chat_jid: message?.chat_jid ?? null,
              contact_label: contactLabel,
              incoming_text: incomingText,
              draft_reply: preparedDraft.reply,
              reasons: [...preparedDraft.reasons, ...(autoSafety?.reasons ?? [])],
            },
          })
        }
      }
    }
  }

  return {
    ok: true,
    policy_mode: policy.mode,
    decision,
    placeholder: true,
  }
})

export async function startAutoReplyServer(): Promise<void> {
  await app.listen({ host: AUTOREPLY_HOST, port: AUTOREPLY_PORT })
}
