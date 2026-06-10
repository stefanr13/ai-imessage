#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fallbackContactForSidebar, findSidebarContact, visibleTitleMatchesSidebar } from "./contact-utils.mjs";
import { loadConfig } from "./config.mjs";
import { DEFAULT_MODEL, draftReply } from "./decision.mjs";
import { findConversationSlugByIdentityValue, getMemoryContext, ingestVisibleConversation } from "./memory-store.mjs";
import { assertOllamaModelAvailable, getOllamaVersion } from "./ollama-client.mjs";
import { messagesAx } from "./messages-ax.mjs";
import { parseSidebarTimeToday, splitSidebarDescription } from "./sidebar.mjs";
import { stableHash } from "./transcript.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const statePath = process.env.SHADOW_MONITOR_STATE || path.join(repoRoot, "data", "shadow-monitor-state.json");
const outputPath =
  process.env.SHADOW_MONITOR_OUTPUT || path.join(os.homedir(), "Desktop", "messages-ai-shadow-replies.txt");
const pollIntervalMs = Number(process.env.SHADOW_MONITOR_POLL_MS || 5000);
const idleLogEveryCycles = Number(process.env.SHADOW_MONITOR_IDLE_LOG_EVERY_CYCLES || 60);

function usage() {
  console.log(`Usage: node src/shadow-monitor.mjs [--once]

Watches Messages sidebar rows and writes a Desktop comparison log:
recipient messages, the user's actual reply when observed, and the AI reply drafted
without seeing the user's actual reply.

This monitor never sends messages.

Environment:
  SINCE_LOCAL=1:13pm
  SINCE_ISO=2026-06-10T19:13:00Z
  SHADOW_MONITOR_OUTPUT=~/Desktop/messages-ai-shadow-replies.txt
  SHADOW_MONITOR_POLL_MS=5000
`);
}

function todayAtLocalTime(hour, minute) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

function parseSince() {
  if (process.env.SINCE_ISO) return new Date(process.env.SINCE_ISO);
  if (process.env.SINCE_LOCAL) {
    const match = process.env.SINCE_LOCAL.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
    if (!match) throw new Error("SINCE_LOCAL must look like 13:13 or 1:13pm.");
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const meridian = match[3]?.toLowerCase();
    if (meridian === "pm" && hour < 12) hour += 12;
    if (meridian === "am" && hour === 12) hour = 0;
    return todayAtLocalTime(hour, minute);
  }
  return todayAtLocalTime(0, 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, processed: {}, pending: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, statePath);
}

function compactMessages(messages) {
  return (messages || [])
    .map((message) => ({
      direction: message.direction,
      text: String(message.text || "").trim(),
    }))
    .filter((message) => message.text);
}

function findTurnForShadow(visible) {
  const messages = compactMessages(visible.messages);
  if (!messages.length) return null;

  const lastNonEmptyIndex = messages.length - 1;
  const latest = messages[lastNonEmptyIndex];

  if (latest.direction === "incoming") {
    const previousOutgoing = messages.findLastIndex((message) => message.direction === "outgoing");
    const incoming = messages
      .slice(previousOutgoing + 1)
      .filter((message) => message.direction === "incoming" && message.text);
    if (!incoming.length) return null;
    const batchHash = stableHash({
      title: visible.conversationTitle || null,
      incoming: incoming.map((message) => message.text.toLowerCase()),
    });
    return {
      mode: "pending",
      batchHash,
      eventHash: stableHash({ batchHash, mode: "pending" }),
      incoming,
      actualReplies: [],
      draftVisible: {
        ...visible,
        messages,
      },
    };
  }

  if (latest.direction !== "outgoing") return null;

  let firstTrailingOutgoing = lastNonEmptyIndex;
  while (firstTrailingOutgoing > 0 && messages[firstTrailingOutgoing - 1]?.direction === "outgoing") {
    firstTrailingOutgoing -= 1;
  }
  const previousOutgoing = messages
    .slice(0, firstTrailingOutgoing)
    .findLastIndex((message) => message.direction === "outgoing");
  const incoming = messages
    .slice(previousOutgoing + 1, firstTrailingOutgoing)
    .filter((message) => message.direction === "incoming" && message.text);
  const actualReplies = messages
    .slice(firstTrailingOutgoing)
    .filter((message) => message.direction === "outgoing" && message.text);

  if (!incoming.length || !actualReplies.length) return null;
  const batchHash = stableHash({
    title: visible.conversationTitle || null,
    incoming: incoming.map((message) => message.text.toLowerCase()),
  });
  return {
    mode: "compared",
    batchHash,
    eventHash: stableHash({
      batchHash,
      actualReplies: actualReplies.map((message) => message.text.toLowerCase()),
      mode: "compared",
    }),
    incoming,
    actualReplies,
    draftVisible: {
      ...visible,
      messages: messages.slice(0, firstTrailingOutgoing),
    },
  };
}

async function openAndReadSidebarItem(item, sidebar) {
  const backgroundOpen = await messagesAx.openSidebar(item.description, { background: true });
  if (backgroundOpen.ok) {
    const visible = await messagesAx.readVisible();
    if (visible.ok && visibleTitleMatchesSidebar(visible, sidebar)) {
      return { opened: backgroundOpen, visible };
    }
  }

  const foregroundOpen = await messagesAx.openSidebar(item.description);
  if (!foregroundOpen.ok) return { opened: foregroundOpen, visible: null };
  const visible = await messagesAx.readVisible();
  return { opened: foregroundOpen, visible };
}

async function resolveSidebarConversation(config, sidebar) {
  const configured = findSidebarContact(config, sidebar);
  if (configured) return configured;

  const identityMatch = await findConversationSlugByIdentityValue({ value: sidebar.title });
  if (identityMatch?.conversation_slug && config.contacts?.[identityMatch.conversation_slug]) {
    return {
      slug: identityMatch.conversation_slug,
      contact: config.contacts[identityMatch.conversation_slug],
      identityMatch,
    };
  }

  return fallbackContactForSidebar(sidebar);
}

function formatLines(messages, fallbackSpeaker) {
  return messages.map((message) => `${message.direction === "outgoing" ? "Me" : fallbackSpeaker}: ${message.text}`);
}

async function appendShadowLog({ since, sidebar, visible, turn, draft, action }) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const speaker = visible.conversationTitle || sidebar.title || "Them";
  const block = [
    "",
    "============================================================",
    `Detected: ${new Date().toLocaleString()}`,
    `Monitor since: ${since.toLocaleString()}`,
    `Conversation: ${speaker}`,
    `Sidebar time: ${sidebar.timeLabel}`,
    `Action: ${action}`,
    "",
    "Recipient messages:",
    ...formatLines(turn.incoming, speaker),
    "",
    "My reply:",
    turn.actualReplies.length ? formatLines(turn.actualReplies, speaker).join("\n") : "(not observed yet)",
    "",
    "AI would have replied:",
    draft.draft.shouldReply ? draft.draft.replyText : "(no reply)",
    `AI reason: ${draft.draft.reason}`,
    `Model: ${draft.model || DEFAULT_MODEL}`,
    `Tokens: prompt ${draft.usage.promptTokens}, output ${draft.usage.outputTokens}, total ${draft.usage.totalTokens}`,
    `Batch fingerprint: ${turn.batchHash}`,
    "",
  ].join("\n");
  await appendFile(outputPath, block);
}

async function processSidebarItem({ config, item, since, state, now }) {
  const sidebar = splitSidebarDescription(item.description);
  if (!sidebar) return { processed: false, reason: "unparseable-sidebar" };
  const sidebarTime = parseSidebarTimeToday(sidebar.timeLabel, now);
  if (!sidebarTime || sidebarTime < since) return { processed: false, reason: "before-since" };

  const { opened, visible } = await openAndReadSidebarItem(item, sidebar);
  if (!opened.ok) return { processed: false, reason: `open-failed: ${opened.message}` };
  if (!visible?.ok) return { processed: false, reason: "read-failed" };

  const turn = findTurnForShadow(visible);
  if (!turn) return { processed: false, reason: "no-shadow-turn" };
  if (state.processed[turn.eventHash]) return { processed: false, reason: "already-processed" };

  await getOllamaVersion();
  await assertOllamaModelAvailable(DEFAULT_MODEL);
  const { slug, contact } = await resolveSidebarConversation(config, sidebar);
  await ingestVisibleConversation({
    slug,
    contact,
    visible,
    sidebarTitle: sidebar.title,
    source: "shadow-monitor",
  });

  let draft = state.pending[turn.batchHash]?.draft || null;
  let action = turn.mode === "pending" ? "pending-draft" : "compared";
  if (!draft) {
    const memoryContext = await getMemoryContext({ slug, contact });
    draft = await draftReply({ visible: turn.draftVisible, contact, memoryContext });
  }

  if (turn.mode === "pending") {
    state.pending[turn.batchHash] = {
      at: new Date().toISOString(),
      draft,
      sidebar,
    };
  } else {
    delete state.pending[turn.batchHash];
  }

  await appendShadowLog({ since, sidebar, visible, turn, draft, action });
  state.processed[turn.eventHash] = {
    at: new Date().toISOString(),
    action,
    sidebar,
    output: outputPath,
    usage: draft.usage,
  };
  return { processed: true, title: sidebar.title, action, usage: draft.usage };
}

async function runCycle({ config, since, state }) {
  const now = new Date();
  let list = await messagesAx.listConversations();
  if (!list.ok) list = await messagesAx.listConversations({ activate: true });
  if (!list.ok) {
    return [{ processed: false, reason: "list-conversations-failed", trusted: list.trusted }];
  }

  const results = [];
  for (const item of list.items || []) {
    results.push(await processSidebarItem({ config, item, since, state, now }));
  }
  await saveState(state);
  return results;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const once = process.argv.includes("--once");
  const since = parseSince();
  const config = await loadConfig();
  const state = await loadState();

  console.log(`Shadow monitor since: ${since.toLocaleString()}`);
  console.log(`Writing comparisons to: ${outputPath}`);
  console.log("Mode: shadow compare only; this monitor never sends messages.");

  let idleCycles = 0;
  while (true) {
    const results = await runCycle({ config, since, state });
    const processed = results.filter((result) => result.processed);
    if (processed.length) {
      idleCycles = 0;
      console.log(JSON.stringify({ at: new Date().toISOString(), processed }, null, 2));
    } else {
      idleCycles += 1;
      const listFailure = results.find((result) => result.reason === "list-conversations-failed");
      if (listFailure && (idleCycles === 1 || idleCycles % idleLogEveryCycles === 0)) {
        console.error(JSON.stringify({ at: new Date().toISOString(), ...listFailure }, null, 2));
      }
      if (idleLogEveryCycles > 0 && idleCycles % idleLogEveryCycles === 0) {
        console.log(JSON.stringify({ at: new Date().toISOString(), processed: 0, idleCycles }, null, 2));
      }
    }
    if (once) break;
    await sleep(pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
