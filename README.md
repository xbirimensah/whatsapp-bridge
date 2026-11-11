# whatsapp-bridge

> Self-hosted WhatsApp bridge for AI agents. One paired number, exposed via REST, MCP, and a web UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json) [![Built on Baileys](https://img.shields.io/badge/built%20on-Baileys-25D366.svg)](https://github.com/WhiskeySockets/Baileys) [![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](AGENTS.md)

Built on [Baileys](https://github.com/WhiskeySockets/Baileys). Single Node process, SQLite for storage, no runtime dependencies beyond WhatsApp itself.

## What you get

- **REST API** on `127.0.0.1:8080` — read conversations, send messages, manage aliases.
- **MCP server** (stdio) — drops directly into Claude Code, Codex, or any MCP-capable agent.
- **Web UI** at `/` — single-page inbox for reading and sending.
- **Inbound webhook** (optional) — every received message POSTed to a URL of your choice.
- **Full history backfill** on first pair — typically several months of past chats.
- **LID ↔ phone alias merge** — collapses the two JIDs WhatsApp uses for the same person into one conversation.
- **Display name resolution** that works without any local contacts sync (push_name from WhatsApp itself), with optional macOS Contacts enrichment.
- **Local-timezone CLI output** with DST handled by IANA tzdata.
- **Autoreply sidecar** (optional) - drafts replies in your own voice via Claude, notifies you on Telegram, Slack, or your own WhatsApp number, and can auto-send under strict safety gates.

## Tech stack

| Library | Role |
|---|---|
| [Baileys](https://github.com/WhiskeySockets/Baileys) | WhatsApp Web protocol (multi-device, pairing-code login) |
| [Fastify](https://fastify.dev) | REST API + web UI server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | single-file message store (`data/wa.db`, WAL mode) |
| [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) | stdio MCP server for AI agents |
| [Zod](https://zod.dev) | request/webhook payload validation |
| [tsx](https://tsx.is) | runs TypeScript directly - no build step |

Runs anywhere Node 20+ runs. macOS is the primary target; see [docs/cross-platform.md](docs/cross-platform.md) for the exact Linux and Windows patch list (or just use WSL2 on Windows).

## Status

Personal infrastructure. Not multi-tenant. Locked to **one paired number at a time**. Use behind loopback or a reverse proxy you control.

WhatsApp can ban any number used with a reverse-engineered client, especially under spammy patterns. Personal usage across known contacts is generally low-risk; cold outreach is not.

## Install

**Prerequisites:** Node ≥ 20, and a WhatsApp account with the phone on hand (you approve the device link from it).

```bash
git clone https://github.com/obirimensah05/whatsapp-bridge.git
cd whatsapp-bridge
npm install
```

No configuration is required to start — `.env` is created and filled in automatically on first launch.

## Launch

Pair your number — country code + national digits, no `+`, no spaces:

```bash
npm run pair -- main 491761234567
```

On the phone for that number: **WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"** → enter the 8-character code printed in your terminal.

On first launch the bridge:
- generates `API_TOKEN` and writes it to `.env`
- detects your system timezone and writes it as `WA_TZ` to `.env` (e.g. `Europe/Berlin`)
- prints the active timezone at the start of the pair flow so you can confirm it before approving the code

Once paired, the daemon keeps running and the REST API + web UI are live at <http://127.0.0.1:8080/>. Subsequent starts:

```bash
npm run start
```

To switch to a different number:

```bash
rm -rf auth/main/
npm run pair -- main <new-digits>
```

## Running as a service

The daemon is not supervised by default — if it crashes or you reboot, it stays down. Put it under a process supervisor.

**macOS (launchd)** — create `~/Library/LaunchAgents/com.example.whatsapp-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.example.whatsapp-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/npm</string>
        <string>run</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key><string>/Users/YOU/apps/whatsapp-bridge</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
        <key>Crashed</key><true/>
    </dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>/Users/YOU/apps/whatsapp-bridge/logs/whatsapp-bridge.out.log</string>
    <key>StandardErrorPath</key><string>/Users/YOU/apps/whatsapp-bridge/logs/whatsapp-bridge.err.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/apps/whatsapp-bridge/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.whatsapp-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.whatsapp-bridge   # restart after edits
launchctl bootout  gui/$(id -u)/com.example.whatsapp-bridge        # uninstall
```

**Linux (systemd)** — a `systemd --user` unit pointing at `npm run start` with `Restart=on-failure` works the same way.

## Web UI

Open <http://127.0.0.1:8080/> and paste the value of `API_TOKEN` from `.env`. Token is stored in `localStorage`; click *Logout* to clear it.

## REST API

All routes under `/v1/`. All require `Authorization: Bearer <API_TOKEN>` except `/v1/health` and `/`.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/v1/health` | — | `{ ok, sessions, ts }` |
| `GET` | `/v1/conversations` | `?session=` `?limit=` | Chats with last message + `display_name` + `phone` |
| `GET` | `/v1/messages` | `?session=` `?jid=` `?limit=` `?before=` | Paginated messages for one chat (alias-aware) |
| `POST` | `/v1/send` | `{ session, to, text }` | Sends a text |
| `GET` | `/v1/aliases` | `?session=` | LID-to-canonical mappings |
| `POST` | `/v1/aliases` | `{ session, alias, canonical }` | Add/update a mapping |
| `DELETE` | `/v1/aliases` | `{ session, alias }` | Remove a mapping |
| `POST` | `/v1/webhook/test` | — | Pings the configured `WEBHOOK_URL` |

`to` accepts either a JID (`<digits>@s.whatsapp.net`, `<id>@lid`, `<id>@g.us`) or digits-only phone number (no `+`).

Quick example:

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:8080/v1/conversations?session=main&limit=20'
```

## MCP server

The MCP server at `src/mcp.ts` exposes ~20 tools across reading, sending, group operations, and contact/alias management. See [AGENTS.md](AGENTS.md) for the full tool surface and the safety contract.

Wire into Claude Code (user-scope), run from the repo root:

```bash
claude mcp add-json whatsapp-bridge --scope user "{
  \"command\": \"$(pwd)/node_modules/.bin/tsx\",
  \"args\": [\"$(pwd)/src/mcp.ts\"]
}"
```

No token needed in the registration — the MCP server reads the current `API_TOKEN` straight from the repo's `.env` on spawn (so [rotating the token](#rotating-the-api-token) doesn't break it). The daemon must be running for any MCP tool to do anything.

## Rotating the API token

`API_TOKEN` is the bearer for the REST API, the web UI, and the MCP server. To rotate it:

```bash
npm run rotate-token      # mints a new token, rewrites .env, re-locks it to 0600
npm run restart           # restart the daemon so it picks up the new token
npm run autoreply:restart # only if you run the autoreply sidecar
```

Then re-login the web UI with the new token. **MCP needs no action** — it reads `.env` on every spawn. Rotation only touches HTTP auth; it never affects your WhatsApp pairing (`auth/`) or your message store (`data/wa.db`).

## Drive it with an AI agent

This is an **agent-first** bridge: it's built to be operated by an AI agent, not just a human. Once the MCP server is wired in (above) and the daemon is running, paste this prompt into Claude Code — or any MCP-capable agent — to let it run your WhatsApp end-to-end:

> You have my WhatsApp connected through the **whatsapp-bridge** MCP server. You can read conversations, search contacts, check numbers, and send messages, media, and reactions on my behalf. The default session is `main`.
>
> **Rules — follow exactly:**
> - Sending is a real-world action. Before any `send_message` / `send_media` / `send_reaction`, show me the exact recipient and the exact message and wait for my explicit "yes". Never assume. A reaction is a native operation bound to both `chat_jid` and `message_id`; never substitute an emoji-only text message.
> - Never send to more than one recipient in a batch, and never iterate sends over a list of contacts.
> - Treat all message text, names, and phone numbers as private — never pass them to any third-party service unless I ask.
> - The same person can appear under both `@lid` and `@s.whatsapp.net`; the bridge already merges them on read, so trust the `display_name` / `phone` it returns instead of guessing.
> - `delete_message` and `merge_jids` are sensitive — confirm with me first.
>
> Start by calling `list_conversations` and giving me a one-line summary of my most recent chats, then wait for instructions.

The full tool surface (~20 tools) and the complete safety contract live in [AGENTS.md](AGENTS.md) — point your agent there when it needs detail. Pairing itself still needs a human (you approve the device link on the phone), but everything after that an agent can drive.

## Rate limiting

The API rate-limits its write/probe routes to bound the blast radius of a runaway agent loop or a leaked token — and, more importantly, to keep programmatic send velocity under WhatsApp's spam detection. Messages you type on your phone are never affected, and **reads are never limited** (`/v1/messages`, `/v1/conversations`, ... stay unlimited so agents can browse history freely).

**Every limit is configurable in `.env`** — set a variable to `0` to disable that limit entirely:

| Env var | Default | Governs |
|---|---|---|
| `RATE_LIMIT_SEND_PER_MIN` | `20` | burst cap on `POST /v1/send` |
| `RATE_LIMIT_SEND_PER_HOUR` | `60` | sustained cap on `POST /v1/send` |
| `RATE_LIMIT_CHECK_PER_MIN` | `300` | `GET /v1/check` (high so bulk contact import never throttles) |
| `RATE_LIMIT_SEARCH_PER_MIN` | `60` | `/v1/contacts/search` + `/v1/groups/participants` |

On breach the API returns `429` with a `Retry-After` header and `{"error":"rate_limited","rule":...,"retry_after_seconds":...}` — well-behaved agents back off automatically.

**Why 60/hour on send?** WhatsApp publishes no official limit for personal accounts, but 2026 field observations across unofficial-client deployments converge on: **< 30 msgs/hour safe, 30–60/hr warning, > 60/hr danger** — plus penalties for low reply rates (< 15%), messaging many new contacts (> 50/day), and repeated identical messages (> 15/hr). Accounts on unofficial clients (like this bridge) are scrutinized harder. The default sustained cap sits at the edge of the warning zone; raise it only if you understand the ban risk to your number.

## Autoreply sidecar (optional)

A separate local process (`src/autoreply-*.ts`) that turns the bridge into a draft-and-review (or fully automatic) reply machine. It runs alongside the daemon on its own port (`127.0.0.1:8081`) and talks to the bridge only over its local REST API.

```bash
npm run autoreply               # boot sidecar
npm run autoreply:build-corpus  # rebuild style corpus from WA history
npm run autoreply:setup-notify  # guided setup: pick where draft notifications go
npm run autoreply:model         # show / switch which LLM writes drafts (see below)
npm run autoreply:acl           # manage the allow/block lists (see below)
npm run autoreply:link -- <url> # preview the link context a message would build
```

### How a message flows through it

1. **Inbound message arrives.** The bridge POSTs it to the sidecar via the inbound webhook (`WEBHOOK_URL=http://127.0.0.1:8081/webhook`).
2. **Policy check.** The sidecar evaluates `data/autoreply/policy.json`: is the mode `draft`, `auto`, or `off`? Is this chat **blocklisted** (never replied to) or, when a whitelist is set, in scope (`all` / specific `contacts` / `groups` / `mixed`)? Are we inside the configured `active_hours` / `active_until` window? If any check fails, nothing happens beyond an audit log entry. Manage the lists with `npm run autoreply:acl` (see "Allow / block lists").
3. **Enrichment.** For voice notes the sidecar waits for the transcript; for text it pulls the stored message so quoted context is available.
4. **Draft generation.** Your configured LLM writes a reply in the operator's voice (see "Which LLM writes the drafts" below). It is grounded in a style corpus built from your own sent messages (auto-built from WhatsApp history on the first draft if missing) and in reference context pulled from your own WhatsApp history - the recent conversation with that chat plus keyword matches across all stored messages. The model returns JSON: `reply`, `confidence` (0-1), `should_send`, `needs_review`, `reasons`.
5. **Notification.** The draft is delivered to your chosen channel - Telegram, Slack, your own WhatsApp number, or a webhook (see below) - together with the incoming message, the confidence score, and the model's reasons.
6. **Auto-send (only in `auto` mode).** If every safety gate passes, the reply is sent through the bridge's `/v1/send`. If any gate blocks it, the draft is delivered as a notification flagged `needs_review` instead - it fails safe to human review.

Every step is appended to `data/autoreply/audit.ndjson`; every draft to `data/autoreply/drafts.ndjson`.

The sidecar can also turn messages into tasks for a coding agent, with approval in your own chat. It is off by default; see [docs/tasks.md](docs/tasks.md).

### How the confidence threshold works

The model self-scores each draft with a `confidence` value between 0 and 1: how sure it is that the reply is correct, complete, and safe to send without a human looking at it. `AUTOREPLY_MIN_CONFIDENCE` (default **0.78**) is the cutoff:

- In **draft mode** the threshold changes nothing - you always get the notification and decide yourself. The score is shown so you learn how the model calibrates.
- In **auto mode** a draft below the threshold is never sent. It is delivered as a review notification instead, with `confidence below minimum threshold` in the reasons.

The threshold is necessary but not sufficient. In auto mode a reply is only sent when **all** of these hold:

| Gate | Blocks when |
|---|---|
| Confidence | `confidence < AUTOREPLY_MIN_CONFIDENCE` |
| Model flags | model set `should_send=false` or `needs_review=true` (it must do so for ambiguous, emotional, legal, financial, or fact-dependent messages) |
| Sensitive topics | incoming text matches regex lists for money, legal, medical, credentials/OTP, or scheduling terms |
| Message shape | incoming text empty, longer than 280 chars, or spanning 3+ lines; draft empty or longer than 280 chars |
| Cooldown | an auto-send already happened in this chat within `AUTOREPLY_AUTO_SEND_COOLDOWN_MS` (default 10 min) |
| Duplicate | this exact inbound message was already processed into a draft |
| Groups | group chats are never auto-answered unless `AUTOREPLY_ALLOW_GROUP_AUTO=1`, and even then only when the operator is explicitly @-mentioned |

Tuning: raise the threshold (e.g. `0.9`) to make auto mode very conservative; lower it only after reviewing drafts in draft mode for a while and confirming the scores match your judgment. Start with `draft` mode for everything, and enable `auto` only for narrow contact scopes and time windows.

### Which LLM writes the drafts

Any of them, **switchable at runtime** (no restart) - the `.env` vars are only the fallback default:

```bash
npm run autoreply:model                       # show active model + all providers
npm run autoreply:model -- test openai gpt-5  # connectivity check, no switch
npm run autoreply:model -- use openai gpt-5   # switch (gated on a live connectivity check)
npm run autoreply:model -- use codex-cli gpt-5-codex
npm run autoreply:model -- use openai llama3.1 --base-url http://127.0.0.1:11434/v1  # local, free
```

| Provider | What it uses | Needs |
|---|---|---|
| `claude-cli` (default) | the local `claude` CLI | Claude Code installed - no API key |
| `codex-cli` | the local `codex` CLI (`codex exec`) | Codex CLI + `codex login` - no API key |
| `anthropic` | Anthropic API (official SDK) | `ANTHROPIC_API_KEY` or `AUTOREPLY_LLM_API_KEY` |
| `openai` | any OpenAI-compatible endpoint - OpenAI (gpt-5), OpenRouter, Groq, Mistral, Ollama, LM Studio | model + `OPENAI_API_KEY` (key optional for local endpoints) |

A switch only lands if the provider is authed/reachable **and** the model actually responds. `--key` stores the key in `.env` (never sent over http to a non-localhost host). Full configuration examples: [docs/autoreply.md](docs/autoreply.md).

### Allow / block lists

Two persistent controls, managed with `npm run autoreply:acl`:

```bash
npm run autoreply:acl                         # show current lists
npm run autoreply:acl block add 491234567890  # blacklist: never reply to this chat
npm run autoreply:acl allow add 491700000000  # whitelist: reply only to allowed chats
npm run autoreply:acl allow clear             # back to replying to everyone
```

- **Blocklist** is absolute - a listed chat never gets a reply, in any mode/scope. "Reply to everyone except these."
- **Allowlist** (`allow add`) flips to whitelist mode - only listed chats get a reply. "Reply only to these."

Details: [docs/autoreply.md](docs/autoreply.md).

### Where the drafts go: notification channels

Pick **one** channel; the wizard guides you through the credentials for each:

```bash
npm run autoreply:setup-notify
```

| Channel | What it looks like | Needs |
|---|---|---|
| **Telegram** | a bot DMs you each draft | free bot via @BotFather (2 min) |
| **Slack** | drafts post into a channel or DM | incoming webhook, or bot token + channel |
| **Your own WhatsApp number** | the bridge messages your "Message yourself" chat or a second number - no extra app | just the number |
| **Generic webhook** | raw JSON POST to any URL | your endpoint |

The choice is stored as `AUTOREPLY_NOTIFY_CHANNEL` in `.env`; when set, only that channel is used. The WhatsApp channel has built-in loop protection: messages in the notify chat are excluded from autoreply processing, so a notification can never generate a draft about itself.

Step-by-step guides: [docs/sop-notifications-human.md](docs/sop-notifications-human.md) (for people) and [docs/sop-notifications-agent.md](docs/sop-notifications-agent.md) (for AI agents doing the setup).

### Controlling the policy

```bash
TOKEN=$(grep '^AUTOREPLY_TOKEN=' .env | cut -d= -f2)

# see current policy
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/policy

# draft mode for everything (the safe default)
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8081/policy \
  -d '{"mode":"draft","scope":"all","contacts":[],"groups":[],"active_until":null,"active_hours":null}'

# kill switch
npm run autoreply:off
```

Full reference (env vars, routes, policy modes, safety gates): [docs/autoreply.md](docs/autoreply.md).

## Inbound webhook (optional)

Set `WEBHOOK_URL` in `.env` and restart. Every inbound message POSTs:

```json
{
  "event": "message",
  "session": "main",
  "message": {
    "id": "main:ABC123",
    "ts": 1735689600000,
    "direction": "in",
    "chat_jid": "12025550100@s.whatsapp.net",
    "from_jid":  "12025550100@s.whatsapp.net",
    "type": "text",
    "body": "hi",
    "from_display_name": "Jane Doe",
    "from_phone": "+12025550100",
    "chat_phone": "+12025550100"
  }
}
```

If `WEBHOOK_TOKEN` is set, it arrives as `Authorization: Bearer <token>` so the receiver can verify origin. Three attempts, 1s/3s backoff, 5s timeout per attempt. Outbound sends do **not** fire the webhook.

## Configuration

All variables are read from `.env` at startup; all are optional with sensible defaults.

| Variable | Default | Notes |
|---|---|---|
| `API_TOKEN` | auto-generated | 32-byte hex token written to `.env` on first run if absent. |
| `WA_TZ` | system tz | Auto-detected on first boot and persisted. Use IANA names (`Europe/Berlin`, `America/New_York`) — DST is handled by tzdata. |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only behind a reverse proxy. Set `WA_ALLOW_PUBLIC=1` to override the loopback guard. |
| `PORT` | `8080` | |
| `WEBHOOK_URL` | (disabled) | If set, every inbound message POSTs to this URL. |
| `WEBHOOK_TOKEN` | (none) | Optional bearer token for `WEBHOOK_URL`. |
| `OPENAI_API_KEY` | (none) | Used by `npm run transcribe-backlog` to transcribe past audio messages. |

## NPM scripts

| Command | Purpose |
|---|---|
| `npm run start` | Boot the daemon. |
| `npm run dev` | Same, with `tsx --watch`. |
| `npm run pair -- main <digits>` | Pair a number. Refuses if any session already exists. |
| `npm run history` | CLI dump of recent messages, with display names, in local time. |
| `npm run import-contacts -- --session=main` | Bulk-enrich contacts from macOS Contacts.app (`--refresh`, `--limit=N`). |
| `npm run transcribe-backlog` | Run Whisper over past audio messages without transcripts. |
| `npm run backup` | SQLite backup of `data/wa.db` into `data/backups/`. |
| `npm run mcp` | Spawn the MCP stdio server (Claude Code launches this automatically). |
| `npm run autoreply` | Boot the local autoreply sidecar (separate process). See [docs/autoreply.md](docs/autoreply.md). |
| `npm run autoreply:dev` | Same, with `tsx --watch`. |
| `npm run autoreply:build-corpus` | Rebuild the style corpus from outbound WhatsApp history + second-brain notes. |
| `npm run autoreply:model` | Show or switch which LLM writes drafts (`current` / `list` / `test` / `use`). |
| `npm run autoreply:acl` | Manage the autoreply allow/block lists. |
| `npm run autoreply:link -- <url>` | Preview the link context a message would build. |
| `npm run typecheck` | `tsc --noEmit` — strict mode is on. |

See [COMMANDS.md](COMMANDS.md) for the full reference including REST examples and common ops.

## Layout

```
src/
  index.ts       boot — restore the paired session + start API
  wa.ts          WaManager — socket, send, history sync, group meta refresh
  db.ts          SQLite schema + queries (single source of truth for SQL)
  api.ts         Fastify REST + static UI route
  mcp.ts         MCP stdio server (talks HTTP to api.ts)
  webhook.ts     inbound dispatcher with retries
  env.ts         .env loader + API_TOKEN/WA_TZ auto-persist
  time.ts        formatLocal(ts) for CLI/log timestamps
  history.ts     CLI: print recent messages with display names
web/index.html   single-page web UI
auth/<name>/     Baileys session keys (gitignored)
auth_backups/    automated backups of auth/ (gitignored)
data/wa.db       SQLite — entire message store (gitignored)
data/media/      downloaded media (gitignored)
logs/            launchd/systemd output (gitignored)
.env             secrets + config (gitignored)
```

## How history is backfilled

`syncFullHistory: true` is enabled in `wa.ts`. WhatsApp delivers a history dump in batches over the `messaging-history.set` event after pairing. The bridge ingests chats, contacts, and messages into SQLite. Existing rows are deduped by primary key.

To force a fresh dump:

1. On the phone, **Settings → Linked Devices** → log out the whatsapp-bridge entry.
2. `rm -rf auth/main/` and re-run `npm run pair -- main <digits>`.
3. SQLite messages and aliases survive the wipe (they live in `data/`, not `auth/`).

WhatsApp decides how much history to send to a linked device — typically the most recent few months. There is no API to request "everything since the dawn of time."

## LID vs phone — the merge layer

Inbound messages from non-contacts often arrive with a `<id>@lid` JID instead of `<phone>@s.whatsapp.net`. WhatsApp does this for privacy. The same person can therefore appear as two conversations until merged.

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8080/v1/aliases \
  -d '{"session":"main","alias":"123456789@lid","canonical":"491761234567@s.whatsapp.net"}'
```

After that, `listConversations` and `listMessages` collapse them on read. Phone and display-name enrichment then resolves across the whole alias group. The MCP equivalent is `merge_jids` / `unmerge_jid`.

## Risks and limits

- **WhatsApp can ban the number.** Ban rate scales with how spammy your usage looks. Personal use across known contacts is generally safe; cold outreach is not.
- **Baileys breakage.** WhatsApp ships protocol changes occasionally; expect to bump `@whiskeysockets/baileys` every few months. The bridge has a built-in update notifier.
- **Pairing-code identifiers.** Some `browser` identifiers cause WhatsApp to reject pairing codes. The bridge uses `Browsers.macOS('Safari')` because it's known-good — don't change it without testing.
- **History sync size.** Initial sync can pull thousands of messages. First batch usually lands within a few seconds.
- **Single device.** WhatsApp enforces a limit on linked devices per account. Pairing whatsapp-bridge consumes one slot.

## License

[MIT](LICENSE). Do whatever you want with it; keep the copyright notice. No warranty.
