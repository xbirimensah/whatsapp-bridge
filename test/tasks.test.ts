import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'wa-tasks-test-'))
process.env.AUTOREPLY_DATA_DIR = join(dataDir, 'autoreply')

const {
  chatInList, expandHome, isSelfChat, parseTasksConfig, readTasksConfig, resolveWorkspace, workspaceForChat,
} = await import('../src/tasks-config.js')
const { buildDetectPrompt, parseDetection } = await import('../src/tasks-detect.js')
const { buildRemoteCommand, buildRunPrompt, splitReply } = await import('../src/tasks-runner.js')
const { alertText, parseDecision } = await import('../src/tasks-handler.js')
const { createTask, findTaskByAlert, findTaskBySourceMessage, latestOpenTask, updateTask } = await import('../src/tasks-store.js')

test.after(() => rmSync(dataDir, { recursive: true, force: true }))

const twoWorkspaces = parseTasksConfig({
  enabled: true,
  operator_name: 'Ada',
  operator_context: 'Runs a small agency.',
  language: 'German',
  self_jids: ['12025550100@s.whatsapp.net'],
  workspaces: [
    { id: 'home', label: 'Home', description: 'Private errands.' },
    { id: 'work', label: 'Work', description: 'Client projects.', chats: ['12025550101@s.whatsapp.net'], remote_cwd: '$HOME/work' },
  ],
  extra_rules: ['Always include the ticket link.'],
})

function sampleTask(workspace = 'work') {
  return createTask({
    status: 'pending',
    workspace,
    tier: 'ask',
    title: 'Send the report',
    summary: 'Export the monthly report and share it.',
    plan: ['Export', 'Share'],
    risk: null,
    source: {
      session: 'main', chat_jid: '12025550101@s.whatsapp.net', message_id: 'main:MSG1',
      contact_label: 'Grace', text: 'can you send me the report?', from_self: false,
    },
  })
}

test('the pipeline is off and has one default workspace when no config file exists', () => {
  const config = readTasksConfig(join(dataDir, 'missing.json'))

  assert.equal(config.enabled, false)
  assert.deepEqual(config.workspaces.map((ws) => ws.id), ['default'])
  assert.equal(config.operator_name, 'the operator')
})

test('an invalid config file disables the pipeline instead of throwing', () => {
  const path = join(dataDir, 'broken.json')
  writeFileSync(path, JSON.stringify({ enabled: true, always_ask_pattern: '(' }))

  assert.equal(readTasksConfig(path).enabled, false)
})

test('config validation rejects duplicate workspace ids and incomplete handoff workspaces', () => {
  assert.throws(() => parseTasksConfig({ workspaces: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }), /unique/)
  assert.throws(() => parseTasksConfig({ workspaces: [{ id: 'a', label: 'A', runner: 'handoff' }] }), /handoff/)
  assert.throws(() => parseTasksConfig({ workspaces: [] }))
})

test('chat lists match across device suffixes and letter case', () => {
  assert.equal(chatInList(['12025550100@s.whatsapp.net'], ['12025550100:7@S.WhatsApp.net']), true)
  assert.equal(chatInList(['12025550100@s.whatsapp.net'], ['12025550199@s.whatsapp.net']), false)
  assert.equal(isSelfChat(twoWorkspaces, ['12025550100@s.whatsapp.net']), true)
  assert.equal(isSelfChat(parseTasksConfig({}), ['12025550100@s.whatsapp.net']), false)
})

test('a chat pinned to a workspace resolves to it, unknown ids fall back to the first workspace', () => {
  assert.equal(workspaceForChat(twoWorkspaces, ['12025550101@s.whatsapp.net']), 'work')
  assert.equal(workspaceForChat(twoWorkspaces, ['12025550999@s.whatsapp.net']), null)
  assert.equal(resolveWorkspace(twoWorkspaces, 'nope').id, 'home')
  assert.equal(resolveWorkspace(twoWorkspaces, null).id, 'home')
})

test('expandHome only rewrites a leading tilde', () => {
  assert.equal(expandHome('/srv/app'), '/srv/app')
  assert.notEqual(expandHome('~/app'), '~/app')
  assert.ok(expandHome('~/app').endsWith('/app'))
})

test('the detection prompt carries the operator, the workspaces and the output language', () => {
  const prompt = buildDetectPrompt(twoWorkspaces, {
    text: 'please send the report', contactLabel: 'Grace', fromSelf: false, workspaceHint: null, recentContext: '',
  })

  assert.match(prompt, /assistant of Ada/)
  assert.match(prompt, /Runs a small agency\./)
  assert.match(prompt, /- "work": Work\. Client projects\./)
  assert.match(prompt, /Sender: Grace/)
  assert.match(prompt, /in German/)
  assert.match(prompt, /"workspace": "home"\|"work"/)
})

test('the detection prompt pins the workspace for a pinned chat and treats own messages as orders', () => {
  const prompt = buildDetectPrompt(twoWorkspaces, {
    text: 'book the room', contactLabel: 'Ada', fromSelf: true, workspaceHint: 'work', recentContext: '',
  })

  assert.match(prompt, /always belongs to "work"/)
  assert.match(prompt, /is_task is almost always true/)
})

test('detector output is parsed from surrounding text, capped, and mapped to a real workspace', () => {
  const raw = 'Sure: {"is_task": true, "title": "T", "summary": "S", "workspace": "elsewhere", "tier": "auto", "plan": ["1","2","3","4","5"], "risk": "r"} done'

  const detection = parseDetection(twoWorkspaces, raw, null)

  assert.equal(detection.is_task, true)
  assert.equal(detection.workspace, 'home')
  assert.equal(detection.plan.length, 4)
  assert.equal(parseDetection(twoWorkspaces, raw, 'work').workspace, 'work')
  assert.throws(() => parseDetection(twoWorkspaces, 'no json here', null), /no JSON object/)
})

test('the run prompt includes the task, the workspace, the house rules and the reply marker', () => {
  const prompt = buildRunPrompt(twoWorkspaces, sampleTask())

  assert.match(prompt, /assistant of Ada/)
  assert.match(prompt, /Workspace: Work\. Client projects\./)
  assert.match(prompt, /Send the report/)
  assert.match(prompt, /1\. Export\n2\. Share/)
  assert.match(prompt, /Original message from Grace \(WhatsApp\)/)
  assert.match(prompt, /- Always include the ticket link\./)
  assert.match(prompt, /REPLY_TO_SENDER:/)
  assert.match(prompt, /summary in German/)
})

test('agent output is split into the result and an optional reply to the sender', () => {
  assert.deepEqual(splitReply('Done.\nLink: x\nREPLY_TO_SENDER: sent it over\n'), { result: 'Done.\nLink: x', reply: 'sent it over' })
  assert.deepEqual(splitReply('Done.'), { result: 'Done.', reply: null })
  assert.deepEqual(splitReply('Done.\nREPLY_TO_SENDER:   '), { result: 'Done.', reply: null })
})

test('the remote command changes into the workspace directory after the prelude', () => {
  const withPrelude = parseTasksConfig({ ...twoWorkspaces, remote_prelude: 'export PATH=$HOME/bin:$PATH' })

  assert.equal(buildRemoteCommand(withPrelude, resolveWorkspace(withPrelude, 'work')), 'export PATH=$HOME/bin:$PATH; cd "$HOME/work" && claude -p --output-format text')
  assert.equal(buildRemoteCommand(twoWorkspaces, resolveWorkspace(twoWorkspaces, 'home')), 'cd "$HOME" && claude -p --output-format text')
})

test('short self-chat replies are read as decisions in English and German', () => {
  assert.deepEqual(parseDecision('yes'), { kind: 'approve', id: undefined })
  assert.deepEqual(parseDecision('ja 12'), { kind: 'approve', id: '12' })
  assert.deepEqual(parseDecision('no #3'), { kind: 'reject', id: '3' })
  assert.deepEqual(parseDecision('later 4'), { kind: 'later', id: '4' })
  assert.equal(parseDecision('yesterday I met them'), null)
  assert.equal(parseDecision('yes, and please also book a table for six people tonight'), null)
  assert.equal(parseDecision('book a table'), null)
})

test('the approval alert names the sender, the workspace and how to answer', () => {
  const task = sampleTask()

  const text = alertText(twoWorkspaces, task)

  assert.match(text, new RegExp(`^📋 #${task.id} Send the report\\nfrom Grace \\(Work\\)`))
  assert.match(text, /1\) Export\n2\) Share/)
  assert.match(text, new RegExp(`"yes ${task.id}"`))
})

test('tasks are found by their source message and alert, with or without the session prefix', () => {
  const task = sampleTask('home')
  updateTask(task.id, { alert_message_id: 'main:ALERT9', source: { ...task.source, message_id: 'main:SRC9' } })

  assert.equal(findTaskBySourceMessage('SRC9')?.id, task.id)
  assert.equal(findTaskByAlert('other:ALERT9')?.id, task.id)
  assert.equal(findTaskByAlert(null), null)
  assert.equal(latestOpenTask()?.id, task.id)
})
