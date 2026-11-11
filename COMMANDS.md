# whatsapp-bridge commands

Quick reference for operating the bridge. Companion to `README.md` (setup) and `AGENTS.md` (MCP contract).

> The bridge is locked to **one paired session at a time**. `npm run start` refuses to boot with more than one session under `auth/`. To re-pair or switch numbers: `rm -rf auth/<name>/` first.

## Timezone

On first boot, the bridge auto-detects your system timezone and saves it to `.env` as `WA_TZ` (e.g. `Europe/Berlin`). All CLI/log timestamps render in this zone. The pair flow prints the active TZ for confirmation.

To change it, edit `.env` and restart:
```
WA_TZ=America/New_York
launchctl kickstart -k gui/$(id -u)/local.whatsapp-bridge
```

Use **IANA names** (`Europe/Berlin`, `America/New_York`, `Asia/Singapore`) — fixed offsets like `+02:00` would break around DST changes. IANA tzdata handles DST automatically.

## Shell commands

All run from `~/apps/whatsapp-bridge`. There is no build step.

| Command | Purpose |
|---|---|
| `npm install` | One-time dependency install. |
| `npm run start` | Boot the daemon: restore the paired session, start API on `127.0.0.1:8080`. |
| `npm run bridge:control -- on` | Turn the WhatsApp transport on. This is the default state after a fresh install or reboot. |
| `npm run bridge:control -- off` | Turn the WhatsApp transport off while leaving the authenticated local API available to turn it back on. |
| `npm run dev` | Same as start, with `tsx --watch` (auto-reload on `src/` edits). |
| `npm run pair -- main <digits>` | Pair a number. Prints an 8-char code; approve on the phone via Linked Devices. Digits only, no `+`. Blocked if any session already exists. |
| `npm run history` | CLI dump of recent messages for the current session. |
| `npm run import-contacts -- --session=main` | Bulk-enrich contacts from macOS Contacts.app. Flags: `--refresh`, `--limit=N`. |
| `npm run transcribe-backlog` | Run Whisper over audio messages that don't have transcripts yet. |
| `npm run backup` | SQLite backup of `data/wa.db` into `data/backups/`. |
| `npm run mcp` | Spawn the MCP stdio server (Claude Code launches this automatically). |
| `npx tsc --noEmit` | Type-check before declaring work done. Strict mode is on. |

## REST API

All routes under `/v1/`. Bearer token from `.env` (`API_TOKEN=…`). See `README.md` for the full route table.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)

# health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/health

# recent conversations
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/v1/conversations?session=main&limit=20'

# messages for one chat
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/v1/messages?session=main&jid=4915XXXXXXXX@s.whatsapp.net&limit=50'

# send a text
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"session":"main","to":"4915XXXXXXXX@s.whatsapp.net","text":"hello"}' \
  http://127.0.0.1:8080/v1/send
```

## Web UI

`http://127.0.0.1:8080/` — paste the `API_TOKEN` from `.env`, then browse and send. Token is held in `localStorage`; click *Logout* to clear it.

## MCP tools

Callable from any Claude Code conversation while the daemon is running. Full contract in `AGENTS.md`.

**Read**
- `list_sessions` — which numbers are paired (will return one entry).
- `list_conversations` — recent chats, sorted by last activity. Params: `session`, `limit`.
- `read_conversation` — messages for one chat. Params: `session`, `jid`, `limit`, `before` (unix ms for paging).

**Send**
- `send_message` — text. Params: `session`, `to`, `text`.
- `send_media` — image / audio / document. Params: `session`, `to`, `path`, `caption?`.
- `send_reaction` — native emoji reaction, requiring both `chat_jid` and the target `message_id`; it is never an emoji-only text send.
- `send_typing` — show "typing…" indicator.

**Groups**
- `group_info` — subject, description, participant count.
- `group_participants` — full participant list with names.
- `group_invite_link` — get/revoke link.
- `group_leave` — leave a group.

**Contacts & aliases**
- `resolve_contact` — name/phone lookup for a JID.
- `search_contacts` — fuzzy search over the address book.
- `check_number` — confirm a phone number is on WhatsApp.
- `list_aliases` — LID ↔ phone-number mappings.
- `merge_jids` / `unmerge_jid` — manually link or unlink two JIDs that belong to the same person.

**Admin**
- `mark_read` — clear unread badge for a chat.
- `delete_message` — delete for everyone (recent messages only, WhatsApp time limit applies).
- `refresh_profile_pic` — re-fetch a contact's avatar.

## Files

| Path | Purpose |
|---|---|
| `auth/main/` | Baileys session keys for the paired number. Deleting forces a re-pair. |
| `data/wa.db` | SQLite — entire message store. WAL mode, foreign keys on. |
| `data/media/main/` | Downloaded media (images, audio, documents). |
| `data/daemon.log` | Daemon stdout (when started via nohup); otherwise logs go to wherever the terminal points. |
| `.env` | Bearer token, webhook URL, OpenAI key for transcription. Gitignored. |

## Common operations

```bash
# stop the daemon (find the parent npm process)
pgrep -f 'tsx src/index.ts' | xargs kill

# tail the live log if started under launchd
tail -f logs/whatsapp-bridge.out.log

# inspect the DB directly
sqlite3 data/wa.db

# switch to a different number
rm -rf auth/main/
npm run pair -- main <new-digits>
```
