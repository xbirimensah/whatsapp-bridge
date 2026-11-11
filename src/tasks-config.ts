// Settings for the WhatsApp task pipeline, in data/autoreply/tasks-config.json
// (read fresh on every use, so edits apply without a restart). The pipeline is
// off until that file exists and sets "enabled": true. See docs/tasks.md.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'

const DEFAULT_ALWAYS_ASK = 'delete|remove|cancel|refund|pay|payment|transfer|password|credential|contract'
  + '|lösch|entfern|kündig|storn|überweis|bezahl|zahlung|erstatt|passwort|zugang|vertrag'

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

const workspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, "-" and "_" only'),
  label: z.string().min(1).max(40),
  // One or two sentences: what kind of work belongs here. Shown to the
  // detector (to pick a workspace) and to the agent that runs the task.
  description: z.string().default(''),
  // Where the agent runs on this machine. A leading "~" is the home directory.
  cwd: z.string().default('~'),
  // Where the agent runs on remote_host. Defaults to the remote home directory.
  remote_cwd: z.string().nullable().default(null),
  // Chats whose tasks always belong to this workspace, whatever the text says.
  chats: z.array(z.string()).default([]),
  // "agent" runs the agent command here. "handoff" only writes a job file for
  // another account or machine to pick up, so this process never needs the
  // credentials that workspace uses.
  runner: z.enum(['agent', 'handoff']).default('agent'),
  handoff_inbox_dir: z.string().nullable().default(null),
  handoff_outbox_dir: z.string().nullable().default(null),
}).refine(
  (ws) => ws.runner !== 'handoff' || Boolean(ws.handoff_inbox_dir && ws.handoff_outbox_dir),
  { message: 'a handoff workspace needs handoff_inbox_dir and handoff_outbox_dir' },
)

const DEFAULT_WORKSPACE = { id: 'default', label: 'Default' }

const configSchema = z.object({
  enabled: z.boolean().default(false),
  // How the prompts refer to you, plus optional background (role, team
  // members who count as internal, tools you use).
  operator_name: z.string().min(1).default('the operator'),
  operator_context: z.string().default(''),
  // Language for task titles, plans and result summaries.
  language: z.string().min(1).default('English'),
  // The operator's own "message yourself" chat, every JID form it shows up under.
  self_jids: z.array(z.string()).default([]),
  // Chats whose easy tasks may run without asking, and which get the agent's reply.
  // Everyone else is untrusted: their tasks always wait for the operator's "yes".
  auto_chats: z.array(z.string()).default([]),
  // Words that always force an approval, even in auto chats.
  always_ask_pattern: z.string().refine(isValidRegex, 'not a valid regular expression').default(DEFAULT_ALWAYS_ASK),
  // The first workspace is the fallback when the detector names none.
  workspaces: z.array(workspaceSchema).min(1).default([DEFAULT_WORKSPACE]),
  // The agent gets the task prompt on stdin and prints its answer to stdout.
  agent_command: z.string().min(1).default('claude'),
  agent_args: z.array(z.string()).default(['-p', '--output-format', 'text']),
  // Optional second machine, preferred while it answers over ssh.
  remote_host: z.string().nullable().default(null),
  remote_agent_command: z.string().min(1).default('claude -p --output-format text'),
  // Shell snippet run on remote_host before the agent, e.g. to extend PATH.
  remote_prelude: z.string().default(''),
  // Extra house rules appended to every task prompt.
  extra_rules: z.array(z.string()).default([]),
  max_parallel: z.number().int().min(1).max(4).default(2),
  min_chars: z.number().int().min(0).default(12),
  run_timeout_min: z.number().int().min(1).max(120).default(30),
}).refine(
  (config) => new Set(config.workspaces.map((ws) => ws.id)).size === config.workspaces.length,
  { message: 'workspace ids must be unique' },
)

export type TasksConfig = z.infer<typeof configSchema>
export type TasksWorkspace = TasksConfig['workspaces'][number]

const CONFIG_PATH = join(AUTOREPLY_DATA_DIR, 'tasks-config.json')

/** Validates a raw config object. Throws a ZodError when it is invalid. */
export function parseTasksConfig(raw: unknown): TasksConfig {
  return configSchema.parse(raw)
}

export function readTasksConfig(path: string = CONFIG_PATH): TasksConfig {
  if (!existsSync(path)) return parseTasksConfig({})
  try {
    return parseTasksConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    console.error('[tasks] invalid tasks-config.json, tasks disabled:', (err as Error).message)
    return { ...parseTasksConfig({}), enabled: false }
  }
}

function bareJid(jid: string): string {
  const [local, domain] = jid.toLowerCase().split('@')
  return `${local.split(':')[0]}@${domain ?? ''}`
}

/** True when any alias of the chat appears in the list. */
export function chatInList(list: string[], chatJids: string[]): boolean {
  const wanted = new Set(list.map(bareJid))
  return chatJids.some((j) => wanted.has(bareJid(j)))
}

export function isSelfChat(config: TasksConfig, chatJids: string[]): boolean {
  return config.self_jids.length > 0 && chatInList(config.self_jids, chatJids)
}

/** The workspace a chat is pinned to, or null when the detector may choose. */
export function workspaceForChat(config: TasksConfig, chatJids: string[]): string | null {
  return config.workspaces.find((ws) => chatInList(ws.chats, chatJids))?.id ?? null
}

/** Looks a workspace up by id and falls back to the first one. */
export function resolveWorkspace(config: TasksConfig, id: string | null | undefined): TasksWorkspace {
  return config.workspaces.find((ws) => ws.id === id) ?? config.workspaces[0]
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
