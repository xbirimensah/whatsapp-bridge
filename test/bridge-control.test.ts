import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BridgeControlStore } from '../src/bridge-control.js'

test('defaults to enabled when no operator state has been written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-control-'))
  const file = join(dir, 'control.json')
  const store = new BridgeControlStore(file)

  assert.equal(store.get().enabled, true)
  assert.equal(existsSync(file), false)
})

test('persists an explicit operator off state and restores it in a new process view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-control-'))
  const file = join(dir, 'control.json')
  const store = new BridgeControlStore(file)

  assert.deepEqual(store.set(false), { enabled: false })
  assert.equal(readFileSync(file, 'utf8'), '{"enabled":false}\n')
  assert.deepEqual(new BridgeControlStore(file).get(), { enabled: false })
})

test('returns to the online-by-default state when the operator turns it back on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-control-'))
  const file = join(dir, 'control.json')
  const store = new BridgeControlStore(file)

  store.set(false)
  assert.deepEqual(store.set(true), { enabled: true })
  assert.deepEqual(new BridgeControlStore(file).get(), { enabled: true })
})

test('fails closed for malformed persisted operator state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-control-'))
  const file = join(dir, 'control.json')
  writeFileSync(file, '{"enabled":"yes"}\n')

  assert.throws(() => new BridgeControlStore(file).get(), /invalid bridge control state/i)
})
