import { existsSync } from 'node:fs'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

import { AUTOREPLY_SECOND_BRAIN_ROOT } from './autoreply-env.js'
import { detectTextLanguage, type ChatLanguage } from './autoreply-language.js'
import { forwardScriptStderr, stderrOf } from './autoreply-script-stderr.js'

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
  'Never emit filler words or fragments from a different language than this chat. Do not copy raw filler phrases.',
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

export function inferStyleLanguage(text: string): ChatLanguage {
  return detectTextLanguage(text)
}

export function shouldRetrieveStyleExamples(language: ChatLanguage): boolean {
  return language !== 'unknown'
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

    // Consume stderr so a chatty worker can never block on a full pipe, and so
    // its [wa-brain] retrieval failure lines reach the sidecar log.
    createInterface({ input: child.stderr }).on('line', (line) => {
      forwardScriptStderr('[autoreply/style-rag worker]', line)
    })

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

async function queryViaWorker(params: { incomingText: string; isGroup: boolean; chatLanguage: ChatLanguage }): Promise<string> {
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
    language: params.chatLanguage,
    chat_kind: params.isGroup ? 'group' : 'direct',
    limit: 4,
  })}\n`)
  return result
}

async function queryViaOneShotScript(params: { incomingText: string; isGroup: boolean; chatLanguage: ChatLanguage }): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      pythonBin(),
      [
        STYLE_RAG_SCRIPT,
        'query',
        '--query', params.incomingText,
        '--language', params.chatLanguage,
        '--chat-kind', params.isGroup ? 'group' : 'direct',
        '--limit', '4',
      ],
      { cwd: process.cwd(), timeout: 60000, maxBuffer: 128 * 1024 },
    )
    forwardScriptStderr('[autoreply/style-rag]', stderr)
    return stdout.trim()
  } catch (error) {
    forwardScriptStderr('[autoreply/style-rag]', stderrOf(error))
    throw error
  }
}

export async function fetchStyleExamples(params: {
  incomingText: string
  isGroup: boolean
  chatLanguage?: ChatLanguage
}): Promise<string> {
  const chatLanguage = params.chatLanguage ?? detectTextLanguage(params.incomingText)
  if (!shouldRetrieveStyleExamples(chatLanguage)) return ''
  if (!AUTOREPLY_SECOND_BRAIN_ROOT || !existsSync(STYLE_RAG_SCRIPT)) return ''
  const queryParams = { ...params, chatLanguage }
  if (existsSync(STYLE_RAG_WORKER_SCRIPT)) {
    try {
      return (await queryViaWorker(queryParams)).trim()
    } catch (error) {
      // Fall through to the slower spawn-per-query path below, but say so.
      console.warn(`[autoreply/style-rag] worker query failed, using one-shot script: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return queryViaOneShotScript(queryParams)
}
