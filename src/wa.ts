import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { chmodSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'

import {
  upsertContact,
  upsertAlias,
  insertMessage,
  upsertChatsBatch,
  updateMessageStatus,
  updateMessageMedia,
  markMessageEdited,
  markMessageDeleted,
  upsertReaction,
  upsertReceipt,
  getMessageDeliveryStatus,
  setChatProfilePic,
  setChatParticipantCount,
  setContactProfilePic,
  setMessageTranscript,
  type Direction,
  type MessageInput,
  type ChatInput,
  type DeliveryStatus,
  type ReceiptStatus,
  type SentBy,
} from './db.js'
import { dispatchInbound } from './webhook.js'
import { transcribeAudio, TranscribeError } from './transcribe.js'
import { OPENAI_API_KEY, FORCE_HISTORY_SYNC_ON_RESTORE } from './env.js'
import { buildContactPayload, buildLocationPayload, buildPollPayload, buildReactionPayload, buildVoicePayload, parseMessageId } from './outbound.js'
import { recordOperatorReply } from './autoreply-store.js'

export function scanRegisteredSessions(authDir = './auth'): string[] {
  if (!existsSync(authDir)) return []
  const names: string[] = []
  for (const entry of readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const credsPath = `${authDir}/${entry.name}/creds.json`
    if (!existsSync(credsPath)) continue
    try {
      const creds = JSON.parse(readFileSync(credsPath, 'utf8'))
      if (creds?.registered === true || creds?.me?.id) names.push(entry.name)
    } catch {
      /* skip unreadable */
    }
  }
  return names.sort()
}

const log = pino({ level: 'info' }).child({ mod: 'wa' })

function getType(message: any): string {
  if (!message) return 'unknown'
  if (message.conversation || message.extendedTextMessage) return 'text'
  if (message.imageMessage) return 'image'
  if (message.videoMessage) return 'video'
  if (message.audioMessage) return 'audio'
  if (message.documentMessage) return 'document'
  if (message.stickerMessage) return 'sticker'
  if (message.contactMessage) return 'contact'
  if (message.locationMessage) return 'location'
  if (message.reactionMessage) return 'reaction'
  if (message.protocolMessage) return 'protocol'
  return 'unknown'
}

function getBody(message: any): string | null {
  if (!message) return null
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.reactionMessage?.text ??
    null
  )
}

function extractTs(raw: unknown): number {
  if (raw && typeof raw === 'object' && 'toNumber' in raw && typeof (raw as any).toNumber === 'function') {
    return (raw as any).toNumber() * 1000
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now()
}

function getContextInfo(message: any): any {
  return (
    message?.extendedTextMessage?.contextInfo ??
    message?.imageMessage?.contextInfo ??
    message?.videoMessage?.contextInfo ??
    message?.audioMessage?.contextInfo ??
    message?.documentMessage?.contextInfo ??
    message?.stickerMessage?.contextInfo ??
    null
  )
}

function getMediaInfo(message: any): { mime: string | null; size: number | null } {
  const m =
    message?.imageMessage ??
    message?.videoMessage ??
    message?.audioMessage ??
    message?.documentMessage ??
    message?.stickerMessage
  if (!m) return { mime: null, size: null }
  const size = m.fileLength
  return {
    mime: m.mimetype ?? null,
    size:
      typeof size === 'object' && size && 'toNumber' in size
        ? (size as any).toNumber()
        : (typeof size === 'number' ? size : null),
  }
}

function toMessageRow(msg: any, session: string, ourJid: string | undefined): MessageInput | null {
  const id = msg?.key?.id
  const remoteJid = msg?.key?.remoteJid
  if (!id || !remoteJid) return null

  const type = getType(msg.message)
  if (type === 'protocol' || type === 'unknown') return null

  const isGroup = remoteJid.endsWith('@g.us')
  const direction: Direction = msg.key.fromMe ? 'out' : 'in'
  const fromJid = msg.key.fromMe
    ? (ourJid ?? remoteJid)
    : (isGroup ? (msg.key.participant ?? remoteJid) : remoteJid)

  const ctx = getContextInfo(msg.message)
  const quotedStanzaId = ctx?.stanzaId ?? null
  const { mime, size } = getMediaInfo(msg.message)

  return {
    id: `${session}:${id}`,
    session,
    chat_jid: remoteJid,
    from_jid: fromJid,
    direction,
    type,
    body: getBody(msg.message),
    media_path: null,
    ts: Math.floor(extractTs(msg.messageTimestamp)),
    raw_json: JSON.stringify(msg),
    sent_by: direction === 'out' ? 'user' : null,
    delivery_status: null,
    quoted_id: quotedStanzaId ? `${session}:${quotedStanzaId}` : null,
    media_mime: mime,
    media_size: size,
  }
}

const STATUS_MAP: Record<number, DeliveryStatus> = {
  1: 'pending',
  2: 'server',
  3: 'delivered',
  4: 'read',
  5: 'played',
}

function mediaExtension(mime: string | null, fallbackType: string): string {
  if (!mime) {
    if (fallbackType === 'image') return 'jpg'
    if (fallbackType === 'video') return 'mp4'
    if (fallbackType === 'audio') return 'ogg'
    if (fallbackType === 'sticker') return 'webp'
    return 'bin'
  }
  const m = mime.toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('png')) return 'png'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  // audio/mp4 is an M4A container — OpenAI's transcription endpoint sniffs the
  // filename and rejects voicenotes saved as .mp4, so map audio first.
  if (m.startsWith('audio/') && (m.includes('mp4') || m.includes('m4a') || m.includes('aac'))) return 'm4a'
  if (m.includes('mp4')) return 'mp4'
  if (m.includes('mpeg')) return 'mp3'
  if (m.includes('ogg') || m.includes('opus')) return 'ogg'
  if (m.includes('wav')) return 'wav'
  if (m.includes('pdf')) return 'pdf'
  const slash = m.split('/')[1] ?? ''
  return slash.split(';')[0] || 'bin'
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document', 'sticker'])

async function downloadAndStoreMedia(
  sock: WASocket,
  msg: WAMessage,
  session: string,
  msgId: string,
  type: string,
  mime: string | null,
): Promise<void> {
  if (!MEDIA_TYPES.has(type)) return
  try {
    const dir = `./data/media/${session}`
    mkdirSync(dir, { recursive: true })
    const ext = mediaExtension(mime, type)
    const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const path = `${dir}/${safeId}.${ext}`
    const buf = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }) as any, reuploadRequest: sock.updateMediaMessage },
    )
    if (buf instanceof Buffer) {
      writeFileSync(path, buf)
      updateMessageMedia(`${session}:${msgId}`, path, mime, buf.length)
      log.info({ session, msgId, type, bytes: buf.length, path }, 'media downloaded')
      if (type === 'audio' && OPENAI_API_KEY) {
        void transcribeAndStore(session, msgId, path, mime)
      }
    }
  } catch (err) {
    log.warn(
      { session, msgId, type, err: (err as Error).message },
      'media download failed',
    )
  }
}

async function transcribeAndStore(
  session: string,
  msgId: string,
  path: string,
  mime: string | null,
): Promise<void> {
  try {
    const text = await transcribeAudio(path, { mime })
    if (text) {
      setMessageTranscript(`${session}:${msgId}`, text)
      log.info({ session, msgId, chars: text.length }, 'audio transcribed')
    }
  } catch (err) {
    const isApi = err instanceof TranscribeError
    log.warn(
      { session, msgId, err: (err as Error).message, kind: isApi ? 'api' : 'unknown' },
      'transcribe failed',
    )
  }
}

export function normalizeJid(to: string): string {
  if (to.includes('@')) return to
  const digits = to.replace(/[^0-9]/g, '')
  return `${digits}@s.whatsapp.net`
}

class WaManager {
  private sessions = new Map<string, WASocket>()

  async start(name: string, pairingNumber?: string): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth/${name}`)
    // auth/ holds the session keys (= full account access) — block other local users.
    try {
      chmodSync('./auth', 0o700)
    } catch {}
    const { version } = await fetchLatestBaileysVersion()
    const usePairingCode = !!pairingNumber
    const enableHistorySync = usePairingCode || FORCE_HISTORY_SYNC_ON_RESTORE

    if (FORCE_HISTORY_SYNC_ON_RESTORE && !usePairingCode) {
      log.warn(
        { session: name },
        'forcing history sync on restore via WA_FORCE_HISTORY_SYNC_ON_RESTORE',
      )
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: usePairingCode ? Browsers.macOS('Safari') : Browsers.macOS('Desktop'),
      printQRInTerminal: false,
      // Full history sync is only useful while establishing a fresh paired device.
      // Leaving it on for every restore/reconnect can trigger noisy repeated
      // "Syncing with WhatsApp on Safari (macOS)" notifications on the phone.
      syncFullHistory: enableHistorySync,
      // On normal restores, skip the extra initial sync queries/history pulls.
      // We already persist local state, so this reduces noisy companion-sync churn.
      fireInitQueries: enableHistorySync,
      shouldSyncHistoryMessage: () => enableHistorySync,
      markOnlineOnConnect: false,
      // When the recipient (or the sender's own phone) cannot decrypt a message
      // because it came online late or its session rotated, WhatsApp asks the
      // sender to retransmit the plaintext. Without this callback Baileys returns
      // undefined and the recipient is stuck on "Waiting for this message…".
      getMessage: async (key) => {
        if (!key.id) return undefined
        const fullId = `${name}:${key.id}`
        try {
          const row = (await import('./db.js')).db
            .prepare('SELECT body, type, raw_json FROM messages WHERE id = ?')
            .get(fullId) as { body: string | null; type: string; raw_json: string | null } | undefined
          if (!row) return undefined
          if (row.type === 'text' && row.body) return { conversation: row.body }
          if (row.raw_json) {
            try {
              const parsed = JSON.parse(row.raw_json) as { message?: unknown }
              return (parsed.message as any) ?? undefined
            } catch { /* fall through */ }
          }
          return undefined
        } catch { return undefined }
      },
    })

    this.sessions.set(name, sock)

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && !usePairingCode) {
        log.info({ session: name }, 'scan this QR with WhatsApp on your phone')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        log.info({ session: name, jid: sock.user?.id }, 'connected')
        // Do not immediately fan out 188 group-metadata requests while a newly
        // restored Web session is still settling. That churn can cause WhatsApp
        // to close the transport before an outbound USync/send completes.
        setTimeout(() => {
          if (this.sessions.get(name) === sock) void this.refreshGroupMetadata(name, sock)
        }, 30_000)
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
        const loggedOut = code === DisconnectReason.loggedOut
        log.warn({ session: name, code, loggedOut }, 'connection closed')
        this.sessions.delete(name)
        if (!loggedOut) {
          setTimeout(() => this.start(name, pairingNumber), 2_000)
        }
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        // Reaction messages are handled separately — they reference another msg
        const reaction = msg.message?.reactionMessage
        if (reaction) {
          const targetId = reaction.key?.id
          if (targetId) {
            const reactorJid = msg.key.fromMe
              ? (sock.user?.id ?? '')
              : (msg.key.participant ?? msg.key.remoteJid ?? '')
            upsertReaction({
              session: name,
              message_id: `${name}:${targetId}`,
              from_jid: reactorJid,
              emoji: reaction.text ?? '',
              ts: Math.floor(extractTs(msg.messageTimestamp)),
            })
            log.info(
              { session: name, target: targetId, emoji: reaction.text, from: reactorJid },
              'reaction',
            )
          }
          continue
        }

        const row = toMessageRow(msg, name, sock.user?.id)
        if (!row) continue

        if (row.direction === 'in') {
          upsertContact({
            jid: row.from_jid,
            push_name: msg.pushName ?? null,
            is_lid: row.from_jid.endsWith('@lid') ? 1 : 0,
            ts: row.ts,
          })
        }

        const result = insertMessage(row)
        if (result.changes > 0) {
          if (row.direction === 'out' && row.sent_by === 'user' && row.body?.trim()) {
            try {
              recordOperatorReply({
                message_id: row.id,
                session: row.session,
                chat_jid: row.chat_jid,
                body: row.body,
                ts: row.ts,
              })
            } catch (error) {
              log.warn({ err: (error as Error).message, session: name }, 'operator reply signal persist failed')
            }
          }
          log.info(
            // Message body intentionally NOT logged — bodies are sensitive and the
            // log file is plaintext on disk. Length only.
            { session: name, dir: row.direction, from: row.from_jid, type: row.type, body_len: row.body?.length ?? 0 },
            row.direction === 'in' ? 'inbound' : 'outbound',
          )
          if (row.direction === 'in') dispatchInbound(row)
          if (MEDIA_TYPES.has(row.type) && msg.key.id) {
            void downloadAndStoreMedia(sock, msg, name, msg.key.id, row.type, row.media_mime)
          }
        }
      }
    })

    // Delivery status, edits, deletes
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        const id = u.key?.id
        if (!id) continue
        const fullId = `${name}:${id}`

        // Status update (1=pending, 2=server, 3=delivered, 4=read, 5=played)
        const newStatus =
          typeof u.update?.status === 'number' ? STATUS_MAP[u.update.status] : undefined
        if (newStatus) updateMessageStatus(fullId, newStatus)

        // Deletion via revoke
        const stub = (u.update as any)?.messageStubType
        if (stub === 1 || stub === 2) {
          markMessageDeleted(fullId)
        }

        // Edit: protocol message indicates an edit; the new content lives in
        // protocolMessage.editedMessage on inbound. We capture body change here.
        const edited =
          (u.update as any)?.message?.editedMessage?.message ??
          (u.update as any)?.message?.protocolMessage?.editedMessage
        if (edited) {
          const newBody = getBody(edited) ?? null
          markMessageEdited(fullId, newBody)
        }
      }
    })

    // Per-participant delivery / read receipts (mainly for groups, also
    // emitted for 1:1 in some Baileys versions). The `receipt` carries
    // timestamps for delivered / read / played per `userJid`.
    sock.ev.on('message-receipt.update', (events) => {
      for (const ev of events) {
        const id = ev.key?.id
        const participant = ev.receipt?.userJid
        if (!id || !participant) continue
        const fullId = `${name}:${id}`

        const r = ev.receipt
        const toMs = (v: unknown): number | null => {
          if (v == null) return null
          if (typeof v === 'object' && v && 'toNumber' in (v as any)) {
            const n = (v as any).toNumber()
            return Number.isFinite(n) && n > 0 ? n * 1000 : null
          }
          const n = Number(v)
          return Number.isFinite(n) && n > 0 ? n * 1000 : null
        }

        const playedTs = toMs(r.playedTimestamp)
        const readTs = toMs(r.readTimestamp)
        const deliveredTs = toMs(r.receiptTimestamp)

        let highest: ReceiptStatus | null = null
        if (deliveredTs != null) {
          upsertReceipt({ session: name, message_id: fullId, participant, status: 'delivered', ts: deliveredTs })
          highest = 'delivered'
        }
        if (readTs != null) {
          upsertReceipt({ session: name, message_id: fullId, participant, status: 'read', ts: readTs })
          highest = 'read'
        }
        if (playedTs != null) {
          upsertReceipt({ session: name, message_id: fullId, participant, status: 'played', ts: playedTs })
          highest = 'played'
        }

        // Bump the aggregate delivery_status — for groups Baileys does not
        // necessarily emit `messages.update` with status, so this keeps the
        // 1-line tick in sync with "any participant has reached state Y".
        if (highest) {
          const rank: Record<DeliveryStatus, number> = {
            pending: 0, server: 1, delivered: 2, read: 3, played: 4,
          }
          const cur = getMessageDeliveryStatus(fullId)
          const curRank = cur ? rank[cur] : -1
          if (rank[highest] > curRank) updateMessageStatus(fullId, highest)
        }
      }
    })

    // Reaction event (alternate path some Baileys versions use)
    sock.ev.on('messages.reaction', (reactions) => {
      for (const r of reactions) {
        const targetId = r.key?.id
        if (!targetId) continue
        const reactorJid = r.key.fromMe
          ? (sock.user?.id ?? '')
          : (r.key.participant ?? r.key.remoteJid ?? '')
        upsertReaction({
          session: name,
          message_id: `${name}:${targetId}`,
          from_jid: reactorJid,
          emoji: r.reaction?.text ?? '',
          ts: Date.now(),
        })
      }
    })

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      const chatRows: ChatInput[] = []
      for (const chat of chats) {
        if (!chat.id) continue
        chatRows.push({
          session: name,
          jid: chat.id,
          name: chat.name ?? null,
          is_group: chat.id.endsWith('@g.us') ? 1 : 0,
          archived: chat.archived ? 1 : 0,
          pinned: chat.pinned ? 1 : 0,
          mute_until: chat.muteEndTime ? Number(chat.muteEndTime) * 1000 : null,
          unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
          last_msg_ts: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp) * 1000
            : null,
          raw_json: JSON.stringify(chat),
        })
      }
      if (chatRows.length) upsertChatsBatch(chatRows)

      for (const c of contacts) {
        if (!c.id) continue
        upsertContact({
          jid: c.id,
          push_name: c.name ?? c.notify ?? null,
          is_lid: c.id.endsWith('@lid') ? 1 : 0,
          ts: Date.now(),
        })
      }

      let inserted = 0
      for (const msg of messages) {
        const row = toMessageRow(msg, name, sock.user?.id)
        if (!row) continue
        if (row.direction === 'in') {
          upsertContact({
            jid: row.from_jid,
            push_name: msg.pushName ?? null,
            is_lid: row.from_jid.endsWith('@lid') ? 1 : 0,
            ts: row.ts,
          })
        }
        const r = insertMessage(row)
        if (r.changes > 0) inserted++
      }

      log.info(
        {
          session: name,
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          inserted,
          isLatest: isLatest ?? false,
          progress: progress ?? null,
        },
        'history sync batch',
      )
    })

    sock.ev.on('chats.upsert', (newChats) => {
      const rows: ChatInput[] = []
      for (const chat of newChats) {
        if (!chat.id) continue
        rows.push({
          session: name,
          jid: chat.id,
          name: chat.name ?? null,
          is_group: chat.id.endsWith('@g.us') ? 1 : 0,
          archived: chat.archived ? 1 : 0,
          pinned: chat.pinned ? 1 : 0,
          mute_until: chat.muteEndTime ? Number(chat.muteEndTime) * 1000 : null,
          unread_count: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
          last_msg_ts: chat.conversationTimestamp
            ? Number(chat.conversationTimestamp) * 1000
            : null,
          raw_json: JSON.stringify(chat),
        })
      }
      if (rows.length) upsertChatsBatch(rows)
    })

    sock.ev.on('contacts.upsert', (newContacts) => {
      for (const c of newContacts) {
        if (!c.id) continue
        upsertContact({
          jid: c.id,
          push_name: c.name ?? c.notify ?? null,
          is_lid: c.id.endsWith('@lid') ? 1 : 0,
          ts: Date.now(),
        })
      }
    })

    if (usePairingCode && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(pairingNumber)
          const formatted = code.match(/.{1,4}/g)?.join('-') ?? code
          log.info({ session: name, number: pairingNumber, code: formatted }, 'pairing code ready')
        } catch (err) {
          log.error({ err }, 'failed to request pairing code')
        }
      }, 3_000)
    }
  }

  get(name: string): WASocket | undefined {
    return this.sessions.get(name)
  }

  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  private async refreshGroupMetadata(name: string, sock: WASocket): Promise<void> {
    try {
      const { db } = await import('./db.js')
      const groups = db
        .prepare(
          `SELECT jid, name FROM chats
           WHERE session = ? AND is_group = 1`,
        )
        .all(name) as Array<{ jid: string; name: string | null }>

      if (!groups.length) return
      const needsName = groups.filter((g) => !g.name)
      log.info(
        { session: name, total: groups.length, need_name: needsName.length },
        'fetching group metadata + participants',
      )

      let updatedNames = 0
      let upsertedParticipants = 0
      let aliasesWritten = 0
      const ts = Date.now()
      for (const g of groups) {
        try {
          const meta = await sock.groupMetadata(g.jid)
          if (meta?.subject && !g.name) {
            db.prepare(
              `UPDATE chats SET name = ?, updated_at = ? WHERE session = ? AND jid = ?`,
            ).run(meta.subject, ts, name, g.jid)
            updatedNames++
          }
          if (meta?.participants?.length) {
            setChatParticipantCount(name, g.jid, meta.participants.length)
            for (const p of meta.participants) {
              if (!p.id) continue
              const pAny = p as { id: string; lid?: string; jid?: string; name?: string; notify?: string }
              const pushName = pAny.name ?? pAny.notify ?? null
              // pAny.id is whatever the group addresses this person as (PN or LID).
              // pAny.jid (if present) is the PN form, pAny.lid (if present) is the LID form.
              // Pick canonical = PN form when known; fall back to id.
              const lidForm = pAny.id.endsWith('@lid') ? pAny.id : pAny.lid ?? null
              const pnForm = pAny.id.endsWith('@s.whatsapp.net') ? pAny.id : pAny.jid ?? null

              // Always upsert the addressed id so messages from this group can resolve
              upsertContact({
                jid: pAny.id,
                push_name: pushName,
                is_lid: pAny.id.endsWith('@lid') ? 1 : 0,
                ts,
              })
              upsertedParticipants++

              // If we have BOTH forms, mirror the contact and write the alias
              if (lidForm && pnForm && lidForm !== pnForm) {
                upsertContact({
                  jid: lidForm,
                  push_name: pushName,
                  is_lid: 1,
                  ts,
                })
                upsertContact({
                  jid: pnForm,
                  push_name: pushName,
                  is_lid: 0,
                  ts,
                })
                upsertAlias(name, lidForm, pnForm)
                aliasesWritten++
              }
            }
          }
        } catch {
          /* group may be inaccessible (left, banned, etc.) — skip silently */
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      log.info(
        {
          session: name,
          updated_names: updatedNames,
          upserted_participants: upsertedParticipants,
          aliases_written: aliasesWritten,
        },
        'group metadata done',
      )
    } catch (err) {
      log.warn({ err: (err as Error).message, session: name }, 'group metadata refresh failed')
    }
  }

  async sendText(
    name: string,
    to: string,
    text: string,
    opts: { quoted_id?: string; sent_by?: SentBy } = {},
  ): Promise<{ id: string; jid: string; ts: number }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)

    const jid = normalizeJid(to)
    const sendOpts: any = {}
    if (opts.quoted_id) {
      const stanzaId = opts.quoted_id.startsWith(`${name}:`)
        ? opts.quoted_id.slice(name.length + 1)
        : opts.quoted_id
      sendOpts.quoted = { key: { remoteJid: jid, id: stanzaId, fromMe: false }, message: {} }
    }

    const result = await sock.sendMessage(jid, { text }, sendOpts)
    if (!result?.key?.id) throw new Error('send failed: no message id returned')

    const ts = Date.now()
    insertMessage({
      id: `${name}:${result.key.id}`,
      session: name,
      chat_jid: jid,
      from_jid: sock.user?.id ?? 'unknown',
      direction: 'out',
      type: 'text',
      body: text,
      media_path: null,
      ts,
      raw_json: JSON.stringify(result),
      sent_by: opts.sent_by ?? 'api',
      delivery_status: 'pending',
      quoted_id: opts.quoted_id ?? null,
      media_mime: null,
      media_size: null,
    })

    log.info({ session: name, to: jid, body_len: text.length }, 'sent text')
    return { id: result.key.id, jid, ts }
  }

  async sendMedia(
    name: string,
    to: string,
    media: { kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker'; data: Buffer; mime?: string; filename?: string },
    opts: { caption?: string; quoted_id?: string; sent_by?: SentBy } = {},
  ): Promise<{ id: string; jid: string; ts: number }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)

    const jid = normalizeJid(to)
    const payload: any = {}
    if (media.kind === 'image') payload.image = media.data
    else if (media.kind === 'video') payload.video = media.data
    else if (media.kind === 'audio') {
      payload.audio = media.data
      payload.mimetype = media.mime ?? 'audio/ogg; codecs=opus'
      payload.ptt = false
    } else if (media.kind === 'voice') {
      Object.assign(payload, buildVoicePayload(media.data, media.mime))
    } else if (media.kind === 'sticker') {
      payload.sticker = media.data
      if (media.mime) payload.mimetype = media.mime
    } else if (media.kind === 'document') {
      payload.document = media.data
      payload.fileName = media.filename ?? 'file'
      if (media.mime) payload.mimetype = media.mime
    }
    if (opts.caption && (media.kind === 'image' || media.kind === 'video' || media.kind === 'document')) {
      payload.caption = opts.caption
    }
    if (media.mime && (media.kind === 'image' || media.kind === 'video')) payload.mimetype = media.mime

    const sendOpts: any = {}
    if (opts.quoted_id) {
      const stanzaId = opts.quoted_id.startsWith(`${name}:`)
        ? opts.quoted_id.slice(name.length + 1)
        : opts.quoted_id
      sendOpts.quoted = { key: { remoteJid: jid, id: stanzaId, fromMe: false }, message: {} }
    }

    const result = await sock.sendMessage(jid, payload, sendOpts)
    if (!result?.key?.id) throw new Error('send failed: no message id returned')

    const ts = Date.now()
    // Persist locally so the UI sees it immediately (also eventually echoed by upsert)
    const dir = `./data/media/${name}`
    mkdirSync(dir, { recursive: true })
    const safeId = result.key.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    const ext = mediaExtension(media.mime ?? null, media.kind === 'voice' ? 'audio' : media.kind)
    const path = `${dir}/${safeId}.${ext}`
    try {
      writeFileSync(path, media.data)
    } catch {
      /* non-fatal */
    }

    insertMessage({
      id: `${name}:${result.key.id}`,
      session: name,
      chat_jid: jid,
      from_jid: sock.user?.id ?? 'unknown',
      direction: 'out',
      type: media.kind === 'voice' ? 'audio' : media.kind,
      body: opts.caption ?? null,
      media_path: path,
      ts,
      raw_json: JSON.stringify(result),
      sent_by: opts.sent_by ?? 'api',
      delivery_status: 'pending',
      quoted_id: opts.quoted_id ?? null,
      media_mime: media.mime ?? null,
      media_size: media.data.length,
    })

    log.info(
      { session: name, to: jid, kind: media.kind, bytes: media.data.length },
      'sent media',
    )
    return { id: result.key.id, jid, ts }
  }

  private async sendStructured(
    name: string,
    to: string,
    content: Record<string, unknown>,
    type: string,
    body: string | null = null,
  ): Promise<{ id: string; jid: string; ts: number }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const jid = normalizeJid(to)
    const result = await sock.sendMessage(jid, content as any)
    if (!result?.key?.id) throw new Error('send failed: no message id returned')
    const ts = Date.now()
    insertMessage({
      id: `${name}:${result.key.id}`, session: name, chat_jid: jid, from_jid: sock.user?.id ?? 'unknown',
      direction: 'out', type, body, media_path: null, ts, raw_json: JSON.stringify(result),
      sent_by: 'api', delivery_status: 'pending', quoted_id: null, media_mime: null, media_size: null,
    })
    return { id: result.key.id, jid, ts }
  }

  async sendLocation(name: string, to: string, input: Parameters<typeof buildLocationPayload>[0]) {
    return this.sendStructured(name, to, buildLocationPayload(input), 'location', input.name ?? input.address ?? null)
  }

  async sendContact(name: string, to: string, input: Parameters<typeof buildContactPayload>[0]) {
    return this.sendStructured(name, to, buildContactPayload(input), 'contact', input.displayName)
  }

  async sendPoll(name: string, to: string, input: Parameters<typeof buildPollPayload>[0]) {
    return this.sendStructured(name, to, buildPollPayload(input), 'poll', input.name)
  }

  async editText(name: string, chatJid: string, messageId: string, text: string) {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    if (!text.trim() || text.length > 4096) throw new Error('text must contain 1 to 4096 characters')
    const jid = normalizeJid(chatJid)
    const id = parseMessageId(messageId, name)
    const result = await sock.sendMessage(jid, { text, edit: { remoteJid: jid, id, fromMe: true } } as any)
    if (!result?.key?.id) throw new Error('edit failed: no message id returned')
    markMessageEdited(`${name}:${id}`, text)
    return { ok: true, id: result.key.id }
  }

  async forwardMessage(name: string, fromChatJid: string, messageId: string, to: string) {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const id = parseMessageId(messageId, name)
    const { db } = await import('./db.js')
    const row = db.prepare('SELECT raw_json, type, body FROM messages WHERE id = ? AND chat_jid = ? AND session = ?')
      .get(`${name}:${id}`, normalizeJid(fromChatJid), name) as { raw_json: string | null; type: string; body: string | null } | undefined
    if (!row?.raw_json) throw new Error('message is not available locally for forwarding')
    const original = JSON.parse(row.raw_json)
    return this.sendStructured(name, to, { forward: original }, row.type, row.body)
  }

  async sendReaction(
    name: string,
    targetMessageId: string,
    targetChatJid: string,
    emoji: string,
  ): Promise<{ ok: true }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const stanzaId = targetMessageId.startsWith(`${name}:`)
      ? targetMessageId.slice(name.length + 1)
      : targetMessageId
    await sock.sendMessage(targetChatJid, buildReactionPayload({ chatJid: targetChatJid, messageId: stanzaId, emoji }))
    upsertReaction({
      session: name,
      message_id: `${name}:${stanzaId}`,
      from_jid: sock.user?.id ?? '',
      emoji,
      ts: Date.now(),
    })
    return { ok: true }
  }

  async deleteMessage(
    name: string,
    targetMessageId: string,
    targetChatJid: string,
    targetFromMe = true,
    targetParticipant?: string,
  ): Promise<{ ok: true }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const stanzaId = targetMessageId.startsWith(`${name}:`)
      ? targetMessageId.slice(name.length + 1)
      : targetMessageId
    await sock.sendMessage(targetChatJid, {
      delete: {
        remoteJid: targetChatJid,
        id: stanzaId,
        fromMe: targetFromMe,
        participant: targetParticipant,
      },
    })
    markMessageDeleted(`${name}:${stanzaId}`)
    return { ok: true }
  }

  async sendPresence(
    name: string,
    jid: string,
    state: 'composing' | 'paused' | 'recording' | 'available' | 'unavailable',
  ): Promise<void> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    await sock.sendPresenceUpdate(state, normalizeJid(jid))
  }

  async markRead(name: string, jid: string, messageIds: string[]): Promise<void> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const keys = messageIds.map((id) => ({
      remoteJid: normalizeJid(jid),
      id: id.startsWith(`${name}:`) ? id.slice(name.length + 1) : id,
      fromMe: false,
    }))
    await sock.readMessages(keys)
  }

  async checkOnWhatsApp(
    name: string,
    phone: string,
  ): Promise<{ exists: boolean; jid: string | null; lid: string | null }> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    const digits = phone.replace(/[^0-9]/g, '')
    const results = await sock.onWhatsApp(digits)
    if (!results || results.length === 0) return { exists: false, jid: null, lid: null }
    const r = results[0] as { exists?: unknown; jid?: string; lid?: unknown }
    const lidVal = typeof r.lid === 'string' ? r.lid : null
    return { exists: !!r.exists, jid: r.jid ?? null, lid: lidVal }
  }

  async groupInfo(name: string, jid: string) {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    return sock.groupMetadata(jid)
  }

  async groupInviteLink(name: string, jid: string): Promise<string> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    return sock.groupInviteCode(jid).then((code) => `https://chat.whatsapp.com/${code}`)
  }

  async groupLeave(name: string, jid: string): Promise<void> {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    await sock.groupLeave(jid)
  }

  async groupParticipants(
    name: string,
    jid: string,
    participants: string[],
    action: 'add' | 'remove' | 'promote' | 'demote',
  ) {
    const sock = this.get(name)
    if (!sock) throw new Error(`session "${name}" not connected`)
    return sock.groupParticipantsUpdate(jid, participants, action)
  }

  async fetchProfilePicture(name: string, jid: string): Promise<string | null> {
    const sock = this.get(name)
    if (!sock) return null
    try {
      const url = await sock.profilePictureUrl(jid, 'image')
      if (url) {
        if (jid.endsWith('@g.us')) setChatProfilePic(name, jid, url)
        else setContactProfilePic(jid, url)
      }
      return url ?? null
    } catch {
      return null
    }
  }
}

export const wa = new WaManager()
