# Task pipeline

The autoreply sidecar can turn WhatsApp messages into tasks for a coding agent.
Someone writes "can you send me the March report?", the sidecar spots the task,
asks you for a yes in your own chat, runs an agent, and reports back.

It is off by default. Nothing here runs until you create
`data/autoreply/tasks-config.json` with `"enabled": true`.

## How it works

1. **Detect.** Every inbound message goes through one LLM call (the same
   provider the drafts use) that decides whether it is a task, writes a title,
   a summary and a short plan, and picks a workspace. Group messages count only
   when you are tagged. Voice notes are transcribed first.
2. **Approve.** The sidecar posts the plan to your "message yourself" chat. You
   answer `yes`, `no` or `later`, either as a reply to that message or with the
   task number (`yes 12`). German works too (`ja`, `nein`, `später`).
3. **Run.** An approved task is handed to the agent command with a prompt on
   stdin. The agent's stdout is the result.
4. **Report.** The result lands in your own chat. If the agent suggests an
   answer for the sender, it is sent only to chats in `auto_chats`; for everyone
   else it is shown to you as a suggestion.

Anything you type into your own chat that is not an approval is treated as an
order and runs right away.

Tasks are stored one JSON file each under `data/tasks/`. Every detection, start
and finish is written to `data/autoreply/audit.ndjson`.

## Setup

1. In the bridge `.env`, set `WA_SELF_CHAT_JIDS` to your own chat's JIDs so the
   bridge forwards what you type there. Restart the bridge.
2. Create `data/autoreply/tasks-config.json`:

```json
{
  "enabled": true,
  "operator_name": "Ada",
  "operator_context": "Runs a small agency. Teammates Grace and Alan count as internal.",
  "language": "English",
  "self_jids": ["12025550100@s.whatsapp.net"],
  "auto_chats": [],
  "workspaces": [
    { "id": "home", "label": "Home", "description": "Private errands and everything else.", "cwd": "~" },
    {
      "id": "work",
      "label": "Work",
      "description": "Client projects, CRM, scheduling.",
      "cwd": "~/work",
      "chats": ["12025550101@s.whatsapp.net"]
    }
  ]
}
```

3. Restart the sidecar (`npm run autoreply:restart`). The file is read fresh on
   every message, so later edits need no restart.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `operator_name` | `the operator` | How the prompts refer to you. |
| `operator_context` | empty | Background for the detector and the agent: your role, who counts as internal, tools you use. |
| `language` | `English` | Language for titles, plans and result summaries. |
| `self_jids` | `[]` | Your own chat, in every JID form it appears under. The first entry receives the alerts. |
| `auto_chats` | `[]` | Trusted chats. Their easy, reversible tasks run without asking, and the agent's reply is sent to them. |
| `always_ask_pattern` | deletion, payment, credential words | Regular expression. A match always forces an approval, even in `auto_chats`. |
| `workspaces` | one `default` workspace | See below. The first one is the fallback. |
| `agent_command`, `agent_args` | `claude`, `["-p", "--output-format", "text"]` | The agent that runs on this machine. Any command that reads a prompt on stdin and prints its answer works. |
| `remote_host` | `null` | Optional ssh host. While it answers, tasks run there instead. |
| `remote_agent_command` | `claude -p --output-format text` | Shell command for the agent on `remote_host`. |
| `remote_prelude` | empty | Shell snippet run on `remote_host` first, for example to extend `PATH`. |
| `extra_rules` | `[]` | House rules appended to every task prompt. |
| `max_parallel` | `2` | Tasks running at once (1 to 4). |
| `min_chars` | `12` | Shorter inbound messages are never checked. |
| `run_timeout_min` | `30` | The agent is stopped after this many minutes. |

Each workspace has:

| Key | Meaning |
|---|---|
| `id`, `label` | Short id (lowercase letters, digits, `-`, `_`) and the name shown in alerts. |
| `description` | What kind of work belongs here. The detector uses it to choose. |
| `cwd`, `remote_cwd` | Working directory for the agent here and on `remote_host`. |
| `chats` | Chats whose tasks always belong to this workspace. |
| `runner` | `agent` (default) runs the agent command. `handoff` only writes a job file. |
| `handoff_inbox_dir`, `handoff_outbox_dir` | Required for `handoff`. |

### Handoff workspaces

Use `handoff` when the work needs credentials this process should never hold,
for example a second user account on the same machine. The sidecar writes
`<inbox>/<id>.json` with `{ "id", "prompt", "created_at", "timeout_min" }`. Your
own worker runs the prompt and writes `<outbox>/<id>.json` with
`{ "ok": true, "output": "..." }`. The sidecar picks that up within ten seconds.

## Safety

Read this before you turn it on.

- Message text from other people reaches an agent that can act on your
  machine. Both prompts mark it as third-party data, but that is a mitigation,
  not a guarantee. Keep `auto_chats` to people you would hand your keyboard to.
- Tasks from everyone else wait for your approval, and you see the plan first.
- The default agent arguments run Claude Code with its normal permission
  checks, so an unattended run can do very little. Whatever you add to
  `agent_args` to let it work without prompts (an allowlist, a permission mode)
  is your decision and your risk. Prefer a narrow allowlist.
- The agent is told not to message third parties and not to delete or cancel
  anything the task does not ask for. `always_ask_pattern` is a second net for
  risky words.
- `no <id>` on a running task marks it rejected and drops its result. It does
  not undo work the agent has already done.
