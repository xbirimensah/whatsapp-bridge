// Task queue for the WhatsApp task pipeline: one JSON file per task under
// data/tasks/. Small volume (a few tasks a day), so files beat a schema.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AUTOREPLY_DATA_DIR } from './autoreply-env.js'

// A workspace id from tasks-config.json.
export type TaskWorkspace = string
export type TaskTier = 'auto' | 'ask'
export type TaskStatus = 'pending' | 'later' | 'approved' | 'running' | 'done' | 'failed' | 'rejected'

export interface TaskSource {
  session: string
  chat_jid: string
  message_id: string | null
  contact_label: string
  text: string
  from_self: boolean
}

export interface Task {
  id: number
  created_at: string
  updated_at: string
  status: TaskStatus
  workspace: TaskWorkspace
  tier: TaskTier
  title: string
  summary: string
  plan: string[]
  risk: string | null
  source: TaskSource
  alert_message_id: string | null
  runner: string | null
  started_at: string | null
  result: string | null
  reply_to_sender: string | null
  error: string | null
}

export type NewTask = Omit<Task, 'id' | 'created_at' | 'updated_at' | 'alert_message_id' | 'runner' | 'started_at' | 'result' | 'reply_to_sender' | 'error'>

export const TASKS_DIR = join(AUTOREPLY_DATA_DIR, '..', 'tasks')

function ensureDir(): void {
  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true, mode: 0o700 })
}

function taskPath(id: number): string {
  return join(TASKS_DIR, `${id}.json`)
}

function writeAtomic(task: Task): void {
  const tmp = `${taskPath(task.id)}.tmp`
  writeFileSync(tmp, JSON.stringify(task, null, 2), { mode: 0o600 })
  renameSync(tmp, taskPath(task.id))
}

export function listTasks(): Task[] {
  ensureDir()
  return readdirSync(TASKS_DIR)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')) as Task
      } catch {
        return null
      }
    })
    .filter((t): t is Task => t !== null)
    .sort((a, b) => a.id - b.id)
}

export function getTask(id: number): Task | null {
  if (!existsSync(taskPath(id))) return null
  try {
    return JSON.parse(readFileSync(taskPath(id), 'utf8')) as Task
  } catch {
    return null
  }
}

export function createTask(input: NewTask): Task {
  ensureDir()
  const id = listTasks().reduce((max, t) => Math.max(max, t.id), 0) + 1
  const now = new Date().toISOString()
  const task: Task = {
    ...input,
    id,
    created_at: now,
    updated_at: now,
    alert_message_id: null,
    runner: null,
    started_at: null,
    result: null,
    reply_to_sender: null,
    error: null,
  }
  writeAtomic(task)
  return task
}

export function updateTask(id: number, patch: Partial<Omit<Task, 'id' | 'created_at'>>): Task | null {
  const current = getTask(id)
  if (!current) return null
  const next: Task = { ...current, ...patch, updated_at: new Date().toISOString() }
  writeAtomic(next)
  return next
}

/** Message ids come as `<session>:<waId>` from the DB and sometimes bare from the API. */
export function bareMessageId(id: string | null | undefined): string | null {
  if (!id) return null
  const idx = id.indexOf(':')
  return idx >= 0 ? id.slice(idx + 1) : id
}

export function findTaskBySourceMessage(messageId: string | null): Task | null {
  const bare = bareMessageId(messageId)
  if (!bare) return null
  return listTasks().find((t) => bareMessageId(t.source.message_id) === bare) ?? null
}

export function findTaskByAlert(messageId: string | null): Task | null {
  const bare = bareMessageId(messageId)
  if (!bare) return null
  return listTasks().find((t) => bareMessageId(t.alert_message_id) === bare) ?? null
}

export function latestOpenTask(): Task | null {
  const open = listTasks().filter((t) => t.status === 'pending' || t.status === 'later')
  return open.length ? open[open.length - 1] : null
}
