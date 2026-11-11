import { existsSync } from 'node:fs'

import { db, setMessageTranscript } from './db.js'
import { transcribeAudio } from './transcribe.js'
import { TRANSCRIBE_ENABLED } from './env.js'

interface Row {
  id: string
  media_path: string
  media_mime: string | null
  session: string
}

function parseArgs(): { limit: number; session: string | null } {
  let limit = 50
  let session: string | null = null
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length))
    else if (a.startsWith('--session=')) session = a.slice('--session='.length)
  }
  return { limit, session }
}

async function main() {
  if (!TRANSCRIBE_ENABLED) {
    console.error('[backlog] no transcription backend (set TRANSCRIBE_LOCAL_PYTHON or OPENAI_API_KEY)')
    process.exit(1)
  }
  const { limit, session } = parseArgs()
  const where = session
    ? `WHERE type='audio' AND media_path IS NOT NULL AND transcript IS NULL AND session=?`
    : `WHERE type='audio' AND media_path IS NOT NULL AND transcript IS NULL`
  const params = session ? [session, limit] : [limit]
  const rows = db
    .prepare(`SELECT id, media_path, media_mime, session FROM messages ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params) as Row[]
  console.log(`[backlog] ${rows.length} audio(s) to transcribe${session ? ` (session=${session})` : ''}`)

  let ok = 0
  let skipped = 0
  let errs = 0
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!existsSync(r.media_path)) {
      skipped++
      continue
    }
    try {
      const text = await transcribeAudio(r.media_path, { mime: r.media_mime })
      if (text) {
        setMessageTranscript(r.id, text)
        ok++
        console.log(`[backlog] [${i + 1}/${rows.length}] ${r.id} → ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`)
      } else {
        skipped++
      }
    } catch (err) {
      errs++
      console.warn(`[backlog] [${i + 1}/${rows.length}] ${r.id} → ${(err as Error).message}`)
    }
  }
  console.log(`[backlog] done — transcribed=${ok} skipped=${skipped} errors=${errs}`)
}

main().catch((err) => {
  console.error('[backlog] fatal', err)
  process.exit(1)
})
