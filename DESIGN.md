# Local-First Messages Assistant Design

Goal: run the production assistant locally, using a local open model for reasoning and a custom macOS bridge for Messages UI control. Codex remains the builder/tester, not the always-on runtime.

## Runtime Architecture

```text
Mac bridge daemon (Node)
  -> Event hints: AX sidebar sweep, notification hints, optional iPhone Shortcut wake-ups
  -> Swift Accessibility helper controls Messages through narrow commands
  -> Message parser extracts structured visible text
  -> Cheap deterministic policy filters no-op and exact-rule cases
  -> Ollama/Gemma 4 12B drafts from compact context
  -> Ollama/Gemma 4 12B classifies auto-send risk
  -> Local embedding memory retrieves relevant per-chat notes when indexed
  -> SQLite approval queue records needs_approval | needs_context | unverified_ui_state
  -> Send gate verifies target conversation and exact allowed reply
  -> Local approval API exposes pending requests for a future phone app
  -> Local dashboard shows profiles, indexing progress, approvals, and health
  -> Local logs capture prompts, decisions, token counts, timings, and actions
  -> Phone app later handles approval, clarification, and manual overrides
```

## Production Reliability Layer

The production path now has these constraints:

- A single daemon process guarded by a local lock directory.
- Per-contact state in `data/assistant-state.json`.
- First-run baselining so old visible messages are recorded but not acted on.
- Latest-message fingerprints so repeated polling does not reprocess the same bubble.
- Model calls only when policy says the latest new message can potentially need a draft or approval decision.
- Sanitized run logs by default; raw message text is only written when `LOG_RAW_MESSAGES=1`.
- Re-open and re-read immediately before any send, then abort if the latest-message fingerprint changed.
- Live sends require config `allowSend: true`, `ALLOW_SEND=1`, either contact `autoSend: true` or explicit API approval, and a final UI re-read.
- Legacy contact-daemon health runs on `127.0.0.1:8790`; the approval API defaults to `127.0.0.1:8787`.
- Draft monitor health is written to `data/draft-monitor-health.json`.
- If the sidebar shows a newer preview that cannot be verified in the visible transcript, it is logged as `unverified_ui_state` instead of being discarded.
- Deep memory indexing runs as an offline/background job, not in the live send path.

## Why This Shape

- Avoids `chat.db` and private database reads.
- Avoids paying Codex tokens for every background poll.
- Uses macOS Accessibility for deterministic UI primitives instead of full-screen visual reasoning by default.
- Uses Gemma 4 12B for local reasoning/drafting and records actual `prompt_eval_count` / `eval_count` from Ollama responses.
- Keeps screenshot/multimodal analysis as a fallback for broken AX parsing, not the primary loop.

## Control Boundary

Gemma does not directly click, type, or send. The model only returns JSON:

```json
{
  "action": "reply",
  "replyText": "Thanks",
  "matchedRule": "testing-poc",
  "reason": "Latest incoming message exactly matched configured rule."
}
```

The local policy layer decides whether model JSON is actionable. Drafting and
risk classification are separate model calls; deterministic safety rules can
veto the model's auto-send classification. The bridge exposes narrow commands:

- `permission`
- `open <conversation-name>`
- `read-visible`
- `send <text>`
- `snapshot`

For any send, the orchestrator must re-open the configured conversation, read it, verify the visible title/latest incoming message, verify the model decision against deterministic policy or user approval, then send the exact allowed text.

## Safety Policy

The bridge should only send when all are true:

- The active conversation identity matches the configured contact.
- The latest incoming message satisfies a specific rule or user approval.
- The proposed reply exactly matches the allowed rule or approved text.
- No high-risk topic is detected: money, health, legal, credentials, conflict, commitments, romance/sex, identity/security, or irreversible actions.

Everything else becomes `ask_user` or `ignore`.

## Token Policy

Most background cycles should spend zero model tokens:

- Poll/listen for event hints without Gemma.
- Parse UI text locally.
- Drop unchanged conversations through hashes of visible latest messages.
- Call Gemma only when a target conversation has a new candidate incoming message.
- Limit each Gemma prompt to the last `MAX_VISIBLE_MESSAGES` messages and `MAX_MESSAGE_CHARS` per message.
- Log every Ollama response with `prompt_eval_count`, `eval_count`, and prompt character count.

Tone learning should store compact local summaries, not raw long transcripts. Keep a global style profile plus per-chat profile:

- Global profile: default texting tone, punctuation, emoji habits, brevity.
- Per-chat profile: relationship-specific tone and recurring context.

The implemented local memory layer uses `data/memory.sqlite3` rather than `chat.db`. It stores:

- `conversations`: configured and discovered sidebar conversations.
- `messages`: visible Messages UI text observed through Accessibility.
- `style_examples`: extracted batches of incoming messages followed by the user's outgoing reply.
- `conversation_profiles`: compact Gemma-built per-chat style profiles.
- `drafts`: proposed replies, token usage, and send status.
- `approval_requests`: queued approval/context/manual-send/UI-state items.
- `memory_index_jobs`: background indexing progress.
- `memory_chunks`: chunk text, Gemma notes, local embedding vectors, and timing metadata.
- `identity_evidence`: observed names, UI titles, phone numbers, and emails from the Messages details/contact UI.

Initial profile building can use a deeper visible transcript than live drafting. The history ingester scrolls the Messages UI through Accessibility, stores observed bubbles in SQLite, extracts incoming-batch-to-user-reply examples, and asks Gemma to synthesize a compact per-chat profile. The profile prompt is bounded with retry windows and a timeout, and includes deterministic local style stats so Gemma does not overgeneralize casing, punctuation, emoji use, or reply length.

Live drafting should not dump long raw transcripts into Gemma. It should pass the current incoming batch, a bounded recent visible transcript, the compact profile, and a small number of high-signal style examples. Profile confidence is capped by local evidence counts so a profile built from thin data cannot be treated as mature.

For deeper learning, the memory indexer can process about 300 recent messages per
configured contact offline. It chunks the stored transcript, embeds chunks with a
local Ollama embedding model, asks Gemma for durable notes per chunk, then asks
Gemma to refresh the compact profile from those notes plus recent examples.
Live drafting retrieves only the top few relevant memory notes, so the runtime
prompt stays lean and old logistics are not treated as current facts.

Identity matching order is:

1. Explicit configured aliases in `config/contacts.example.json`.
2. Stored identity evidence from `data/memory.sqlite3`, including normalized phone numbers and emails.
3. Draft-only fallback slugs derived from the sidebar title.

Only configured contacts can auto-send. Discovered fallback identities remain draft-only until promoted into config.

## Reliability Notes

No public iMessage API means no perfect API-grade listener. The best local design is a hybrid:

- AX sidebar sweep every few seconds to find unread/recent rows.
- macOS notification and iPhone Shortcut events as wake-up hints, not sole truth.
- Open candidate conversations and read visible latest bubbles as the source of action.
- Watchdog process restarts the bridge, keeps the Mac awake, and records failures.
- Manual approval path for ambiguous or sensitive messages.

This can be good enough for a dedicated Mac mini, but it needs soak testing before trusting broad auto-replies.

## Approval Control Surface

The production control path is:

```text
monitor -> approval_requests row -> local approval API -> phone app later -> exact approved text -> Mac sender
```

The API defaults to localhost. LAN binding must use `BRIDGE_TOKEN` unless
explicitly overridden for testing. Approval endpoints can approve, reject, add
context, or create a manual-send request. Sending approved text still requires
global send gates and a configured contact slug; discovered fallback/sidebar
contacts remain non-sending until promoted into config.

The same local server serves the Mac dashboard at `/dashboard`. The dashboard is
intentionally lightweight: it reads health, open approvals, memory index status,
the current compact profile, and recent chunk notes. It can start a background
index job for a configured contact, but it does not send messages by itself.

## Current POC

1. Open the configured Messages conversation through Accessibility.
2. Read visible messages into structured JSON.
3. Baseline or fingerprint the latest visible message.
4. Apply deterministic policy.
5. Ask Gemma for a draft when a new incoming candidate is visible.
6. Ask Gemma whether the proposed draft is safe to auto-send.
7. Queue ambiguous, high-risk, context-missing, or unverified UI cases.
8. Send only if every send gate passes.
9. Log model token counts, decisions, and sanitized message metadata.

## Draft Monitor MVP

`src/draft-monitor.mjs` is the current safest end-to-end MVP:

- It auto-sends only for contacts with `autoSend: true` in config. Other conversations write drafts only.
- It clears Messages search and sweeps visible sidebar summaries.
- It filters rows to messages newer than a local cutoff, defaulting to `1:13pm` today.
- It opens candidate conversations and requires the latest visible bubble to be incoming.
- It ingests the visible transcript into local conversation memory.
- It asks Gemma for a draft reply using current context plus memory.
- It asks Gemma whether the draft is low-consequence enough to auto-send.
- It queues approval/context/UI-state items in SQLite for future mobile handling.
- It appends the visible conversation, `AI reply:`, action, and token usage to `~/Desktop/messages-ai-drafts.txt`.

This validates the two highest-risk assumptions before enabling any active behavior: new-message detection and reply quality.
