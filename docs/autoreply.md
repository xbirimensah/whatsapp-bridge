# WhatsApp Autoreply MVP

This repo includes a local autoreply service that sits beside `whatsapp-bridge`.

## What it does now

- runs a local HTTP service for autoreply control
- accepts immediate webhook calls from `whatsapp-bridge`
- builds a style corpus from outbound WhatsApp history plus second-brain content
- generates draft replies in the operator's voice with a configurable LLM (Claude CLI by default, Anthropic API, or any OpenAI-compatible API)
- sends live draft notifications to Telegram, Slack, your own WhatsApp number, or a generic webhook (selectable)
- can auto-send through the local `whatsapp-bridge` API when policy + safety checks allow it
- stores policy in `data/autoreply/policy.json`
- logs drafts to `data/autoreply/drafts.ndjson`
- logs audit events to `data/autoreply/audit.ndjson`
- keeps opt-in escalation state in `data/autoreply/escalation.json`
- keeps bounded operator feedback in `data/autoreply/feedback.json`

## Current status

Implemented and verified:

- `draft` / `auto` / `off` policy modes
- scope targeting for all / contacts / groups / mixed
- time-window controls
- webhook delivery from `whatsapp-bridge` into the autoreply service
- transcript-aware enrichment for inbound messages
- Telegram draft notification delivery
- basic auto-send safety gates:
  - model confidence threshold
  - model `should_send` / `needs_review` flags
  - sensitive-topic regex blocks
  - per-chat auto-send cooldown
  - duplicate inbound-message protection
  - group auto-send disabled by default
  - trivial generated acknowledgements never become text sends
  - lexical language compatibility is rechecked at the text-send boundary

Still worth improving later:

- more granular risk profiles per contact/group
- richer corpus retrieval by topic/contact/recency
- operator UI/commands for toggles
- stronger ambiguity/business-critical detection

## Environment variables

Add these to `.env`:

```bash
AUTOREPLY_TOKEN=<32+ char secret>
AUTOREPLY_PORT=8081
AUTOREPLY_HOST=127.0.0.1
AUTOREPLY_DATA_DIR=./data/autoreply
AUTOREPLY_STYLE_CORPUS_PATH=./data/autoreply/style-corpus.md
AUTOREPLY_DEFAULT_SESSION=main
AUTOREPLY_SECOND_BRAIN_ROOT=/path/to/your/notes
AUTOREPLY_MODEL=sonnet

# Optional: external YouTube-transcript fetcher for link context. Expected to
# accept `<url> --text-only --timestamps` and print the transcript to stdout.
# Unset = YouTube links fall back to a generic page fetch (title/description).
AUTOREPLY_YT_TRANSCRIPT_SCRIPT=

# LLM provider for draft generation - claude-cli (default) | codex-cli | anthropic | openai
# NOTE: these env vars are only the FALLBACK default. Switch at runtime with
#       `npm run autoreply:model -- use <provider> <model>` (writes model-config.json).
# claude-cli: shells out to the local `claude` CLI (uses AUTOREPLY_CLAUDE_BIN / AUTOREPLY_MODEL).
# codex-cli:  shells out to the local `codex` CLI (`codex exec`, uses AUTOREPLY_CODEX_BIN); no API key.
# anthropic:  Anthropic API via the official SDK (key from ANTHROPIC_API_KEY or AUTOREPLY_LLM_API_KEY;
#             model defaults to claude-opus-4-8).
# openai:     ANY OpenAI-compatible chat-completions endpoint - OpenAI (gpt-5), OpenRouter, Groq,
#             Mistral, Ollama, LM Studio... Set AUTOREPLY_LLM_BASE_URL + AUTOREPLY_LLM_MODEL.
AUTOREPLY_LLM_PROVIDER=claude-cli
AUTOREPLY_LLM_API_KEY=
AUTOREPLY_LLM_BASE_URL=
AUTOREPLY_LLM_MODEL=
AUTOREPLY_MIN_CONFIDENCE=0.78
AUTOREPLY_AUTO_SEND_COOLDOWN_MS=600000
AUTOREPLY_ALLOW_GROUP_AUTO=0

# local whatsapp-bridge API
AUTOREPLY_WA_API_BASE=http://127.0.0.1:8080/v1
AUTOREPLY_WA_API_TOKEN=<whatsapp-bridge bearer token>

# draft notification channel - run `npm run autoreply:setup-notify` for a guided setup.
# One of: telegram | slack | whatsapp | webhook. When set, ONLY that channel is used.
# When unset, legacy fallback order applies: webhook -> telegram -> slack -> whatsapp.
AUTOREPLY_NOTIFY_CHANNEL=

# telegram
AUTOREPLY_TELEGRAM_BOT_TOKEN=
AUTOREPLY_TELEGRAM_CHAT_ID=

# slack (either an incoming webhook URL, or bot token + channel id)
AUTOREPLY_SLACK_WEBHOOK_URL=
AUTOREPLY_SLACK_BOT_TOKEN=
AUTOREPLY_SLACK_CHANNEL=

# your own whatsapp number (digits only, no +) - delivered via the bridge itself.
# Replies typed in that chat are ignored by autoreply (loop protection).
AUTOREPLY_NOTIFY_WA_TO=
AUTOREPLY_NOTIFY_WA_SESSION=

# generic webhook
AUTOREPLY_NOTIFY_WEBHOOK_URL=
AUTOREPLY_NOTIFY_WEBHOOK_TOKEN=

# whatsapp-bridge -> autoreply webhook wiring
WEBHOOK_URL=http://127.0.0.1:8081/webhook
WEBHOOK_TOKEN=<same as AUTOREPLY_TOKEN>
```

## Run

Start `whatsapp-bridge` as usual:

```bash
npm run start
```

Start the autoreply service in a second process:

```bash
npm run autoreply
```

## Build the style corpus

```bash
npm run autoreply:build-corpus
# optional overrides
npm run autoreply:build-corpus -- 1500 120
```

This writes the combined WhatsApp + second-brain corpus to the path in `AUTOREPLY_STYLE_CORPUS_PATH`.

## Routes

### `GET /health`
No auth. Returns basic health and current policy.

### `GET /policy`
Bearer auth required.

```bash
curl -H "Authorization: Bearer $AUTOREPLY_TOKEN" http://127.0.0.1:8081/policy
```

### `PUT /policy`
Bearer auth required.

Example: draft mode for all chats

```bash
curl -X PUT \
  -H "Authorization: Bearer $AUTOREPLY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8081/policy \
  -d '{
    "mode": "draft",
    "scope": "all",
    "contacts": [],
    "groups": [],
    "active_until": null,
    "active_hours": null,
    "notes": "default draft mode"
  }'
```

Example: temporary auto mode for one contact

```bash
curl -X PUT \
  -H "Authorization: Bearer $AUTOREPLY_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8081/policy \
  -d '{
    "mode": "auto",
    "scope": "contacts",
    "contacts": ["15551234567@s.whatsapp.net"],
    "groups": [],
    "active_until": "2026-05-15T20:00:00+02:00",
    "active_hours": null,
    "notes": "temporary auto mode"
  }'
```

## Allow / block lists

Two persistent, independent controls decide which chats get an autoreply. They live in `data/autoreply/policy.json` and are read fresh on every inbound message, so changes are live with **no restart**.

- **Blocklist (blacklist)** - `policy.blocklist`. A listed chat **never** gets an autoreply, whatever the mode, scope, or time window. Use it for *"reply to everyone except these"*. Absolute, highest priority.
- **Allowlist (whitelist)** - `policy.contacts` + `policy.groups` under a whitelist `scope` (`contacts` / `groups` / `mixed`). When set, **only** those chats get an autoreply. Use it for *"reply only to these"*.

Entries can be a full JID (`15555550123@s.whatsapp.net`, `123-456@g.us`) or a bare phone / group id - matching is by normalized local part, so `15555550123` matches `15555550123@s.whatsapp.net` (and its device-suffixed variants).

### Managing them from the terminal

```bash
npm run autoreply:acl                          # show mode, scope, both lists
npm run autoreply:acl block add 15555550123    # blacklist a chat (scope stays "all")
npm run autoreply:acl block rm  15555550123
npm run autoreply:acl block clear
npm run autoreply:acl allow add 15555550123    # whitelist a contact -> scope auto-flips to "contacts"
npm run autoreply:acl allow add 123-456@g.us   # whitelist a group  -> scope becomes "mixed"
npm run autoreply:acl allow rm  15555550123
npm run autoreply:acl allow clear              # scope reverts to "all"
npm run autoreply:acl scope all|contacts|groups|mixed   # override the whitelist scope
```

`allow add`/`rm` auto-derive `scope` from the list contents so the whitelist takes effect (and `allow clear` reverts to `all`). `block` never changes scope - a blocklist works in every mode, including `scope: all`. So the two common setups are:

- **Blacklist mode:** `scope: all` + blocklist entries → reply to everyone except the blocked chats.
- **Whitelist mode:** `allow add ...` → reply only to the allowed chats.

Over HTTP, `PUT /policy` accepts a `blocklist` array; omitting it **preserves** the existing blocklist (so `npm run autoreply:off` doesn't wipe it) - pass `[]` to clear explicitly.

### `POST /webhook`
Bearer auth required.

This is the route `whatsapp-bridge` calls for inbound events. It now accepts both real message payloads and `/v1/webhook/test` test pings from the bridge.

## Verification

- `npm run typecheck`
- `POST /v1/webhook/test` through the local bridge API
- inspect:
  - `data/autoreply/audit.ndjson`
  - `data/autoreply/drafts.ndjson`

## Draft-only chats

`draft_only` in the policy is a list of JIDs that may get drafts but never an
auto-send, even when the mode is `auto`. Use it for chats where a wrong promise
in your name is costly. A policy `PUT` that omits the field keeps the existing
list.

## Escalation and operator feedback

Escalation is disabled by default. When enabled, it only reuses the existing
configured private notification channel; it never creates credentials or falls
back to an unconfigured destination. Auto-send safety blocks still persist a
normal draft first. Delivery attempts, failures, and rate-limit decisions are
audited. Configure the local state explicitly (the values are bounded):

```bash
npx tsx -e "import('./src/autoreply-escalation.js').then(m => console.log(m.writeEscalationConfig({enabled:true,cooldown_ms:900000,max_per_hour:12})))"
```

If no notification transport is configured, escalation fails closed to the
ordinary draft/review path. To enable Telegram delivery, configure an existing
Telegram bot token and chat ID via the notification setup flow; this repository
does not provision or store credentials outside `.env`.

Operator corrections are review records only: they do not silently train a
model or update policy. They are bounded to the most recent 500 records and
their text is kept out of the audit log.

```bash
npm run autoreply:feedback -- add 15551234567@s.whatsapp.net "draft text" "operator correction" corrected "optional note"
npm run autoreply:feedback -- list 25
```

## LLM providers

Draft generation goes through `src/autoreply-llm.ts`, which dispatches to one of four backends. The active provider + model are **runtime-switchable** (see below) - the env vars are only the fallback default when no runtime config has been set.

| Provider | What it uses | Needs |
|---|---|---|
| `claude-cli` (default) | the local `claude` CLI | Claude Code installed, no API key |
| `codex-cli` | the local `codex` CLI (`codex exec`) | Codex CLI installed + `codex login`, no API key |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` (or `AUTOREPLY_LLM_API_KEY`); model defaults to `claude-opus-4-8` |
| `openai` | any OpenAI-compatible `/chat/completions` endpoint | model required (e.g. `gpt-5`); `OPENAI_API_KEY` (or `AUTOREPLY_LLM_API_KEY`); `AUTOREPLY_LLM_BASE_URL` (default `https://api.openai.com/v1`); key optional for local endpoints |

### Switching the model from the terminal

The active provider/model live in `data/autoreply/model-config.json` and are read fresh on every draft - **no restart needed** to switch (a restart is only needed to load new *code*).

```bash
npm run autoreply:model                       # show active model + all providers
npm run autoreply:model -- list               # list providers + readiness
npm run autoreply:model -- test openai gpt-5  # connectivity check without switching
npm run autoreply:model -- use openai gpt-5   # switch (gated on a live connectivity check)
npm run autoreply:model -- use codex-cli gpt-5-codex
npm run autoreply:model -- use anthropic claude-opus-4-8 --key sk-ant-...
npm run autoreply:model -- use openai llama3.1 --base-url http://127.0.0.1:11434/v1
```

`use` verifies the provider is authed/reachable **and** the model actually responds before persisting; it refuses to switch to a broken config (override with `--force`). `--key` writes the key into `.env` (chmod 600, gitignored) under the right var name. API keys are never written into `model-config.json`.

### Switching over HTTP

The autoreply server (`:8081`, bearer `AUTOREPLY_TOKEN`) exposes:

- `GET /model` - active config + provider readiness
- `POST /model/test` - `{provider?, model?, base_url?}` → connectivity result (defaults to the active config)
- `PUT /model` - `{provider, model?, base_url?, force?}` → verifies then persists

### Examples

```bash
# GPT-5 via OpenAI
npm run autoreply:model -- use openai gpt-5

# GPT-5 via the Codex CLI (reuses ChatGPT/codex auth, no API key)
npm run autoreply:model -- use codex-cli gpt-5

# OpenRouter
npm run autoreply:model -- use openai anthropic/claude-sonnet-4.6 --base-url https://openrouter.ai/api/v1 --key sk-or-...

# Local Ollama (free, no key)
npm run autoreply:model -- use openai llama3.1 --base-url http://127.0.0.1:11434/v1
```

## Context sources (second brain optional)

Each draft is grounded in two things, and neither requires setup beyond the bridge itself:

1. **Style corpus** - built from your own sent WhatsApp messages
   (`npm run autoreply:build-corpus`). If the corpus file does not exist when the
   first draft is generated, it is auto-built from outbound history. The
   second-brain section of the corpus is optional; without one the corpus is
   WhatsApp-only.
2. **Reference context** - relevant excerpts from **your own WhatsApp history**:
   the recent conversation with that chat plus keyword matches across all stored
   messages (`src/autoreply-context.ts`). No external notes source is required.
3. **Link context** - if the incoming message contains a URL, its content is
   fetched so the draft can react to it (`src/autoreply-link-context.ts`).
   Preview it with `npm run autoreply:link -- "<message or url>"`.

Security note on link context: link URLs come from inbound (untrusted) messages,
so the fetcher **blocks any host that resolves to a private / loopback /
link-local / cloud-metadata address** (SSRF guard), re-validates on each
redirect hop, and caps the response size. Fetched content is wrapped in
`<untrusted>` markers in the prompt and the model is instructed to treat it as
data, never as instructions. YouTube links use `AUTOREPLY_YT_TRANSCRIPT_SCRIPT`
when set, otherwise fall back to the generic page fetch.

## Notification channels

Draft and inbound notifications can go to **Telegram**, **Slack**, **your own
WhatsApp number** (self-chat or a second number, sent through the bridge
itself), or a **generic webhook**. Pick one with the guided wizard:

```bash
npm run autoreply:setup-notify
```

Step-by-step setup guides:

- [sop-notifications-human.md](sop-notifications-human.md) - for a person following along
- [sop-notifications-agent.md](sop-notifications-agent.md) - for an AI agent doing the setup

When `AUTOREPLY_NOTIFY_CHANNEL` is set, only that channel is used. The
WhatsApp channel excludes its own notify chat from autoreply processing so
notifications can never loop back into new drafts.

## Practical rollout recommendation

1. Keep global mode on `draft`
2. Pick a notification channel (`npm run autoreply:setup-notify`) and review generated replies there
3. Enable `auto` only for narrow contact scopes + time windows
4. Leave group auto-send disabled unless you explicitly want it
