import Fastify from 'fastify'
import pino from 'pino'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, basename, sep } from 'node:path'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

import { API_TOKEN, HOST, PORT } from './env.js'
import { makeNonce, cspWithNonce, renderIndexWithNonce } from './csp.js'
import { checkRateLimit } from './rate-limit.js'
import { wa, normalizeJid } from './wa.js'
import {
  listConversations,
  listMessages,
  upsertAlias,
  removeAlias,
  listAliases,
  pushNameFor,
  phoneFor,
  reactionsFor,
  receiptsFor,
  resolveContact,
  searchContacts,
  expandJidGroup,
  db,
} from './db.js'
import { dispatchTest } from './webhook.js'
import { WEBHOOK_URL } from './env.js'
import { getUpdates } from './updates.js'
import { bridgeControl } from './bridge-control.js'

const log = pino({ level: 'info' }).child({ mod: 'api' })

// Centralized 5xx handler. We log the real error for the operator and return
// a generic body to the client so internal state (Baileys, SQLite, paths,
// session names) does not leak across the trust boundary.
function internalError(reply: import('fastify').FastifyReply, err: unknown, op: string): void {
  log.error({ op, err: (err as Error).message, stack: (err as Error).stack }, 'route failed')
  reply.code(500).send({ error: 'internal' })
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', wav: 'audio/wav', pdf: 'application/pdf',
}

function mediaUrl(mediaPath: string | null): string | null {
  if (!mediaPath) return null
  const m = mediaPath.match(/data\/media\/([^/]+)\/(.+)$/)
  if (!m) return null
  return `/v1/media/${m[1]}/${m[2]}`
}

function lookupBody(session: string, fullId: string): string | null {
  const row = db
    .prepare(`SELECT body, type FROM messages WHERE id = ? AND session = ?`)
    .get(fullId, session) as { body: string | null; type: string } | undefined
  if (!row) return null
  return row.body ?? `[${row.type}]`
}

function enrichConvo(session: string, row: any) {
  const isGroup = !!row.is_group
  const display = isGroup
    ? (row.chat_name ?? row.push_name ?? pushNameFor(session, row.chat_jid))
    : (row.push_name ?? pushNameFor(session, row.chat_jid) ?? row.chat_name)
  const lastBody = row.last_type === 'audio' && row.last_transcript
    ? `[audio] ${row.last_transcript}`
    : row.last_body
  // chat_jid is already the canonical-after-CTE-collapse; surface the LID-ness
  // and any alias forms so the UI / agents can see when a conversation is
  // LID-only (no phone known) vs fully resolved.
  const aliases = isGroup ? [] : expandJidGroup(session, row.chat_jid).filter((j) => j !== row.chat_jid)
  return {
    chat_jid: row.chat_jid,
    is_group: !!row.is_group,
    is_lid: !isGroup && row.chat_jid.endsWith('@lid'),
    alias_jids: aliases,
    archived: !!row.archived,
    pinned: !!row.pinned,
    unread_count: row.unread_count ?? 0,
    participant_count: row.participant_count ?? null,
    display_name: display,
    phone: phoneFor(session, row.chat_jid),
    profile_pic_url: row.profile_pic_url ?? null,
    last_body: lastBody,
    last_direction: row.last_direction,
    last_type: row.last_type,
    last_ts: row.last_ts,
  }
}

function shortJid(jid: string): string {
  // "94279548584018@lid" -> "~94279548584018"
  // "12025550100:34@s.whatsapp.net" -> "+12025550100"
  const local = jid.split('@')[0].split(':')[0]
  if (jid.endsWith('@s.whatsapp.net') && /^\d+$/.test(local)) return `+${local}`
  if (jid.endsWith('@g.us')) return 'group'
  return `~${local.slice(0, 12)}`
}

function enrichMessage(session: string, row: any) {
  const from_display_name = pushNameFor(session, row.from_jid)
  const from_phone = phoneFor(session, row.from_jid)
  const reactions = reactionsFor(session, row.id).map((r) => ({
    from_jid: r.from_jid,
    from_display_name: pushNameFor(session, r.from_jid),
    from_phone: phoneFor(session, r.from_jid),
    emoji: r.emoji,
    ts: r.ts,
  }))
  const quoted = row.quoted_id ? { id: row.quoted_id, body_preview: lookupBody(session, row.quoted_id) } : null
  const body = row.type === 'audio' && row.transcript
    ? `[audio] ${row.transcript}`
    : row.body
  // Per-participant receipts — only attach if any exist. Returns the
  // highest-state row per participant so the UI does not have to dedupe.
  const rawReceipts = row.direction === 'out' ? receiptsFor(session, row.id) : []
  const byParticipant = new Map<string, { participant: string; status: 'delivered' | 'read' | 'played'; ts: number }>()
  const rank: Record<'delivered' | 'read' | 'played', number> = { delivered: 0, read: 1, played: 2 }
  for (const r of rawReceipts) {
    const cur = byParticipant.get(r.participant)
    if (!cur || rank[r.status] > rank[cur.status]) {
      byParticipant.set(r.participant, { participant: r.participant, status: r.status, ts: r.ts })
    }
  }
  const receipts = Array.from(byParticipant.values()).map((r) => ({
    participant: r.participant,
    participant_label: pushNameFor(session, r.participant) ?? phoneFor(session, r.participant) ?? shortJid(r.participant),
    participant_phone: phoneFor(session, r.participant),
    status: r.status,
    ts: r.ts,
  }))
  return {
    ...row,
    body,
    from_display_name,
    from_phone,
    from_label: from_display_name ?? from_phone ?? shortJid(row.from_jid),
    chat_phone: phoneFor(session, row.chat_jid),
    media_url: mediaUrl(row.media_path),
    reactions,
    quoted,
    ...(receipts.length ? { receipts } : {}),
  }
}

// Simple in-memory idempotency cache for POST /v1/send
const idempotencyCache = new Map<string, { ts: number; payload: unknown }>()
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
function gcIdempotency() {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS
  for (const [k, v] of idempotencyCache) if (v.ts < cutoff) idempotencyCache.delete(k)
}
setInterval(gcIdempotency, 60_000).unref()

// SSRF guard: reject anything that isn't a public http(s) URL. Blocks loopback,
// link-local (169.254/16, including AWS/Hostinger metadata at 169.254.169.254),
// RFC1918 ranges, and IPv6 loopback/ULA. Disables redirect-following so a 302
// can't bypass the check by sending us to internal infra.
const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|0\.|255\.)/i

async function fetchToBuffer(url: string): Promise<{ buf: Buffer; mime: string | null }> {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('media_url must be http(s)')
  }
  if (PRIVATE_HOST_RE.test(u.hostname)) {
    throw new Error('media_url host blocked')
  }
  const res = await fetch(url, { redirect: 'error' })
  if (!res.ok) throw new Error(`media fetch failed: HTTP ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > 25 * 1024 * 1024) throw new Error('media too large')
  const arr = new Uint8Array(await res.arrayBuffer())
  if (arr.byteLength > 25 * 1024 * 1024) throw new Error('media too large')
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null
  return { buf: Buffer.from(arr), mime }
}

export async function startApi(options: { onBridgeControlChange?: (enabled: boolean) => Promise<void> } = {}): Promise<void> {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 })

  const tokenBuf = Buffer.from(API_TOKEN, 'utf8')

  // Baseline security headers on every response. API JSON must never be
  // cached (bearer-protected data); media may cache privately in the browser.
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    const path = req.url.split('?')[0]
    if (path.startsWith('/v1/') && !path.startsWith('/v1/media/')) {
      reply.header('Cache-Control', 'no-store')
    }
  })

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (path === '/v1/health' || path === '/') return

    const headerAuth = req.headers.authorization
    const provided =
      headerAuth?.startsWith('Bearer ') ? headerAuth.slice(7) : ''

    const givenBuf = Buffer.from(provided, 'utf8')
    const ok = givenBuf.length === tokenBuf.length && timingSafeEqual(givenBuf, tokenBuf)
    if (!ok) {
      reply.code(401).send({ error: 'unauthorized' })
      return
    }

    // Rate limit AFTER auth so unauthenticated requests can't consume budget.
    // Bounds runaway agent loops / a leaked token and keeps API send velocity
    // under WhatsApp's observed spam thresholds. See src/rate-limit.ts for the
    // env knobs (RATE_LIMIT_*); reads are never limited.
    const verdict = checkRateLimit(req.method, path)
    if (!verdict.ok) {
      log.warn({ path, rule: verdict.rule }, 'rate limit exceeded')
      reply.header('Retry-After', String(verdict.retryAfterSeconds ?? 60))
      reply.code(429).send({ error: 'rate_limited', rule: verdict.rule, retry_after_seconds: verdict.retryAfterSeconds })
      return
    }
  })

  // ---- static ----
  const indexHtml = readFileSync(resolve('./web/index.html'), 'utf8')
  // Strict CSP. The single-file SPA's one inline <script> is allowed via a
  // per-request nonce instead of 'unsafe-inline'. Inline styles still need
  // 'unsafe-inline' (inline <style> block + style= attributes). Media is
  // fetched as Blobs (blob:); connect-src 'self' covers the API loopback.
  app.get('/', async (_req, reply) => {
    const nonce = makeNonce()
    reply
      .header('Content-Security-Policy', cspWithNonce(nonce))
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html')
      .send(renderIndexWithNonce(indexHtml, nonce))
  })

  app.get<{ Params: { session: string; file: string } }>(
    '/v1/media/:session/:file',
    async (req, reply) => {
      const { session, file } = req.params
      if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
        reply.code(400).send({ error: 'bad session' }); return
      }
      const safeFile = basename(file)
      if (safeFile !== file) {
        reply.code(400).send({ error: 'bad path' }); return
      }
      const path = resolve(`./data/media/${session}/${safeFile}`)
      const root = resolve('./data/media/')
      // root + sep so a sibling dir like data/media-evil/ can never prefix-match.
      if (!path.startsWith(root + sep)) { reply.code(403).send({ error: 'forbidden' }); return }
      if (!existsSync(path)) { reply.code(404).send({ error: 'not found' }); return }
      const ext = safeFile.split('.').pop()?.toLowerCase() ?? ''
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
      reply.type(mime).send(readFileSync(path))
    },
  )

  // ---- system ----
  app.get('/v1/health', async () => ({
    ok: true,
    sessions: wa.list(),
    bridge_enabled: bridgeControl.get().enabled,
    ts: Date.now(),
    updates: getUpdates(),
  }))

  app.get('/v1/bridge/control', async () => bridgeControl.get())

  app.put<{ Body: { enabled?: unknown } }>('/v1/bridge/control', async (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') {
      reply.code(400).send({ error: 'enabled boolean required' })
      return
    }
    const state = bridgeControl.set(req.body.enabled)
    try {
      await options.onBridgeControlChange?.(state.enabled)
      return state
    } catch (err) {
      internalError(reply, err, 'bridge control')
    }
  })

  // ---- conversations / messages ----
  app.get<{ Querystring: { session?: string; limit?: string } }>(
    '/v1/conversations',
    async (req) => {
      const session = req.query.session ?? 'main'
      const limit = Math.min(Number(req.query.limit ?? 100), 500)
      const rows = listConversations(session, limit)
      return { session, conversations: rows.map((r) => enrichConvo(session, r)) }
    },
  )

  app.get<{ Querystring: { session?: string; jid?: string; limit?: string; before?: string } }>(
    '/v1/messages',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid query param required' }); return }
      const limit = Math.min(Number(req.query.limit ?? 50), 500)
      const before = req.query.before ? Number(req.query.before) : undefined
      const rows = listMessages(session, jid, limit, before)
      return { session, jid, messages: rows.map((r) => enrichMessage(session, r)) }
    },
  )

  // ---- send (text or media) ----
  app.post<{
    Body: {
      session?: string
      to?: string
      text?: string
      media_url?: string
      media_base64?: string
      media_kind?: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'
      mime?: string
      filename?: string
      caption?: string
      quoted_id?: string
      sent_by?: 'user' | 'agent' | 'api'
    }
  }>(
    '/v1/send',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const to = req.body.to
      if (!to) { reply.code(400).send({ error: '"to" is required' }); return }

      const idemKey = req.headers['idempotency-key'] as string | undefined
      if (idemKey) {
        const cached = idempotencyCache.get(idemKey)
        if (cached) return cached.payload
      }

      try {
        let result: { id: string; jid: string; ts: number }
        const { text, caption, quoted_id, sent_by, media_url, media_base64, media_kind, mime, filename } = req.body

        if (text && !media_url && !media_base64) {
          result = await wa.sendText(session, to, text, { quoted_id, sent_by })
        } else if (media_url || media_base64) {
          if (!media_kind) { reply.code(400).send({ error: 'media_kind required when sending media' }); return }
          let buf: Buffer
          let detectedMime: string | null = mime ?? null
          if (media_url) {
            const fetched = await fetchToBuffer(media_url)
            buf = fetched.buf
            detectedMime = detectedMime ?? fetched.mime
          } else {
            buf = Buffer.from(media_base64!, 'base64')
          }
          result = await wa.sendMedia(
            session,
            to,
            { kind: media_kind, data: buf, mime: detectedMime ?? undefined, filename },
            { caption, quoted_id, sent_by },
          )
        } else {
          reply.code(400).send({ error: 'either "text" or media_url/media_base64 (with media_kind) required' })
          return
        }

        const payload = { ok: true, ...result }
        if (idemKey) idempotencyCache.set(idemKey, { ts: Date.now(), payload })
        return payload
      } catch (err) { internalError(reply, err, 'send') }
    },
  )

  // ---- structured outbound messages ----
  app.post<{ Body: { session?: string; to?: string; latitude?: number; longitude?: number; name?: string; address?: string } }>(
    '/v1/send/location', async (req, reply) => {
      const { to, latitude, longitude, name, address } = req.body
      if (!to || latitude === undefined || longitude === undefined) { reply.code(400).send({ error: 'to, latitude, and longitude are required' }); return }
      try { return { ok: true, ...await wa.sendLocation(req.body.session ?? 'main', to, { latitude, longitude, name, address }) } }
      catch (err) { internalError(reply, err, 'send_location') }
    },
  )

  app.post<{ Body: { session?: string; to?: string; display_name?: string; phone?: string } }>(
    '/v1/send/contact', async (req, reply) => {
      const { to, display_name, phone } = req.body
      if (!to || !display_name || !phone) { reply.code(400).send({ error: 'to, display_name, and phone are required' }); return }
      try { return { ok: true, ...await wa.sendContact(req.body.session ?? 'main', to, { displayName: display_name, phone }) } }
      catch (err) { internalError(reply, err, 'send_contact') }
    },
  )

  app.post<{ Body: { session?: string; to?: string; name?: string; options?: string[]; selectable_count?: number } }>(
    '/v1/send/poll', async (req, reply) => {
      const { to, name, options, selectable_count } = req.body
      if (!to || !name || !options) { reply.code(400).send({ error: 'to, name, and options are required' }); return }
      try { return { ok: true, ...await wa.sendPoll(req.body.session ?? 'main', to, { name, options, selectableCount: selectable_count }) } }
      catch (err) { internalError(reply, err, 'send_poll') }
    },
  )

  app.post<{ Body: { session?: string; chat_jid?: string; message_id?: string; text?: string } }>(
    '/v1/messages/edit', async (req, reply) => {
      const { chat_jid, message_id, text } = req.body
      if (!chat_jid || !message_id || !text) { reply.code(400).send({ error: 'chat_jid, message_id, and text are required' }); return }
      try { return await wa.editText(req.body.session ?? 'main', chat_jid, message_id, text) }
      catch (err) { internalError(reply, err, 'edit_message') }
    },
  )

  app.post<{ Body: { session?: string; from_chat_jid?: string; message_id?: string; to?: string } }>(
    '/v1/messages/forward', async (req, reply) => {
      const { from_chat_jid, message_id, to } = req.body
      if (!from_chat_jid || !message_id || !to) { reply.code(400).send({ error: 'from_chat_jid, message_id, and to are required' }); return }
      try { return { ok: true, ...await wa.forwardMessage(req.body.session ?? 'main', from_chat_jid, message_id, to) } }
      catch (err) { internalError(reply, err, 'forward_message') }
    },
  )

  // ---- reactions / delete / typing / read / check ----
  app.post<{ Body: { session?: string; chat_jid?: string; message_id?: string; emoji?: string } }>(
    '/v1/react',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { chat_jid, message_id, emoji = '' } = req.body
      if (!chat_jid || !message_id) {
        reply.code(400).send({ error: 'chat_jid and message_id required' }); return
      }
      try {
        await wa.sendReaction(session, message_id, chat_jid, emoji)
        return { ok: true }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.delete<{ Body: { session?: string; chat_jid?: string; message_id?: string; from_me?: boolean; participant?: string } }>(
    '/v1/messages',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { chat_jid, message_id, from_me = true, participant } = req.body
      if (!chat_jid || !message_id) {
        reply.code(400).send({ error: 'chat_jid and message_id required' }); return
      }
      try {
        await wa.deleteMessage(session, message_id, chat_jid, from_me, participant)
        return { ok: true }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; state?: 'composing' | 'paused' | 'recording' | 'available' | 'unavailable' } }>(
    '/v1/typing',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, state = 'composing' } = req.body
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try {
        await wa.sendPresence(session, jid, state)
        return { ok: true, state }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; message_ids?: string[] } }>(
    '/v1/read',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, message_ids } = req.body
      if (!jid || !message_ids?.length) {
        reply.code(400).send({ error: 'jid and message_ids[] required' }); return
      }
      try {
        await wa.markRead(session, jid, message_ids)
        return { ok: true, marked: message_ids.length }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.get<{ Querystring: { session?: string; phone?: string } }>(
    '/v1/check',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const phone = req.query.phone
      if (!phone) { reply.code(400).send({ error: 'phone query param required' }); return }
      try {
        const r = await wa.checkOnWhatsApp(session, phone)
        return { phone, ...r }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  // ---- group operations ----
  app.get<{ Querystring: { session?: string; jid?: string } }>(
    '/v1/groups/info',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { return await wa.groupInfo(session, jid) }
      catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.get<{ Querystring: { session?: string; jid?: string } }>(
    '/v1/groups/invite',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const jid = req.query.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { return { invite_url: await wa.groupInviteLink(session, jid) } }
      catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.post<{ Body: { session?: string; jid?: string } }>(
    '/v1/groups/leave',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const jid = req.body.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try { await wa.groupLeave(session, jid); return { ok: true } }
      catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.post<{ Body: { session?: string; jid?: string; participants?: string[]; action?: 'add' | 'remove' | 'promote' | 'demote' } }>(
    '/v1/groups/participants',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { jid, participants, action } = req.body
      if (!jid || !participants?.length || !action) {
        reply.code(400).send({ error: 'jid, participants[], action required' }); return
      }
      try {
        const normalized = participants.map((p) => normalizeJid(p))
        return { results: await wa.groupParticipants(session, jid, normalized, action) }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  app.post<{ Body: { session?: string; jid?: string } }>(
    '/v1/profile_pic/refresh',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const jid = req.body.jid
      if (!jid) { reply.code(400).send({ error: 'jid required' }); return }
      try {
        const url = await wa.fetchProfilePicture(session, jid)
        return { jid, profile_pic_url: url }
      } catch (err) { internalError(reply, err, 'route') }
    },
  )

  // ---- aliases ----
  app.get<{ Querystring: { session?: string } }>(
    '/v1/aliases',
    async (req) => {
      const session = req.query.session ?? 'main'
      return { session, aliases: listAliases(session) }
    },
  )

  app.post<{ Body: { session?: string; alias?: string; canonical?: string } }>(
    '/v1/aliases',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { alias, canonical } = req.body
      if (!alias || !canonical) {
        reply.code(400).send({ error: 'alias and canonical are required' }); return
      }
      try {
        upsertAlias(session, alias, canonical)
        return { ok: true, session, alias, canonical }
      } catch (err) { internalError(reply, err, 'route-400') }
    },
  )

  app.delete<{ Body: { session?: string; alias?: string } }>(
    '/v1/aliases',
    async (req, reply) => {
      const session = req.body.session ?? 'main'
      const { alias } = req.body
      if (!alias) { reply.code(400).send({ error: 'alias is required' }); return }
      const result = removeAlias(session, alias)
      return { ok: true, removed: result.changes }
    },
  )

  // ---- contacts: resolve / search ----
  // Resolve a single query — JID, phone (digits or +digits), or name substring —
  // to a unified ContactInfo: display name, canonical PN-form JID, phone, plus
  // every known alias JID. Designed for operator workflows like "who is
  // 12345@lid?" and "what's John Smith's JID so I can send them a message?".
  app.get<{ Querystring: { session?: string; q?: string } }>(
    '/v1/contacts/resolve',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const q = req.query.q
      if (!q) { reply.code(400).send({ error: 'q query param required' }); return }
      return resolveContact(session, q)
    },
  )

  app.get<{ Querystring: { session?: string; q?: string; limit?: string } }>(
    '/v1/contacts/search',
    async (req, reply) => {
      const session = req.query.session ?? 'main'
      const q = req.query.q
      if (!q) { reply.code(400).send({ error: 'q query param required' }); return }
      const limit = Math.min(Number(req.query.limit ?? 20), 100)
      return { query: q, matches: searchContacts(session, q, limit) }
    },
  )

  // ---- webhook test ----
  app.post('/v1/webhook/test', async () => {
    // Don't echo WEBHOOK_URL back to callers - config stays server-side.
    return dispatchTest()
  })

  await app.listen({ host: HOST, port: PORT })
  log.info(
    { host: HOST, port: PORT, webhook: WEBHOOK_URL ?? 'disabled' },
    `API listening — token in .env`,
  )
}
