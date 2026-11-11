import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  AUTOREPLY_PERSONAL_CONTEXT_LIMIT,
  AUTOREPLY_PERSONAL_CONTEXT_MAX_CHARS,
  AUTOREPLY_SECOND_BRAIN_ROOT,
} from './autoreply-env.js'
import { forwardScriptStderr, stderrOf } from './autoreply-script-stderr.js'

const execFileAsync = promisify(execFile)
const PERSONAL_CONTEXT_SCRIPT = join(process.cwd(), 'scripts', 'wa_personal_context.py')

function pythonBin(): string {
  const localRagRuntime = join(process.cwd(), '.style-rag-venv', 'bin', 'python')
  if (existsSync(localRagRuntime)) return localRagRuntime
  if (AUTOREPLY_SECOND_BRAIN_ROOT) {
    const managed = join(AUTOREPLY_SECOND_BRAIN_ROOT, '.venv', 'bin', 'python')
    if (existsSync(managed)) return managed
  }
  return process.env.PYTHON_BIN?.trim() || 'python3'
}

export async function fetchPersonalContext(query: string): Promise<string> {
  if (!AUTOREPLY_SECOND_BRAIN_ROOT || !existsSync(PERSONAL_CONTEXT_SCRIPT)) return ''
  if (!Number.isFinite(AUTOREPLY_PERSONAL_CONTEXT_LIMIT) || AUTOREPLY_PERSONAL_CONTEXT_LIMIT <= 0) return ''
  if (!Number.isFinite(AUTOREPLY_PERSONAL_CONTEXT_MAX_CHARS) || AUTOREPLY_PERSONAL_CONTEXT_MAX_CHARS <= 0) return ''

  try {
    const { stdout, stderr } = await execFileAsync(
      pythonBin(),
      [
        PERSONAL_CONTEXT_SCRIPT,
        '--query', query.slice(0, 1200),
        '--limit', String(Math.min(Math.floor(AUTOREPLY_PERSONAL_CONTEXT_LIMIT), 6)),
        '--max-chars', String(Math.min(Math.floor(AUTOREPLY_PERSONAL_CONTEXT_MAX_CHARS), 4000)),
      ],
      { cwd: process.cwd(), timeout: 60000, maxBuffer: 64 * 1024 },
    )
    forwardScriptStderr('[autoreply/personal-context]', stderr)
    return stdout.trim()
  } catch (error) {
    forwardScriptStderr('[autoreply/personal-context]', stderrOf(error))
    throw error
  }
}
