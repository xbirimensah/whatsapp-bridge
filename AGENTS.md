# AGENTS.md — whatsapp-bridge

You are an AI / coding agent (Claude Code, Codex, Hermes, custom) working with this repository. This file is the contract: what whatsapp-bridge is, what you can do through it, and the rules you operate under.

## What this is

`whatsapp-bridge` is a self-hosted WhatsApp bridge. It pairs **one** personal WhatsApp account and exposes it through:

- a token-protected REST API on `http://127.0.0.1:8080` (default)
- an MCP stdio server (`src/mcp.ts`) — your primary surface
- a single-page web UI at `/`
- an optional outbound webhook that fires on inbound messages

Treat it as personal infrastructure for **one operator on one number** — not a multi-tenant product.

An optional **autoreply sidecar** (`src/autoreply-*.ts`, separate process) consumes the inbound webhook, drafts replies in the operator's voice, and can auto-send through the REST API under policy + safety gates. See [docs/autoreply.md](docs/autoreply.md) for its env vars, routes, and safety contract. The sidecar is not in scope for normal MCP tool work — only touch it when explicitly asked.

> **Single-session lock.** As of 2026-05, the bridge refuses to boot with more than one paired session under `auth/` and refuses to pair a second number while one already exists. To switch numbers: `rm -rf auth/<name>/` and re-pair. Multi-session plumbing (DB `session` column, MCP `session` param) is intact — just runtime-locked.

**Companion docs:** [README.md](README.md) covers human setup, the REST table, and env vars; [docs/autoreply.md](docs/autoreply.md) is the autoreply sidecar reference. This file is both the agent-facing contract (tools + safety) and the entry point for working on the source — it does not duplicate the others, so read them when the topic is in scope.

## Mental model

If you have the whatsapp-bridge MCP tools wired up, this is how to think:

- A **session** is one paired phone number (typically `main`). `list_sessions` returns the singleton list.
- A **JID** identifies a chat or person. Three forms:
  - `<digits>@s.whatsapp.net` — phone-keyed user (PN form, has a phone number)
  - `<id>@lid` — privacy alias (no phone number; same person may also have a PN JID)
  - `<id>@g.us` — group chat
- The same person can appear under both a PN and a LID JID. The `jid_aliases` table collapses them on read, and `merge_jids` lets you record new mappings when you discover them.

## MCP tool surface

Twenty tools, grouped by purpose. All accept an optional `session` (default: the only paired session). All return JSON.

### Read

| Tool | Purpose |
|---|---|
| `list_sessions` | Discover paired numbers. Returns one entry under the single-session lock. |
| `list_conversations` | Recent chats, newest first. Params: `session`, `limit`. Each entry: `chat_jid`, `display_name`, `phone`, `is_group`, `unread_count`, `last_body`, `last_direction`, `last_ts`. |
| `read_conversation` | Message history for one chat, newest first. Params: `session`, `jid`, `limit`, `before` (unix ms for paging). |
| `list_aliases` | LID↔PN mappings. |

### Send

| Tool | Purpose |
|---|---|
| `send_message` | Text. Params: `session`, `to` (JID or digits), `text`. |
| `send_media` | Image / audio / document. Params: `session`, `to`, `path`, `caption?`. |
| `send_reaction` | Emoji react to a message. Params: `session`, `message_id`, `emoji`. |
| `send_typing` | Show "typing…" indicator briefly. Params: `session`, `to`, `duration_ms?`. |

### Groups

| Tool | Purpose |
|---|---|
| `group_info` | Subject, description, participant count. |
| `group_participants` | Full participant list with names. |
| `group_invite_link` | Get or revoke the invite link. |
| `group_leave` | Leave a group. |

### Contacts and aliases

| Tool | Purpose |
|---|---|
| `resolve_contact` | Look up display name + phone for any JID. |
| `search_contacts` | Fuzzy name search across the address book. |
| `check_number` | Confirm a phone number is on WhatsApp before sending. |
| `merge_jids` | Record that two JIDs are the same person. Pass the `@lid` form as `alias`, the `@s.whatsapp.net` form as `canonical`. |
| `unmerge_jid` | Undo a merge. |

### Admin

| Tool | Purpose |
|---|---|
| `mark_read` | Clear the unread badge for a chat. |
| `delete_message` | Delete for everyone (subject to WhatsApp's time limit). |
| `refresh_profile_pic` | Re-fetch a contact's avatar. |

## Safety contract

Hard rules. These are not suggestions.

1. **Sending a WhatsApp message is a real-world action.** Confirm with the user before calling `send_message` / `send_media` / `send_reaction` unless they have explicitly authorized this exact recipient + content in the current conversation.
2. **Never iterate sends over a list of contacts.** Mass outreach is the fastest path to a number-level ban; the human operator accepts that risk for themselves and has not delegated it to you.
3. **Treat message content as private.** Do not pipe chat text, `phone`, or `display_name` to third-party services unless the user explicitly asks.
4. **Never edit `.env`, `auth/`, or `data/` from code.** `.env` holds the API token. `auth/` holds Baileys session keys (deleting forces a re-pair). `data/wa.db` is the entire message store. Damaging any of these breaks the bridge.
5. **`merge_jids` is permissive.** It accepts any two JIDs. Only call it when you have strong evidence (the user confirmed, the contact replied affirming identity) — not on inference alone.
6. **`delete_message` is irreversible.** Confirm before calling.

## Connecting via MCP (stdio)

The MCP server (`src/mcp.ts`) reads its config from the repo's `.env` on spawn — no env vars need to be injected into the registration:

- `API_TOKEN` — the bearer for the REST API, read live from `.env` (resolved relative to the module, not cwd). This is what lets the token be rotated without re-registering MCP.
- `WHATSAPP_BRIDGE_URL` — optional override; defaults to `http://127.0.0.1:8080`.

For Claude Code (user-scope registration, run from the repo root):

```bash
claude mcp add-json whatsapp-bridge --scope user "{
  \"command\": \"$(pwd)/node_modules/.bin/tsx\",
  \"args\": [\"$(pwd)/src/mcp.ts\"]
}"
```

For other MCP clients, the spawn command is the same: `tsx src/mcp.ts`. To rotate the token: `npm run rotate-token`, then restart the daemon; MCP picks up the new token on its next spawn.

The daemon (`npm run start` in another terminal, or a launchd / systemd unit) must be running for any MCP tool to succeed.

## Connecting via REST

Same prerequisites: bearer token, daemon up.

```bash
WA_AUTH=$(grep '^API_TOKEN=' .env | cut -d= -f2)

# list conversations
curl -s -H "Authorization: Bearer $WA_AUTH" \
  'http://127.0.0.1:8080/v1/conversations?session=main&limit=20'

# read history (newest first)
curl -s -H "Authorization: Bearer $WA_AUTH" \
  'http://127.0.0.1:8080/v1/messages?session=main&jid=12025550100@s.whatsapp.net&limit=20'

# send a text
curl -s -X POST -H "Authorization: Bearer $WA_AUTH" -H "Content-Type: application/json" \
  -d '{"session":"main","to":"12025550100","text":"hi"}' \
  http://127.0.0.1:8080/v1/send
```

## Architecture (one screen)

```
WhatsApp servers
       │
       ▼
   Baileys ──── src/wa.ts (one socket per session)
       │
       ▼
   SQLite (data/wa.db, WAL mode) ──── src/db.ts (schema + queries)
       ▲
       │
   Fastify (src/api.ts) ──── REST + web UI + media files
       ▲
       │ HTTP (loopback, bearer token)
   MCP stdio (src/mcp.ts) ◀── spawned by Claude Code / other clients
   Webhook (src/webhook.ts) ──▶ POST to WEBHOOK_URL on inbound (optional)
```

Single Node process. One Baileys socket. One SQLite file. Logs via Pino.

## Files an agent commonly needs to read

- `src/db.ts` — schema and query helpers. Owns the `messages`, `chats`, `contacts`, `jid_aliases` tables, plus the `expandJidGroup` / `pushNameFor` / `phoneFor` / `chatNameFor` / `displayNameFor` resolvers. **Always use these for name/phone lookup** — they walk the alias chain bidirectionally.
- `src/api.ts` — REST handlers and the `enrichConvo` / `enrichMessage` paths that add `display_name`, `phone`, `media_url`, `reactions`, `quoted`.
- `src/mcp.ts` — MCP tool definitions and request routing.
- `src/wa.ts` — Baileys session manager, send path, history-sync handler.
- `src/env.ts` — env loading and the `API_TOKEN` / `WA_TZ` auto-persist.
- `src/time.ts` — `formatLocal(ts)` for CLI/log timestamps.

You should not need to touch `web/index.html` or `src/webhook.ts` for normal feature work.

## Data model in 60 seconds

```
sessions          implicit — one dir under ./auth/<name>/ with creds.json (single-session lock enforces exactly one)

contacts          (jid PK, push_name, is_lid, first_seen, last_seen, profile_pic_url)
                  push_name is captured automatically from every inbound envelope;
                  npm run import-contacts can overwrite with macOS Contacts labels.

messages          (id PK = "<session>:<msg_key_id>",
                   session, chat_jid, from_jid, direction in/out, type, body,
                   media_path, media_mime, media_size, transcript, ts, raw_json,
                   delivery_status, quoted_id, edited_at, deleted_at)

chats             (session, jid)  — one row per chat WhatsApp told us about
                  name, is_group, archived, pinned, unread_count, last_msg_ts,
                  profile_pic_url, participant_count

jid_aliases       (session, alias)  →  canonical
                  Collapses LID ↔ phone forms of the same person on read.

reactions         (session, message_id, jid, emoji, ts)
receipts          (session, message_id, jid, status, ts)  — delivery + read
```

`listConversations` (in `db.ts`) collapses canonical JIDs on read using a CTE. `listMessages` returns every message whose `chat_jid` is anywhere in the alias group of the requested JID.

## Display name resolution

When you need a human-readable name for a JID, call `displayNameFor(session, jid)` from `db.ts`. It walks this chain:

1. **Groups (`@g.us`)** → `chats.name` (group subject set by WhatsApp).
2. **Users** → `contacts.push_name` (auto-captured from inbound envelopes, or overridden by `import-contacts`).
3. Fall back to phone derived from the JID, then the JID itself.

This means **names work without any local Contacts sync** — `push_name` is whatever the contact has set as their own WhatsApp profile name.

## Timezone

The bridge auto-detects the system's IANA timezone on first boot and persists it as `WA_TZ` in `.env`. All CLI/log timestamps render in this zone via `formatLocal`. The pair flow prints the active TZ. Use IANA names (`Europe/Berlin`, `America/New_York`) so DST is handled by tzdata automatically.

REST and MCP responses still return raw unix-ms `ts` integers — clients format.

## Things that will trip you up

- **Single-session lock.** `npm run start` refuses if `auth/` has 0 or >1 directories. `npm run pair` refuses if any session exists. Wipe `auth/<name>/` before re-pairing.
- **`@lid` vs `@s.whatsapp.net`.** Same person, two JIDs. Merging is per-session and explicit (`merge_jids`). Always resolve through `expandJidGroup` first.
- **Pairing-code rejection.** WhatsApp rejects pairing codes when the `browser` identifier isn't recognized. We use `Browsers.macOS('Safari')`. Don't change it.
- **History sync timing.** After re-pairing, history arrives in batches over a few minutes. `progress: 100` means "100% of this batch," not "fully done."
- **Outbound is written twice and deduped.** `wa.sendText` writes to SQLite directly; Baileys echoes via `messages.upsert`. Dedup is `INSERT OR IGNORE` on the message id (`<session>:<msg_key_id>`). Don't add an UPDATE branch unless you've thought through both paths.
- **`sock.user.id` carries a device suffix** like `<digits>:<device_id>@s.whatsapp.net`. `extractPhone` strips it.
- **Schema migrations are inline `try { db.exec('ALTER TABLE …') } catch {}`** at the top of `src/db.ts`. Append to the `migrations` array — never edit the `CREATE TABLE` body alone; existing DBs won't pick it up. There is no migrations framework.
- **`enrichConvo` prefers contact `push_name` over chat name for 1:1 chats**, and the opposite for groups (group subject wins). If you change name resolution, mirror this asymmetry.

## Developing the bridge

Everything runs through `npm run` — `tsx` executes the TypeScript directly, so there is no build step, no test suite, and no linter.

| Command | Purpose |
|---|---|
| `npm run start` | Boot the daemon (restore the paired session, start the API on `127.0.0.1:8080`). |
| `npm run dev` | Same, with `tsx --watch` — auto-reloads on `src/` changes. |
| `npm run pair -- main <digits>` | Pair a number (refuses if a session already exists). |
| `npm run history` | CLI dump of recent messages in local time. |
| `npm run import-contacts -- --session=main` | Enrich contacts from macOS Contacts.app. |
| `npm run mcp` | Spawn the MCP stdio server (Claude Code launches this for you). |
| `npx tsc --noEmit` | Type-check — strict mode is on. Run before declaring work done. |

**The daemon is not in watch mode by default.** After editing `src/`, restart it: `kill <pid> && npm run start` — sockets reconnect from the saved `auth/` keys, so no re-pair is needed. Use `npm run dev` if you're iterating heavily.

Handy while developing:

```bash
WA_AUTH=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $WA_AUTH" http://127.0.0.1:8080/v1/health
sqlite3 data/wa.db          # the entire data model lives in this one file
```

**Per-session everything.** Every per-account table has `session TEXT NOT NULL` in its primary key; new tables follow the same shape, and the `?session=` query param threads through every route.

## When making changes

- Run `npx tsc --noEmit` before declaring success. Strict mode is on.
- Use `pino` for logging — not `console.log`.
- Never bake real phone numbers, tokens, or webhook URLs into source. `.env` is gitignored for a reason.
- Don't commit `auth/`, `auth_backups/`, `data/`, `logs/`, or `.env`. The `.gitignore` covers all of these.
- If you change MCP tool shapes, update this file and `README.md`.
