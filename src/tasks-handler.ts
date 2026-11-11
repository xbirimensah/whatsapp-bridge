// WhatsApp side of the task pipeline:
//  - inbound chats: spot tasks, then either queue them (trusted auto chats,
//    easy + safe) or ask the operator in the self-chat with a short plan
//  - self-chat: "yes/no/later" approvals, and anything else = a new order
import { appendAudit } from './autoreply-store.js'
import { fetchRecentMessages, sendTextReply, waitForInboundMessageContext } from './autoreply-wa.js'
import { chatInList, isSelfChat, readTasksConfig, resolveWorkspace, workspaceForChat, type TasksConfig } from './tasks-config.js'
import { detectTask } from './tasks-detect.js'
import {
  bareMessageId,
  createTask,
  findTaskByAlert,
  findTaskBySourceMessage,
  getTask,
  latestOpenTask,
  updateTask,
  type Task,
} from './tasks-store.js'

export interface TaskSignalInput {
  session: string
  chatJid: string
  chatJids: string[]
  messageId: string | null
  direction: string | null
  sentBy: string | null
  type: string | null
  text: string
  contactLabel: string
  isGroup: boolean
  taggedForOperator: boolean
}

const MAX_DECISION_CHARS = 30
const MIN_ORDER_CHARS = 4
// Approvals work in English and German.
const APPROVE = /^\s*(ja|jap|yes|yep|ok|okay|go|mach|machs|mach es|los|passt|👍)(?=$|[\s.!,#])\s*#?(\d+)?/i
const REJECT = /^\s*(nein|nö|no|stop|abbrechen|lass|cancel)(?=$|[\s.!,#])\s*#?(\d+)?/i
const LATER = /^\s*(später|spaeter|later)(?=$|[\s.!,#])\s*#?(\d+)?/i
// Our own alerts start with these markers; never treat them as orders.
const OWN_MARKERS = /^(📋|⚙️|✅|❌|👍|⏸️|🛑|ℹ️)/u

export type DecisionKind = 'approve' | 'reject' | 'later'

/** Reads a short self-chat reply such as "yes", "no 12" or "later #3". */
export function parseDecision(text: string): { kind: DecisionKind; id: string | undefined } | null {
  if (text.length > MAX_DECISION_CHARS) return null
  const approve = APPROVE.exec(text)
  if (approve) return { kind: 'approve', id: approve[2] }
  const reject = REJECT.exec(text)
  if (reject) return { kind: 'reject', id: reject[2] }
  const later = LATER.exec(text)
  if (later) return { kind: 'later', id: later[2] }
  return null
}

function workspaceLabel(config: TasksConfig, task: Task): string {
  return resolveWorkspace(config, task.workspace).label
}

async function sendToSelf(config: TasksConfig, session: string, text: string, quotedId: string | null = null): Promise<string | null> {
  const to = config.self_jids[0]
  if (!to) return null
  try {
    const sent = await sendTextReply({ session, to, text, quoted_id: quotedId })
    return sent.id ?? null
  } catch (err) {
    appendAudit('safety_blocked', { reason: 'task self-chat send failed', error: (err as Error).message })
    return null
  }
}

async function recentContext(config: TasksConfig, session: string, chatJid: string, contactLabel: string, skipId: string | null): Promise<string> {
  try {
    const msgs = await fetchRecentMessages(chatJid, session, 10)
    const skip = bareMessageId(skipId)
    return msgs
      .filter((m) => bareMessageId(m.id) !== skip)
      .reverse()
      .map((m) => {
        const who = m.from_me ? config.operator_name : contactLabel
        const text = (m.transcript || m.body || `[${m.type ?? 'media'}]`).replace(/\s+/g, ' ').slice(0, 300)
        return `${who}: ${text}`
      })
      .join('\n')
  } catch {
    return ''
  }
}

function planLines(task: Task): string {
  return task.plan.map((step, i) => `${i + 1}) ${step}`).join('\n')
}

export function alertText(config: TasksConfig, task: Task): string {
  const head = `📋 #${task.id} ${task.title}\nfrom ${task.source.contact_label} (${workspaceLabel(config, task)})`
  return `${head}\n\n${task.summary}\n\nPlan:\n${planLines(task)}\n\nyes / no / later (reply to this message or send "yes ${task.id}")`
}

async function transcriptOf(input: TaskSignalInput): Promise<string> {
  if (input.text || input.type !== 'audio' || !input.messageId) return input.text
  const ctx = await waitForInboundMessageContext({
    jid: input.chatJid,
    messageId: input.messageId,
    session: input.session,
    desiredType: 'audio',
    attempts: 30,
    delayMs: 3000,
  }).catch(() => null)
  return (ctx?.transcript || ctx?.body || '').trim()
}

async function handleInbound(config: TasksConfig, rawInput: TaskSignalInput): Promise<void> {
  if (rawInput.direction !== 'in') return
  if (rawInput.isGroup && !rawInput.taggedForOperator) return
  if (findTaskBySourceMessage(rawInput.messageId)) return
  const input = { ...rawInput, text: await transcriptOf(rawInput) }
  if (input.text.length < config.min_chars) return

  const isTrusted = chatInList(config.auto_chats, input.chatJids)
  const detection = await detectTask(config, {
    text: input.text,
    contactLabel: input.contactLabel,
    fromSelf: false,
    workspaceHint: workspaceForChat(config, input.chatJids),
    recentContext: await recentContext(config, input.session, input.chatJid, input.contactLabel, input.messageId),
  })
  appendAudit('task_detected', { message_id: input.messageId, chat_jid: input.chatJid, is_task: detection.is_task, tier: detection.tier })
  if (!detection.is_task) return

  const forcedAsk = new RegExp(config.always_ask_pattern, 'i').test(`${input.text} ${detection.summary}`)
  const tier = isTrusted && detection.tier === 'auto' && !forcedAsk ? 'auto' : 'ask'
  const task = createTask({
    status: tier === 'auto' ? 'approved' : 'pending',
    workspace: detection.workspace,
    tier,
    title: detection.title || 'Task',
    summary: detection.summary || input.text.slice(0, 300),
    plan: detection.plan,
    risk: detection.risk || null,
    source: {
      session: input.session,
      chat_jid: input.chatJid,
      message_id: input.messageId,
      contact_label: input.contactLabel,
      text: input.text,
      from_self: false,
    },
  })

  const text = tier === 'auto'
    ? `⚙️ #${task.id} ${task.title}\nfrom ${task.source.contact_label} (${workspaceLabel(config, task)}), running automatically\n\n${task.summary}\n\nPlan:\n${planLines(task)}\n\nStop it: "no ${task.id}"`
    : alertText(config, task)
  const alertId = await sendToSelf(config, input.session, text)
  updateTask(task.id, { alert_message_id: alertId })
}

async function quotedIdOf(session: string, chatJid: string, messageId: string | null): Promise<string | null> {
  if (!messageId) return null
  try {
    const msgs = await fetchRecentMessages(chatJid, session, 15)
    const hit = msgs.find((m) => bareMessageId(m.id) === bareMessageId(messageId)) as (Record<string, unknown> | undefined)
    const quoted = hit?.quoted_id
    return typeof quoted === 'string' ? quoted : null
  } catch {
    return null
  }
}

function pickTarget(numberArg: string | undefined, quoted: Task | null): Task | null {
  if (numberArg) return getTask(Number(numberArg))
  return quoted ?? latestOpenTask()
}

async function handleDecision(config: TasksConfig, input: TaskSignalInput, kind: DecisionKind, numberArg: string | undefined): Promise<void> {
  const quoted = findTaskByAlert(await quotedIdOf(input.session, input.chatJid, input.messageId))
  const target = pickTarget(numberArg, quoted)
  if (!target) {
    await sendToSelf(config, input.session, 'ℹ️ No open task found.')
    return
  }
  if (kind === 'approve') {
    if (!['pending', 'later', 'failed'].includes(target.status)) {
      await sendToSelf(config, input.session, `ℹ️ #${target.id} is already ${target.status}.`)
      return
    }
    updateTask(target.id, { status: 'approved', error: null })
    await sendToSelf(config, input.session, `👍 #${target.id} approved, starting shortly.`)
    return
  }
  if (kind === 'reject') {
    if (['done', 'rejected'].includes(target.status)) {
      await sendToSelf(config, input.session, `ℹ️ #${target.id} is already ${target.status}.`)
      return
    }
    const wasRunning = target.status === 'running'
    updateTask(target.id, { status: 'rejected' })
    await sendToSelf(config, input.session, wasRunning
      ? `🛑 #${target.id} cancelled. Work that already ran may be partly done.`
      : `🛑 #${target.id} discarded.`)
    return
  }
  updateTask(target.id, { status: 'later' })
  await sendToSelf(config, input.session, `⏸️ #${target.id} parked. Send "yes ${target.id}" to start it.`)
}

async function handleSelf(config: TasksConfig, input: TaskSignalInput): Promise<void> {
  if (input.sentBy && input.sentBy !== 'user') return
  const text = await transcriptOf(input)
  if (!text || OWN_MARKERS.test(text)) return

  const decision = parseDecision(text)
  if (decision) return handleDecision(config, input, decision.kind, decision.id)
  if (text.length < MIN_ORDER_CHARS || findTaskBySourceMessage(input.messageId)) return

  const detection = await detectTask(config, {
    text,
    contactLabel: config.operator_name,
    fromSelf: true,
    workspaceHint: null,
    recentContext: '',
  })
  // The operator's own order runs right away: sending it is the approval.
  const task = createTask({
    status: 'approved',
    workspace: detection.workspace,
    tier: 'auto',
    title: detection.title || 'Order',
    summary: detection.summary || text.slice(0, 300),
    plan: detection.plan,
    risk: detection.risk || null,
    source: {
      session: input.session,
      chat_jid: input.chatJid,
      message_id: input.messageId,
      contact_label: config.operator_name,
      text,
      from_self: true,
    },
  })
  const alertId = await sendToSelf(
    config,
    input.session,
    `⚙️ #${task.id} accepted (${workspaceLabel(config, task)})\n${task.title}\n\nPlan:\n${planLines(task)}\n\nStop it: "no ${task.id}"`,
    input.messageId,
  )
  updateTask(task.id, { alert_message_id: alertId })
}

/** Entry point from the webhook. Never throws; failures land in the audit log. */
export async function handleTaskSignals(input: TaskSignalInput): Promise<void> {
  const config = readTasksConfig()
  if (!config.enabled) return
  try {
    if (isSelfChat(config, input.chatJids)) {
      await handleSelf(config, input)
      return
    }
    await handleInbound(config, input)
  } catch (err) {
    appendAudit('safety_blocked', {
      reason: 'task pipeline failed',
      message_id: input.messageId,
      chat_jid: input.chatJid,
      error: (err as Error).message,
    })
  }
}
