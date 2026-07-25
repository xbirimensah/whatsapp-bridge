import { existsSync } from 'node:fs'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import { AUTOREPLY_SECOND_BRAIN_ROOT } from './autoreply-env.js'

const execFileAsync = promisify(execFile)
const STYLE_RAG_SCRIPT = join(process.cwd(), 'scripts', 'wa_style_rag.py')
const STYLE_RAG_WORKER_SCRIPT = join(process.cwd(), 'scripts', 'wa_style_rag_server.py')

// The worker pays the torch/model load once at spawn (can take ~60s on a cold
// disk cache); after the ready signal each query is a fast embed + RPC.
const WORKER_READY_TIMEOUT_MS = 90000
const WORKER_REQUEST_TIMEOUT_MS = 15000

export const COMPACT_STYLE_GUIDE = [
  'Write one short, natural WhatsApp reply in the operator\'s voice.',
  'Match the incoming language and keep the tone casual, direct, and human.',
  'The operator texts in quick fragments, not composed sentences: lowercase starts, no trailing period, minor typos are fine.',
  'A reply of 1-6 words is normal and often ideal. Bare "ja", "ok", "yes", "easy" or a single emoji are valid full replies.',
  'Do not thank, acknowledge, or wrap up every message. If nothing needs saying beyond "ja" or "ok", send exactly that.',
  'BANNED pattern: never open with "top," or "nice," or "perfekt," followed by a clause (e.g. "top, danke dir", "nice, gut zu wissen"). No comma-appended acknowledgment openers at all.',
  'Do not over-explain, use filler, or force a reply when the conversation naturally ends.',
  'The verbatim messages from this exact chat are the strongest style signal. Imitate their register, length, and casing over anything in the retrieved style examples.',
  'Style examples demonstrate phrasing only. They are never facts about the current chat.',
].join('\n')

function pythonBin(): string {
  const localStyleRuntime = join(process.cwd(), '.style-rag-venv', 'bin', 'python')
  if (existsSync(localStyleRuntime)) return localStyleRuntime
  if (AUTOREPLY_SECOND_BRAIN_ROOT) {
    const managed = join(AUTOREPLY_SECOND_BRAIN_ROOT, '.venv', 'bin', 'python')
    if (existsSync(managed)) return managed
  }
  return process.env.PYTHON_BIN?.trim() || 'python3'
}

export function inferStyleLanguage(text: string): string {
  const lower = ` ${text.toLowerCase()} `
  const german = [' ich ', ' und ', ' nicht ', ' danke ', ' kann ', ' morgen ', ' bitte ']
    .reduce((count, word) => count + Number(lower.includes(word)), 0)
  const english = [' the ', ' and ', ' thanks ', ' can ', ' tomorrow ', ' please ']
    .reduce((count, word) => count + Number(lower.includes(word)), 0)
  if (german > english) return 'de'
  if (english > german) return 'en'
  return 'unknown'
}

type WorkerRequest = {
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

let worker: ChildProcessWithoutNullStreams | null = null
let workerReady: Promise<void> | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, WorkerRequest>()

function failAllPending(reason: string): void {
  for (const [, request] of pendingRequests) {
    clearTimeout(request.timer)
    request.reject(new Error(reason))
  }
  pendingRequests.clear()
}

function shutdownWorker(): void {
  worker?.kill()
  worker = null
  workerReady = null
}

function ensureWorker(): Promise<void> {
  if (worker && workerReady) return workerReady

  const child = spawn(pythonBin(), [STYLE_RAG_WORKER_SCRIPT], { cwd: process.cwd() })
  worker = child
  workerReady = new Promise<void>((resolve, reject) => {
    const readyTimer = setTimeout(() => {
      reject(new Error('[autoreply/style-rag] worker did not become ready in time'))
      shutdownWorker()
    }, WORKER_READY_TIMEOUT_MS)

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let payload: { ready?: boolean; id?: number; ok?: boolean; result?: string; error?: string }
      try {
        payload = JSON.parse(line)
      } catch {
        return
      }
      if (payload.ready) {
        clearTimeout(readyTimer)
        resolve()
        return
      }
      const request = payload.id === undefined ? undefined : pendingRequests.get(payload.id)
      if (!request || payload.id === undefined) return
      pendingRequests.delete(payload.id)
      clearTimeout(request.timer)
      if (payload.ok && typeof payload.result === 'string') request.resolve(payload.result)
      else request.reject(new Error(payload.error ?? '[autoreply/style-rag] worker query failed'))
    })

    child.on('error', (error) => {
      clearTimeout(readyTimer)
      reject(error)
      failAllPending(`[autoreply/style-rag] worker error: ${error.message}`)
      shutdownWorker()
    })
    child.on('exit', (code) => {
      clearTimeout(readyTimer)
      reject(new Error(`[autoreply/style-rag] worker exited (code ${code})`))
      failAllPending(`[autoreply/style-rag] worker exited (code ${code})`)
      worker = null
      workerReady = null
    })
  })
  // Callers race the ready promise; without a handler an early exit before the
  // first query would surface as an unhandled rejection.
  workerReady.catch(() => {})
  return workerReady
}

process.on('exit', () => {
  worker?.kill()
})

async function queryViaWorker(params: { incomingText: string; isGroup: boolean }): Promise<string> {
  await ensureWorker()
  const child = worker
  if (!child) throw new Error('[autoreply/style-rag] worker unavailable')

  const id = nextRequestId++
  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error('[autoreply/style-rag] worker query timed out'))
    }, WORKER_REQUEST_TIMEOUT_MS)
    pendingRequests.set(id, { resolve, reject, timer })
  })
  child.stdin.write(`${JSON.stringify({
    id,
    query: params.incomingText,
    language: inferStyleLanguage(params.incomingText),
    chat_kind: params.isGroup ? 'group' : 'direct',
    limit: 4,
  })}\n`)
  return result
}

async function queryViaOneShotScript(params: { incomingText: string; isGroup: boolean }): Promise<string> {
  const { stdout } = await execFileAsync(
    pythonBin(),
    [
      STYLE_RAG_SCRIPT,
      'query',
      '--query', params.incomingText,
      '--language', inferStyleLanguage(params.incomingText),
      '--chat-kind', params.isGroup ? 'group' : 'direct',
      '--limit', '4',
    ],
    { cwd: process.cwd(), timeout: 60000, maxBuffer: 128 * 1024 },
  )
  return stdout.trim()
}

export async function fetchStyleExamples(params: {
  incomingText: string
  isGroup: boolean
}): Promise<string> {
  if (!AUTOREPLY_SECOND_BRAIN_ROOT || !existsSync(STYLE_RAG_SCRIPT)) return ''
  if (existsSync(STYLE_RAG_WORKER_SCRIPT)) {
    try {
      return (await queryViaWorker(params)).trim()
    } catch {
      // Fall through to the slower spawn-per-query path below.
    }
  }
  return queryViaOneShotScript(params)
}
