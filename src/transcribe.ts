import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { OPENAI_API_KEY, TRANSCRIBE_LOCAL_MODEL, TRANSCRIBE_LOCAL_PYTHON } from './env.js'

const execFileAsync = promisify(execFile)
const LOCAL_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'transcribe_local.py')
const LOCAL_TIMEOUT_MS = 5 * 60 * 1000
// launchd starts us without Homebrew on PATH; mlx-whisper shells out to ffmpeg.
const LOCAL_PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':')

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const MODEL = 'whisper-1'
const MAX_BYTES = 25 * 1024 * 1024 // OpenAI rejects > 25 MB anyway

export class TranscribeError extends Error {}

async function transcribeLocal(filePath: string): Promise<string> {
  if (!TRANSCRIBE_LOCAL_PYTHON) throw new TranscribeError('TRANSCRIBE_LOCAL_PYTHON not set')
  const args = [LOCAL_SCRIPT, filePath, TRANSCRIBE_LOCAL_MODEL ?? '']
  try {
    const { stdout } = await execFileAsync(TRANSCRIBE_LOCAL_PYTHON, args, {
      timeout: LOCAL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: LOCAL_PATH },
    })
    return stdout.trim()
  } catch (err) {
    const e = err as Error & { stderr?: string }
    throw new TranscribeError(`local: ${(e.stderr || e.message).slice(-300)}`)
  }
}

/** Local mlx-whisper first (free, audio stays on the machine), OpenAI as fallback. */
export async function transcribeAudio(
  filePath: string,
  opts: { mime?: string | null; language?: string } = {},
): Promise<string> {
  if (TRANSCRIBE_LOCAL_PYTHON) {
    try {
      return await transcribeLocal(filePath)
    } catch (err) {
      if (!OPENAI_API_KEY) throw err
    }
  }
  return transcribeOpenAI(filePath, opts)
}

async function transcribeOpenAI(
  filePath: string,
  opts: { mime?: string | null; language?: string } = {},
): Promise<string> {
  if (!OPENAI_API_KEY) throw new TranscribeError('OPENAI_API_KEY not set')

  const info = await stat(filePath)
  if (info.size > MAX_BYTES) throw new TranscribeError(`audio too large (${info.size} bytes)`)

  const buf = await readFile(filePath)
  // WhatsApp PTT is OPUS in OGG; standard audio can be m4a/aac.
  const mime = opts.mime ?? 'audio/ogg'
  // Use a generic filename — the original carries `<session>:<msg_id>` which we
  // don't want to send to a third party.
  const ext = extname(filePath).slice(1) || 'ogg'
  const filename = `audio.${ext}`

  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), filename)
  form.append('model', MODEL)
  if (opts.language) form.append('language', opts.language)
  form.append('response_format', 'json')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new TranscribeError(`OpenAI ${res.status}: ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as { text?: string }
  const text = (json.text ?? '').trim()
  return text
}
