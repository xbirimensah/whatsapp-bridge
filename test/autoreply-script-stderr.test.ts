import assert from 'node:assert/strict'
import test from 'node:test'

import { forwardScriptStderr, stderrOf } from '../src/autoreply-script-stderr.js'

test('forwards every non-empty stderr line with the caller label', () => {
  const logged: string[] = []
  const count = forwardScriptStderr(
    '[autoreply/style-rag]',
    '[wa-brain] RETRIEVAL_ERROR backend=brain-api kind=style error=ConnectionError\n\n  \n[wa-brain] RETRIEVAL_EMPTY backend=brain-api kind=style rows=0\n',
    (line) => logged.push(line),
  )
  assert.equal(count, 2)
  assert.deepEqual(logged, [
    '[autoreply/style-rag] [wa-brain] RETRIEVAL_ERROR backend=brain-api kind=style error=ConnectionError',
    '[autoreply/style-rag] [wa-brain] RETRIEVAL_EMPTY backend=brain-api kind=style rows=0',
  ])
})

test('stays quiet when the script wrote nothing to stderr', () => {
  const logged: string[] = []
  assert.equal(forwardScriptStderr('[x]', '', (line) => logged.push(line)), 0)
  assert.equal(forwardScriptStderr('[x]', undefined, (line) => logged.push(line)), 0)
  assert.equal(forwardScriptStderr('[x]', Buffer.from('\n'), (line) => logged.push(line)), 0)
  assert.deepEqual(logged, [])
})

test('reads stderr from a failed execFile error and ignores other values', () => {
  assert.equal(stderrOf(Object.assign(new Error('exit 1'), { stderr: 'boom\n' })), 'boom\n')
  assert.equal(stderrOf(Object.assign(new Error('exit 1'), { stderr: Buffer.from('buf') })), 'buf')
  assert.equal(stderrOf(new Error('no stderr')), '')
  assert.equal(stderrOf('plain string'), '')
  assert.equal(stderrOf(null), '')
})
