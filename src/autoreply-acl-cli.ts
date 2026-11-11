// Terminal control for the autoreply allow/block lists.
//
//   npm run autoreply:acl                       # show current lists + effect
//   npm run autoreply:acl show
//   npm run autoreply:acl block add <jid...>    # blacklist: never autoreply these
//   npm run autoreply:acl block rm <jid...>
//   npm run autoreply:acl block clear
//   npm run autoreply:acl allow add <jid...>    # whitelist: only these get autoreply
//   npm run autoreply:acl allow rm <jid...>
//   npm run autoreply:acl allow clear
//   npm run autoreply:acl scope <all|contacts|groups|mixed>
//
// Two independent, persistent controls (data/autoreply/policy.json, read fresh
// per message so changes are live with no restart):
//   - BLOCKLIST is absolute: a listed chat never gets an autoreply, in any mode
//     or scope. Use it for "reply to everyone except these".
//   - ALLOWLIST (contacts + groups) is a whitelist: when it has entries, scope
//     is auto-set so ONLY those chats get autoreply. Use it for "reply only to
//     these". `allow clear` reverts scope to `all`.
//
// Entries can be a full JID (49...@s.whatsapp.net, 123-456@g.us) or a bare
// phone / group id - matching is by normalized local part. Entries ending in
// @g.us are treated as groups; everything else as contacts.

import {
  type AutoReplyPolicy,
  type AutoReplyScope,
  readPolicy,
  writePolicy,
  appendAudit,
} from './autoreply-store.js'

const SCOPES: AutoReplyScope[] = ['all', 'contacts', 'groups', 'mixed']

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function isGroupJid(entry: string): boolean {
  return entry.trim().toLowerCase().endsWith('@g.us')
}

// Derive the scope from allowlist contents so the whitelist "just works":
// entries in both -> mixed, only one side -> that side, empty -> all.
function deriveScope(contacts: string[], groups: string[]): AutoReplyScope {
  const hasContacts = contacts.length > 0
  const hasGroups = groups.length > 0
  if (hasContacts && hasGroups) return 'mixed'
  if (hasContacts) return 'contacts'
  if (hasGroups) return 'groups'
  return 'all'
}

function toInput(policy: AutoReplyPolicy): Omit<AutoReplyPolicy, 'updated_at'> {
  return {
    mode: policy.mode,
    scope: policy.scope,
    contacts: policy.contacts,
    groups: policy.groups,
    blocklist: policy.blocklist,
    draft_only: policy.draft_only,
    active_until: policy.active_until,
    active_hours: policy.active_hours,
    notes: policy.notes,
  }
}

function printPolicy(policy: AutoReplyPolicy): void {
  const whitelistActive = policy.scope !== 'all'
  console.log(`mode      : ${policy.mode}`)
  console.log(`scope     : ${policy.scope}${whitelistActive ? ' (whitelist active - only allowlisted chats)' : ' (all chats, minus blocklist)'}`)
  console.log(`blocklist : ${policy.blocklist.length ? policy.blocklist.join(', ') : '(empty)'}`)
  console.log(`allow/contacts: ${policy.contacts.length ? policy.contacts.join(', ') : '(empty)'}`)
  console.log(`allow/groups  : ${policy.groups.length ? policy.groups.join(', ') : '(empty)'}`)
  console.log(`updated at: ${policy.updated_at}`)
}

function commit(next: Omit<AutoReplyPolicy, 'updated_at'>, action: string): AutoReplyPolicy {
  const previous = readPolicy()
  const saved = writePolicy(next)
  appendAudit('policy_updated', { source: 'acl-cli', action, previous, next: saved })
  return saved
}

function normalizeArgs(entries: string[]): string[] {
  return entries.map((e) => e.trim()).filter(Boolean)
}

function handleBlock(action: string, entries: string[]): void {
  const policy = readPolicy()
  const input = toInput(policy)
  if (action === 'add') {
    if (!entries.length) fail('block add needs at least one jid/phone')
    input.blocklist = [...policy.blocklist, ...entries]
  } else if (action === 'rm' || action === 'remove') {
    if (!entries.length) fail('block rm needs at least one jid/phone')
    const drop = new Set(entries.map((e) => e.toLowerCase()))
    input.blocklist = policy.blocklist.filter((e) => !drop.has(e.toLowerCase()))
  } else if (action === 'clear') {
    input.blocklist = []
  } else {
    fail(`unknown block action "${action}" (add | rm | clear)`)
  }
  const saved = commit(input, `block ${action}`)
  console.log(`blocklist updated (${saved.blocklist.length} entries)\n`)
  printPolicy(saved)
}

function handleAllow(action: string, entries: string[]): void {
  const policy = readPolicy()
  const input = toInput(policy)
  if (action === 'add') {
    if (!entries.length) fail('allow add needs at least one jid/phone')
    const newGroups = entries.filter(isGroupJid)
    const newContacts = entries.filter((e) => !isGroupJid(e))
    input.contacts = [...policy.contacts, ...newContacts]
    input.groups = [...policy.groups, ...newGroups]
  } else if (action === 'rm' || action === 'remove') {
    if (!entries.length) fail('allow rm needs at least one jid/phone')
    const drop = new Set(entries.map((e) => e.toLowerCase()))
    input.contacts = policy.contacts.filter((e) => !drop.has(e.toLowerCase()))
    input.groups = policy.groups.filter((e) => !drop.has(e.toLowerCase()))
  } else if (action === 'clear') {
    input.contacts = []
    input.groups = []
  } else {
    fail(`unknown allow action "${action}" (add | rm | clear)`)
  }
  // Auto-derive scope so the whitelist takes effect (or reverts to 'all').
  input.scope = deriveScope(
    Array.from(new Set(input.contacts.map((v) => v.trim()).filter(Boolean))),
    Array.from(new Set(input.groups.map((v) => v.trim()).filter(Boolean))),
  )
  const saved = commit(input, `allow ${action}`)
  console.log(`allowlist updated -> scope "${saved.scope}"\n`)
  printPolicy(saved)
}

function handleScope(value: string | undefined): void {
  if (!value || !(SCOPES as string[]).includes(value)) {
    fail(`scope needs one of: ${SCOPES.join(', ')}`)
  }
  const policy = readPolicy()
  const input = toInput(policy)
  input.scope = value as AutoReplyScope
  const saved = commit(input, `scope ${value}`)
  console.log(`scope set to "${saved.scope}"\n`)
  printPolicy(saved)
}

function main(): void {
  const [, , sub, action, ...rest] = process.argv
  const entries = normalizeArgs(rest)

  switch (sub) {
    case undefined:
    case 'show':
    case 'status':
      printPolicy(readPolicy())
      return
    case 'block':
      handleBlock(action ?? '', entries)
      return
    case 'allow':
      handleAllow(action ?? '', entries)
      return
    case 'scope':
      handleScope(action)
      return
    default:
      fail(`unknown command "${sub}" (show | block | allow | scope)`)
  }
}

main()
