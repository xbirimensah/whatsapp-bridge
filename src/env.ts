import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Resolve .env relative to this module (repo root), not the caller's cwd — so a
// process spawned from elsewhere (e.g. the MCP server under Claude Code) still
// reads the live token from .env instead of needing it injected via env vars.
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env')

// .env holds the bearer token + provider keys — keep it unreadable to other local users.
function lockDownEnvFile(): void {
  if (!existsSync(ENV_PATH)) return
  try {
    chmodSync(ENV_PATH, 0o600)
  } catch {}
}

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return
  const content = readFileSync(ENV_PATH, 'utf8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv()
lockDownEnvFile()

function ensureToken(): string {
  if (process.env.API_TOKEN && process.env.API_TOKEN.length >= 32) {
    return process.env.API_TOKEN
  }

  const token = randomBytes(32).toString('hex')
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  if (content && !content.endsWith('\n')) content += '\n'
  content += `API_TOKEN=${token}\n`
  writeFileSync(ENV_PATH, content)
  lockDownEnvFile()
  process.env.API_TOKEN = token
  console.log(`[env] generated new API_TOKEN, saved to ${ENV_PATH}`)
  return token
}

export const API_TOKEN = ensureToken()
export const PORT = Number(process.env.PORT ?? 8080)
export const HOST = process.env.HOST ?? '127.0.0.1'
export const WEBHOOK_URL = process.env.WEBHOOK_URL?.trim() || null
export const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN?.trim() || null
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || null
// Local transcription (mlx-whisper). When set, voice notes are transcribed on
// this machine first; OpenAI is only the fallback.
export const TRANSCRIBE_LOCAL_PYTHON = process.env.TRANSCRIBE_LOCAL_PYTHON?.trim() || null
export const TRANSCRIBE_LOCAL_MODEL = process.env.TRANSCRIBE_LOCAL_MODEL?.trim() || null
// The operator's own "message yourself" chat (comma-separated JIDs). Messages the
// operator types there are forwarded to the webhook too, so agents can take orders.
export const WA_SELF_CHAT_JIDS = new Set(
  (process.env.WA_SELF_CHAT_JIDS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean),
)
export const TRANSCRIBE_ENABLED = Boolean(TRANSCRIBE_LOCAL_PYTHON || OPENAI_API_KEY)
export const FORCE_HISTORY_SYNC_ON_RESTORE = /^(1|true|yes|on)$/i.test(
  process.env.WA_FORCE_HISTORY_SYNC_ON_RESTORE ?? '',
)

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function ensureTimezone(): string {
  const raw = process.env.WA_TZ?.trim()
  if (raw && isValidIanaTimezone(raw)) return raw

  if (raw && !isValidIanaTimezone(raw)) {
    console.warn(`[env] WA_TZ=${raw} is not a valid IANA timezone — falling back to system timezone`)
  }

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  if (content && !content.endsWith('\n')) content += '\n'
  content += `WA_TZ=${systemTz}\n`
  writeFileSync(ENV_PATH, content)
  lockDownEnvFile()
  process.env.WA_TZ = systemTz
  console.log(`[env] timezone set to ${systemTz} (saved to ${ENV_PATH}; edit WA_TZ to override — use IANA names like Europe/Berlin so DST is handled automatically)`)
  return systemTz
}

export const TIMEZONE = ensureTimezone()
