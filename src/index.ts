import './env.js'
import pino from 'pino'

import { wa, scanRegisteredSessions } from './wa.js'
import { startApi } from './api.js'
import { HOST, TIMEZONE } from './env.js'
import { startUpdateWatcher } from './updates.js'
import { bridgeControl } from './bridge-control.js'

const log = pino({ level: 'info' }).child({ mod: 'main' })

// Refuse to bind to a non-loopback address unless the operator has acknowledged
// the implications (single bearer token vs. the public internet, no rate limit).
// Set WA_ALLOW_PUBLIC=1 in .env after putting this behind a reverse proxy with TLS.
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && process.env.WA_ALLOW_PUBLIC !== '1') {
  log.error(
    { host: HOST },
    'refusing to bind a non-loopback HOST without WA_ALLOW_PUBLIC=1 — put a TLS-terminating reverse proxy in front and set the flag',
  )
  process.exit(1)
}

const arg1 = process.argv[2]
const arg2 = process.argv[3]

const newSession =
  arg1 && arg2 ? { name: arg1, number: arg2.replace(/[^0-9]/g, '') } : null

const alreadyPaired = scanRegisteredSessions()

if (alreadyPaired.length > 1) {
  log.error(
    { found: alreadyPaired },
    'multi-session is disabled — only one paired session is allowed at a time. Remove the extras from ./auth/ and restart.',
  )
  process.exit(1)
}

if (newSession && alreadyPaired.length > 0 && !alreadyPaired.includes(newSession.name)) {
  log.error(
    { paired: alreadyPaired, pairing: newSession.name },
    'a session is already paired — unpair first (delete ./auth/<name>/) before adding another.',
  )
  process.exit(1)
}

const sessionsToRestore = alreadyPaired.filter((s) => s !== newSession?.name)

if (sessionsToRestore.length === 0 && !newSession) {
  log.warn('no paired sessions found in ./auth — API remains online; pair with: npm run pair -- <name> <number>')
}

log.info(
  {
    restoring: sessionsToRestore,
    pairing: newSession ? `${newSession.name} (${newSession.number})` : null,
    timezone: TIMEZONE,
  },
  'boot',
)

if (newSession) {
  console.log(
    `\n[setup] pairing "${newSession.name}" (${newSession.number})`,
  )
  console.log(
    `[setup] timezone: ${TIMEZONE} — timestamps in CLI/logs use this zone. Change by editing WA_TZ in .env (use IANA names like Europe/Berlin, America/New_York; DST is handled).\n`,
  )
}

async function applyBridgeControl(enabled: boolean): Promise<void> {
  await wa.setTransportEnabled(enabled)
  if (!enabled) {
    log.info('WhatsApp transport disabled by operator')
    return
  }
  for (const name of sessionsToRestore) {
    try {
      await wa.start(name)
    } catch (err) {
      log.error({ session: name, err }, 'failed to restore session')
    }
  }
  if (newSession) await wa.start(newSession.name, newSession.number)
}

await applyBridgeControl(bridgeControl.get().enabled)

startUpdateWatcher()

await startApi({ onBridgeControlChange: applyBridgeControl })
