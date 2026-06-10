# Local Messages Assistant

Local-first iMessage assistant prototype using a custom macOS Accessibility bridge plus local Ollama/Gemma decisions. Codex is only used to build and test the system, not as the always-on runtime.

## Current Shape

- Swift helper controls Messages through narrow commands.
- Node orchestrator handles retries, state, idempotency, and send gates.
- Ollama runs `gemma4:12b` locally.
- Local embeddings can run through Ollama for per-chat memory retrieval.
- Draft monitor polls Messages sidebar rows and spends zero model tokens unless a new actionable message appears.
- Local approval API exposes pending context/approval/manual-send work for the future phone app.
- Logs are sanitized by default.

## Requirements

- macOS with Messages signed in.
- Ollama 0.30.7 or newer with `gemma4:12b`.
- Node 18+.
- Xcode command line tools.
- Accessibility permission granted for the terminal/Codex process running `.bin/messages-ax`.

## Build

```bash
./scripts/build-bridge.sh
```

Check permission:

```bash
./.bin/messages-ax permission
```

## Configure Contacts

Copy the example config to a local, gitignored config before adding real contacts:

```bash
cp config/contacts.example.json config/contacts.local.json
```

The app prefers `config/contacts.local.json` when present and falls back to `config/contacts.example.json`.

The example contact slug is `close-family`. If Messages exposes a different search/result label, keep the slug stable, but set these fields to the exact labels Messages shows:

```json
{
  "displayName": "Close Family",
  "searchName": "Exact search text to type",
  "resultName": "Exact conversation result label to click",
  "conversationTitle": "Exact title shown after opening",
  "titleAliases": ["Any alternate visible title"]
}
```

If Messages shows phone numbers instead of contact names, keep auto-send off and add
the phone-number title as a local alias. First inspect the visible sidebar with
numbers masked:

```bash
node scripts/list-sidebar.mjs --activate
```

Then promote the row into `config/contacts.local.json`:

```bash
node scripts/promote-sidebar-contact.mjs close-family \
  --display-name "Close Family" \
  --title "+1 555 123 4567" \
  --phone "+1 555 123 4567"
```

This updates only the gitignored local config, stores the normalized phone under
`identity.phoneNumbers`, and leaves `autoSend: false`.

Install a normal user-local Node runtime if the Mac does not have one:

```bash
./scripts/setup-node.sh
```

That installs the pinned Node build under `~/.local/opt` and links `node`, `npm`,
and `npx` into `~/.local/bin`.

## Safe Tests

Mock Gemma test, no Messages access:

```bash
node scripts/test-decision.mjs close-family
```

Read-only real Messages dry-run:

```bash
node src/run-contact-poc.mjs close-family dry-run
```

This writes sanitized run records under `data/runs/`.

## Legacy Contact Daemon

Older configured-contact dry-run path:

```bash
DAEMON_MODE=dry-run node src/daemon.mjs
```

Legacy health:

```bash
curl http://127.0.0.1:8790/health
```

A launchd example is in `launchd/com.local.messages-assistant.plist.example`.

## Draft Monitor MVP

This watches new Messages sidebar rows and drafts replies locally:

```bash
SINCE_LOCAL=1:13pm ./scripts/start-draft-monitor.sh
```

It watches visible Messages sidebar rows newer than the cutoff, opens candidate conversations, checks that the latest visible bubble is incoming, asks Gemma for a draft, asks Gemma again whether that draft is safe to auto-send, then appends to:

```text
~/Desktop/messages-ai-drafts.txt
```

Each entry includes:

- `Conversation:`
- recent visible transcript
- `AI reply:`
- draft reason, risk decision, approval queue ID when applicable, and token usage

Contacts with `autoSend: true` can send replies only when the risk pass returns `auto_send` and every deterministic gate still passes. Plans, commitments, missing personal preference, money, contracts, health, credentials, conflict, and stale/unverified UI state are queued instead of sent. Every other conversation writes drafts only unless the contact has `approvalQueue: true`.

The monitor first tries to read/open Messages through Accessibility without activating Messages, and only falls back to foreground UI control when macOS will not open a candidate row in the background.

On startup it also creates both Desktop tracking files:

```text
~/Desktop/messages-ai-drafts.txt
~/Desktop/messages-ai-shadow-replies.txt
```

The shadow file is written by the same production monitor when it observes your
outgoing reply after an incoming batch. The AI draft is generated from the
incoming messages before your reply is included, then the file records the
recipient messages, your observed reply, and what the AI would have replied.
If Messages is running without a usable main window, the monitor attempts to
re-open the Messages app before the next sidebar sweep.

If the Messages sidebar shows a new preview but the visible transcript still
exposes an already-processed latest bubble, the monitor writes an
`unverified_ui_state` entry and creates an approval queue record instead of
silently skipping it.

For live sends, the draft monitor requires all of these:

- contact `autoSend: true`
- config `settings.allowSend: true`
- environment `ALLOW_SEND=1`
- Gemma risk classifier returns `auto_send`
- deterministic risk veto does not match plans, commitments, money, private data, or other high-risk topics
- the visible latest bubble fingerprint is unchanged immediately before send

One-shot validation:

```bash
SINCE_LOCAL=1:13pm node src/draft-monitor.mjs --once
```

Use a future cutoff for a no-action startup test:

```bash
SINCE_LOCAL=11:59pm node src/draft-monitor.mjs --once
```

Production background start with a supervised `screen` session:

```bash
./scripts/start-monitor-background.sh
```

That script:

- rebuilds the Accessibility bridge
- checks Accessibility trust
- checks Ollama and `gemma4:12b`
- runs a configured style/policy draft check when examples are available
- starts `src/draft-monitor.mjs` under `screen`
- writes service logs to `data/draft-monitor.service.log`
- restarts the monitor if it exits

The monitor also writes a compact health snapshot for the local API:

```text
data/draft-monitor-health.json
```

Stop it with:

```bash
./scripts/stop-monitor-background.sh
```

## Approval Queue API

`server.mjs` exposes the local approval/control surface that the future phone
app can call. It binds to `127.0.0.1` by default:

```bash
node server.mjs
curl http://127.0.0.1:8787/health
```

Use a token before binding it to the LAN:

```bash
BRIDGE_TOKEN="$(openssl rand -hex 24)" HOST=0.0.0.0 node server.mjs
```

Endpoints:

- `GET /health`: monitor heartbeat, approval counts, recent draft metadata.
- `GET /approvals?status=open`: pending approval/context/UI-state items.
- `GET /approvals/:id`: full approval request.
- `POST /approvals/:id/approve`: approve exact text and send by default.
- `POST /approvals/:id/reject`: reject a queued item.
- `POST /approvals/:id/context`: attach user context without sending.
- `POST /send`: create a manual-send approval; add `"confirm": true` to send exact text immediately.

Approved sends still require `settings.allowSend: true`, `ALLOW_SEND=1`, and a
configured contact slug. Unknown/sidebar-only conversations are never sent by
the API until promoted into config.

## Shadow Compare Monitor

To evaluate reply quality without auto-send, run the shadow monitor by itself.
It drafts from the incoming batch before your outgoing reply and writes
comparisons to `~/Desktop/messages-ai-shadow-replies.txt`:

```bash
SINCE_LOCAL=1:13pm ./scripts/start-shadow-monitor.sh
```

It logs:

- recipient messages
- your reply, once observed
- what the AI would have replied

This monitor never sends messages. Use it alongside manual texting or before
enabling broader auto-reply behavior.

## Conversation Memory

The assistant keeps a local SQLite memory DB at:

```text
data/memory.sqlite3
```

This DB is local and gitignored. It stores visible UI transcripts, extracted style examples, compact per-conversation profiles, and draft/send records. It does not read `chat.db`.

Build or refresh a profile for a configured contact:

```bash
node scripts/profile-conversation.mjs close-family
```

That command:

- opens the configured conversation, preferring background Accessibility operations
- ingests the currently visible Messages transcript
- extracts examples of `incoming batch -> your outgoing reply`
- asks Gemma to build a compact per-conversation profile
- stores the profile and examples in `data/memory.sqlite3`

Skip the Gemma profile refresh and only ingest visible messages:

```bash
node scripts/profile-conversation.mjs close-family --no-refresh
```

For a deeper initial profile, scroll through the Messages transcript and ingest more history:

```bash
node scripts/ingest-history.mjs close-family --limit 100 --max-pages 35
```

That command opens the configured conversation, walks older visible pages through Accessibility, stores up to the requested message limit in SQLite, extracts reply examples, and asks Gemma to synthesize the compact profile from that larger local evidence set. It still does not read `chat.db`.

The profile builder passes Gemma bounded evidence, not the entire raw database:

- up to 100 recent usable messages by default
- up to 20 extracted incoming-to-user-reply examples by default
- configured positive and negative style guardrails
- local writing stats such as reply length, capitalization, punctuation, and emoji rates

If Gemma returns malformed JSON or takes too long, the builder retries with smaller evidence windows and has a profile timeout. Override with environment variables such as `PROFILE_COMPACT_MESSAGES`, `PROFILE_COMPACT_EXAMPLES`, `PROFILE_NUM_CTX`, `PROFILE_NUM_PREDICT`, and `PROFILE_OLLAMA_TIMEOUT_MS`.

Future live drafts receive:

- the current incoming batch since your last outgoing message
- the recent visible transcript
- the compact per-conversation profile
- a few examples of how you have replied in that specific conversation
- a few relevant indexed memory notes when local embeddings are available

Thin evidence is confidence-capped locally, so a small or test-heavy transcript cannot mark itself as high-confidence just because the model says so.

## Deep Memory Index

The deeper memory layer is local-first:

- recent visible messages are stored in `data/memory.sqlite3`
- messages are chunked into small conversation windows
- each chunk can be embedded locally with Ollama
- Gemma extracts durable notes from each chunk
- Gemma refreshes the compact conversation profile using chunk notes plus recent examples

Install the default lightweight embedding model:

```bash
./scripts/setup-embedding-model.sh
```

Build a 300-message memory index for one configured contact:

```bash
node scripts/build-memory-index.mjs close-family --limit 300
```

If you want the script to scroll Messages first and ingest more history:

```bash
node scripts/build-memory-index.mjs close-family --ingest --limit 300 --max-pages 70
```

Build for every enabled configured contact:

```bash
node scripts/build-memory-index.mjs --all-configured --limit 300
```

Useful lower-risk test modes:

```bash
node scripts/build-memory-index.mjs close-family --status
node scripts/build-memory-index.mjs close-family --skip-embeddings --skip-summaries --no-refresh
```

The default embedding model is `nomic-embed-text`, chosen because it is small
enough for the M1 Mac mini. Override with `EMBEDDING_MODEL=bge-m3` or
`--embedding-model bge-m3` after pulling that model if you want richer retrieval.

Live drafting uses indexed memory opportunistically. If the embedding model is
missing or busy, the monitor falls back to the existing profile/examples path
instead of failing.

## Mac Dashboard

The local approval API also serves a lightweight dashboard:

```bash
node server.mjs
open http://127.0.0.1:8787/dashboard
```

The dashboard shows:

- monitor health
- open approvals
- per-conversation message/chunk/profile progress
- the current compact profile
- recent memory chunk notes

It can start a background memory indexing job for a configured contact. Binding
the API to the LAN for phone access should use `BRIDGE_TOKEN`.

The example contact has a stricter style policy in config:

- no dash characters in auto-send replies
- no known AI-sounding phrases from failed tests
- no excluded assistant-generated replies as style examples
- curated `writeLikeThis` and `doNotWriteLikeThis` contrastive examples
- max auto-send length
- lower max auto-send length while the profile confidence is low

If Gemma violates the style policy, it retries with the exact violation. If it still cannot produce a compliant reply, the monitor writes the draft decision to the Desktop file and does not send.

The contrastive examples are deliberately separated:

- Positive examples: short, approved patterns the model may imitate.
- Negative examples: bad assistant-style replies plus `whyBad` labels. These are explicitly marked as forbidden in the prompt.

For each contact, tune these in `config/contacts.example.json` under `styleExamples`. The default limits are up to 10 positive and 10 negative examples per live prompt.

## Identity Extraction

Conversation matching starts with configured aliases, then uses local identity evidence. To extract identity evidence from the Messages details/contact UI:

```bash
node scripts/extract-identity.mjs close-family
```

That command opens the configured contact, presses the Messages conversation header/details control, extracts visible candidate names, phone numbers, emails, and UI titles, and stores them in `identity_evidence` inside `data/memory.sqlite3`.

Phone numbers are masked in command output, but the normalized value is stored locally so a future sidebar row shown as a phone number can still map back to the configured contact slug. This does not enable direct AppleScript sends by itself; direct sending still requires an explicitly configured `directSend.handle`.

## Send Gates

Live sending is blocked unless all are true:

- Config has `allowSend: true`.
- Environment has `ALLOW_SEND=1`.
- The latest visible message is new and incoming.
- The configured contact has `autoSend: true`, or the exact reply was explicitly approved through the approval API.
- Gemma drafts a sendable reply.
- Gemma's risk classifier returns `auto_send` for automatic sends.
- The deterministic risk veto does not match plans, commitments, money, legal/medical, credentials, conflict, private data, or missing user preference.
- The bridge re-opens and re-reads the conversation immediately before sending.
- The latest-message fingerprint has not changed.

Manual API sends are exact-text only and require a configured contact slug.

## Token Controls

Useful environment variables:

```bash
GEMMA_MODEL=gemma4:12b
MAX_VISIBLE_MESSAGES=12
MAX_MESSAGE_CHARS=1200
POLL_INTERVAL_MS=5000
LOG_RAW_MESSAGES=0
```

The mock decision reports local model token usage in its output.

## What Still Needs Soak Testing

- Leave `src/draft-monitor.mjs` running for several hours and confirm every new sidebar message after the cutoff creates exactly one Desktop entry.
- Send test messages from at least two different people, including one while Messages is focused and one while it is in the background.
- Confirm group chats and phone-number-only senders open from sidebar titles.
- Confirm no duplicate Desktop entries after repeated polls.
- Confirm Gemma drafts are acceptable enough before any future approval/send feature.
