import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type BridgeControlState = { enabled: boolean }

/**
 * Durable operator intent for the WhatsApp transport.
 *
 * Absence deliberately means enabled: the bridge comes online by default after
 * a reboot or upgrade. Only an explicit operator action writes `enabled:false`.
 */
export class BridgeControlStore {
  constructor(private readonly path: string) {}

  get(): BridgeControlState {
    if (!existsSync(this.path)) return { enabled: true }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      throw new Error('invalid bridge control state')
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { enabled?: unknown }).enabled !== 'boolean') {
      throw new Error('invalid bridge control state')
    }
    return { enabled: (parsed as { enabled: boolean }).enabled }
  }

  set(enabled: boolean): BridgeControlState {
    const next = { enabled }
    const temp = `${this.path}.tmp`
    writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(temp, this.path)
    try { chmodSync(this.path, 0o600) } catch {}
    return next
  }
}

export const bridgeControl = new BridgeControlStore('./data/bridge-control.json')
