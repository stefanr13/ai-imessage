#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fallbackContactForSidebar, findSidebarContact, visibleTitleMatchesSidebar } from "./contact-utils.mjs";
import { loadConfig } from "./config.mjs";
import { DEFAULT_MODEL, classifyReplyRisk, draftReply } from "./decision.mjs";
import {
  countApprovalRequests,
  createApprovalRequest,
  findConversationSlugByIdentityValue,
  ingestVisibleConversation,
  getMemoryContext,
  recordDraftMemory,
} from "./memory-store.mjs";
import { assertOllamaModelAvailable, getOllamaVersion } from "./ollama-client.mjs";
import { messagesAx } from "./messages-ax.mjs";
import { parseSidebarTimeToday, splitSidebarDescription } from "./sidebar.mjs";
import { acquireLock } from "./state-store.mjs";
import { latestVisibleMessage, messageFingerprint, stableHash } from "./transcript.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const statePath = process.env.DRAFT_MONITOR_STATE || path.join(repoRoot, "data", "draft-monitor-state.json");
const desktopPath =
  process.env.DRAFT_MONITOR_OUTPUT || path.join(os.homedir(), "Desktop", "messages-ai-drafts.txt");
const shadowDesktopPath =
  process.env.SHADOW_MONITOR_OUTPUT || path.join(os.homedir(), "Desktop", "messages-ai-shadow-replies.txt");
const healthPath =
  process.env.DRAFT_MONITOR_HEALTH || path.join(repoRoot, "data", "draft-monitor-health.json");
const pollIntervalMs = Number(process.env.DRAFT_MONITOR_POLL_MS || 5000);
const idleLogEveryCycles = Number(process.env.DRAFT_MONITOR_IDLE_LOG_EVERY_CYCLES || 60);

function usage() {
  console.log(`Usage: node src/draft-monitor.mjs [--once]

Watches Messages sidebar rows newer than SINCE_LOCAL or SINCE_ISO and writes draft
decisions to the Desktop log. Contacts only send when their local config explicitly
enables autoSend and the deterministic send gates pass.

Environment:
  SINCE_LOCAL=1:13pm
  SINCE_ISO=2026-06-10T19:13:00Z
  DRAFT_MONITOR_OUTPUT=~/Desktop/messages-ai-drafts.txt
  DRAFT_MONITOR_POLL_MS=5000
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
  return todayAtLocalTime(13, 13);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000 }, (error) => resolve({ ok: !error, error }));
  });
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, processed: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, statePath);
}

function isIncomingLatest(visible) {
  const latest = latestVisibleMessage(visible);
  return latest?.direction === "incoming";
}

function formatConversation(visible, maxMessages = 12) {
  return (visible.messages || [])
    .slice(-maxMessages)
    .map((message) => {
      const speaker = message.direction === "outgoing" ? "Me" : visible.conversationTitle || "Them";
      return `${speaker}: ${String(message.text || "").trim()}`;
    })
    .join("\n");
}

async function appendStartupNotice({ since }) {
  const at = new Date().toLocaleString();
  for (const [filePath, label] of [
    [desktopPath, "Draft/auto-reply monitor"],
    [shadowDesktopPath, "Shadow training comparison monitor"],
  ]) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(
      filePath,
      [
        "",
        "============================================================",
        `${label} started: ${at}`,
        `Monitor since: ${since.toLocaleString()}`,
        "",
      ].join("\n")
    );
  }
}

async function appendDraft({
  since,
  sidebar,
  visible,
  latestHash,
  draft,
  riskResult = null,
  approvalRequest = null,
  action = "drafted",
  sendResult = null,
}) {
  await mkdir(path.dirname(desktopPath), { recursive: true });
  const block = [
    "",
    "============================================================",
    `Detected: ${new Date().toLocaleString()}`,
    `Monitor since: ${since.toLocaleString()}`,
    `Conversation: ${visible.conversationTitle || sidebar.title}`,
    `Sidebar time: ${sidebar.timeLabel}`,
    "",
    "Conversation:",
    formatConversation(visible),
    "",
    `AI reply: ${draft.draft.shouldReply ? draft.draft.replyText : "(ask me first)"}`,
    `Reason: ${draft.draft.reason}`,
    riskResult ? `Risk: ${riskResult.risk.suggestedAction} (${riskResult.risk.category}) - ${riskResult.risk.reason}` : null,
    approvalRequest ? `Approval request: ${approvalRequest.id} (${approvalRequest.status})` : null,
    `Action: ${action}`,
    sendResult ? `Send status: ${sendResult.ok ? "sent" : `failed - ${sendResult.message || "unknown error"}`}` : null,
    `Model: ${draft.model || DEFAULT_MODEL}`,
    `Tokens: prompt ${draft.usage.promptTokens}, output ${draft.usage.outputTokens}, total ${draft.usage.totalTokens}`,
    riskResult?.usage ? `Risk tokens: prompt ${riskResult.usage.promptTokens}, output ${riskResult.usage.outputTokens}, total ${riskResult.usage.totalTokens}` : null,
    `Fingerprint: ${latestHash}`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  await appendFile(desktopPath, block);
}

async function appendUnverifiedUiState({ since, sidebar, visible, latestHash, reason, approvalRequest = null }) {
  await mkdir(path.dirname(desktopPath), { recursive: true });
  const block = [
    "",
    "============================================================",
    `Detected: ${new Date().toLocaleString()}`,
    `Monitor since: ${since.toLocaleString()}`,
    `Conversation: ${visible?.conversationTitle || sidebar.title}`,
    `Sidebar time: ${sidebar.timeLabel}`,
    `Sidebar preview: ${sidebar.preview || "(none)"}`,
    "",
    "Visible conversation:",
    visible?.ok ? formatConversation(visible) : "(not readable)",
    "",
    `Action: unverified_ui_state`,
    `Reason: ${reason}`,
    approvalRequest ? `Approval request: ${approvalRequest.id} (${approvalRequest.status})` : null,
    `Fingerprint: ${latestHash || "(none)"}`,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  await appendFile(desktopPath, block);
}

function compactMessages(messages) {
  return (messages || [])
    .map((message) => ({
      direction: message.direction,
      text: String(message.text || "").trim(),
    }))
    .filter((message) => message.text);
}

function incomingSinceLastOutgoing(visible) {
  const messages = compactMessages(visible.messages);
  const latestOutgoingIndex = messages.findLastIndex((message) => message.direction === "outgoing");
  return messages
    .slice(latestOutgoingIndex + 1)
    .filter((message) => message.direction === "incoming" && message.text);
}

function approvalStatusForRisk(risk) {
  if (risk?.suggestedAction === "blocked_safety") return "blocked_safety";
  if (risk?.suggestedAction === "needs_context") return "needs_context";
  if (risk?.suggestedAction === "ask_approval") return "needs_approval";
  if (risk?.suggestedAction === "ignore") return "ignored";
  return "needs_approval";
}

function shouldQueueApproval({ contact, risk }) {
  if (contact?.autoSend === true) return true;
  if (contact?.approvalQueue === true) return true;
  return risk?.suggestedAction === "blocked_safety";
}

async function classifyRiskSafely({ visible, contact, memoryContext, draft }) {
  try {
    return await classifyReplyRisk({ visible, contact, memoryContext, draft });
  } catch (error) {
    return {
      risk: {
        approvalRequired: true,
        category: "risk_classifier_error",
        confidence: "high",
        reason: `Risk classifier failed: ${error.message}`,
        suggestedAction: "needs_context",
        contextQuestion: "The risk check failed. What should I say back?",
        deterministicFlags: ["risk_classifier_error"],
      },
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: DEFAULT_MODEL,
      promptStats: { error: error.message },
      rawText: "",
    };
  }
}

function findShadowComparisonTurn(visible) {
  const messages = compactMessages(visible.messages);
  if (!messages.length || messages.at(-1)?.direction !== "outgoing") return null;

  let firstTrailingOutgoing = messages.length - 1;
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
    batchHash,
    eventHash: stableHash({
      batchHash,
      actualReplies: actualReplies.map((message) => message.text.toLowerCase()),
      mode: "shadow-compared",
    }),
    incoming,
    actualReplies,
    draftVisible: {
      ...visible,
      messages: messages.slice(0, firstTrailingOutgoing),
    },
  };
}

function formatShadowLines(messages, fallbackSpeaker) {
  return messages.map((message) => `${message.direction === "outgoing" ? "Me" : fallbackSpeaker}: ${message.text}`);
}

async function appendShadowComparison({ since, sidebar, visible, latestHash, turn, draft }) {
  await mkdir(path.dirname(shadowDesktopPath), { recursive: true });
  const speaker = visible.conversationTitle || sidebar.title || "Them";
  const block = [
    "",
    "============================================================",
    `Detected: ${new Date().toLocaleString()}`,
    `Monitor since: ${since.toLocaleString()}`,
    `Conversation: ${speaker}`,
    `Sidebar time: ${sidebar.timeLabel}`,
    `Action: shadow-compared`,
    "",
    "Recipient messages:",
    ...formatShadowLines(turn.incoming, speaker),
    "",
    "My reply:",
    ...formatShadowLines(turn.actualReplies, speaker),
    "",
    "AI would have replied:",
    draft.draft.shouldReply ? draft.draft.replyText : "(no reply)",
    `AI reason: ${draft.draft.reason}`,
    `Model: ${draft.model || DEFAULT_MODEL}`,
    `Tokens: prompt ${draft.usage.promptTokens}, output ${draft.usage.outputTokens}, total ${draft.usage.totalTokens}`,
    `Latest fingerprint: ${latestHash}`,
    `Batch fingerprint: ${turn.batchHash}`,
    "",
  ].join("\n");
  await appendFile(shadowDesktopPath, block);
}

async function openAndReadSidebarItem(item, sidebar) {
  const backgroundOpen = await messagesAx.openSidebar(item.description, { background: true });
  if (backgroundOpen.ok) {
    const visible = await messagesAx.readVisible();
    if (!visible.ok) return { opened: backgroundOpen, visible };
    if (visibleTitleMatchesSidebar(visible, sidebar)) {
      return { opened: backgroundOpen, visible };
    }
  }

  const foregroundOpen = await messagesAx.openSidebar(item.description);
  if (!foregroundOpen.ok) return { opened: foregroundOpen, visible: null };
  const visible = await messagesAx.readVisible();
  return {
    opened: {
      ...foregroundOpen,
      backgroundFallbackReason: backgroundOpen.ok ? "background-open-did-not-match-visible-thread" : backgroundOpen.message,
    },
    visible,
  };
}

async function recoverMessagesWindow() {
  await runCommand("open", ["-b", "com.apple.MobileSMS"]);
  await sleep(1500);
  try {
    await messagesAx.clearSearch();
  } catch {
    // Best effort; the follow-up list call reports whether recovery worked.
  }
}

async function verifyLatestUnchanged(latestHash) {
  const visible = await messagesAx.readVisible();
  if (!visible.ok) return { ok: false, reason: "read-before-send-failed", visible };
  const latest = latestVisibleMessage(visible);
  if (messageFingerprint(latest) !== latestHash) {
    return { ok: false, reason: "latest-changed-before-send", visible };
  }
  return { ok: true, visible };
}

async function sendReplyForContact(contact, replyText) {
  const direct = contact?.directSend;
  if (direct?.enabled === true && String(direct.handle || "").trim()) {
    return {
      mode: "direct",
      result: await messagesAx.sendDirect({
        handle: direct.handle,
        serviceType: direct.serviceType || "iMessage",
        text: replyText,
      }),
    };
  }
  return {
    mode: "ui",
    result: await messagesAx.send(replyText),
  };
}

function countByReason(results) {
  const counts = {};
  for (const result of results) {
    const key = result.processed ? `processed:${result.action || "unknown"}` : result.reason || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function writeHealth({ since, list = null, results = [], state }) {
  let pendingApprovalCount = null;
  try {
    pendingApprovalCount = await countApprovalRequests({ status: "open" });
  } catch (error) {
    pendingApprovalCount = { error: error.message };
  }
  const payload = {
    ok: !results.some((result) => result.reason === "list-conversations-failed"),
    at: new Date().toISOString(),
    since: since.toISOString(),
    listOk: list?.ok === true,
    trusted: list?.trusted ?? null,
    itemCount: list?.items?.length || 0,
    processedCount: results.filter((result) => result.processed).length,
    reasonCounts: countByReason(results),
    pendingApprovalCount,
    stateProcessedCount: Object.keys(state?.processed || {}).length,
  };
  await mkdir(path.dirname(healthPath), { recursive: true });
  const tmpPath = `${healthPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2));
  await rename(tmpPath, healthPath);
  return payload;
}

function autoSendStyleGate({ contact, memoryContext, draft }) {
  if (contact?.autoSend !== true) return { ok: false, reason: "contact-auto-send-disabled" };
  if (!draft?.draft?.shouldReply || !draft.draft.replyText) return { ok: false, reason: "draft-not-sendable" };

  const confidence = memoryContext?.profile?.confidence || "low";
  const lowConfidenceLimit = Number(contact.draftPolicy?.lowConfidenceAutoSendMaxChars || 0);
  if (confidence === "low" && lowConfidenceLimit > 0 && draft.draft.replyText.length > lowConfidenceLimit) {
    return {
      ok: false,
      reason: `low-confidence-profile-reply-too-long (${draft.draft.replyText.length} chars)`,
    };
  }
  return { ok: true, reason: null };
}

function autoSendGlobalGate(config) {
  if (config.settings.allowSend !== true) {
    return { ok: false, reason: "config-allow-send-disabled" };
  }
  if (process.env.ALLOW_SEND !== "1") {
    return { ok: false, reason: "missing-ALLOW_SEND=1" };
  }
  return { ok: true, reason: null };
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

async function recordUnverifiedUiState({ config, sidebar, visible = null, latestHash = null, reason }) {
  const { slug } = await resolveSidebarConversation(config, sidebar);
  return createApprovalRequest({
    conversationSlug: slug,
    latestHash:
      latestHash ||
      stableHash({
        type: "unverified-ui-state",
        sidebar,
        reason,
      }),
    sidebar,
    visible: visible?.ok ? visible : null,
    incoming: [],
    proposedReply: null,
    reason,
    risk: {
      approvalRequired: true,
      category: "unverified_ui_state",
      confidence: "high",
      reason,
      suggestedAction: "needs_context",
      contextQuestion: "Messages shows a newer sidebar preview, but I could not verify it in the visible transcript.",
    },
    status: "unverified_ui_state",
    action: "unverified_ui_state",
    model: "messages-ax",
    usage: null,
    promptStats: null,
  });
}

async function processSidebarItem({ config, item, since, state, now }) {
  const sidebar = splitSidebarDescription(item.description);
  if (!sidebar) return { processed: false, reason: "unparseable-sidebar" };
  const sidebarTime = parseSidebarTimeToday(sidebar.timeLabel, now);
  if (!sidebarTime || sidebarTime < since) return { processed: false, reason: "before-since" };

  const sidebarHash = stableHash({ title: sidebar.title, preview: sidebar.preview, timeLabel: sidebar.timeLabel });
  if (state.processed[sidebarHash]) return { processed: false, reason: "already-processed-sidebar" };

  const { opened, visible } = await openAndReadSidebarItem(item, sidebar);
  if (!opened.ok) return { processed: false, reason: `open-failed: ${opened.message}` };
  if (!visible?.ok) return { processed: false, reason: "read-failed" };
  if (!visibleTitleMatchesSidebar(visible, sidebar)) {
    const latestHash = messageFingerprint(latestVisibleMessage(visible));
    const reason = "visible-title-did-not-match-sidebar-after-open";
    const approvalRequest = await recordUnverifiedUiState({ config, sidebar, visible, latestHash, reason });
    await appendUnverifiedUiState({ since, sidebar, visible, latestHash, reason, approvalRequest });
    const stateRecord = {
      at: new Date().toISOString(),
      action: "unverified_ui_state",
      sidebar,
      latestHash,
      output: desktopPath,
      approvalRequestId: approvalRequest.id,
      sent: false,
    };
    state.processed[sidebarHash] = stateRecord;
    return { processed: true, title: sidebar.title, action: "unverified_ui_state", latestHash, approvalRequestId: approvalRequest.id };
  }

  const latestHash = messageFingerprint(latestVisibleMessage(visible));
  if (state.processed[latestHash]) {
    const reason = "sidebar-preview-newer-than-processed-visible-latest";
    const approvalRequest = await recordUnverifiedUiState({ config, sidebar, visible, latestHash, reason });
    await appendUnverifiedUiState({ since, sidebar, visible, latestHash, reason, approvalRequest });
    const stateRecord = {
      at: new Date().toISOString(),
      action: "unverified_ui_state",
      sidebar,
      latestHash,
      output: desktopPath,
      approvalRequestId: approvalRequest.id,
      sent: false,
    };
    state.processed[sidebarHash] = stateRecord;
    return { processed: true, title: sidebar.title, action: "unverified_ui_state", latestHash, approvalRequestId: approvalRequest.id };
  }

  const match = await resolveSidebarConversation(config, sidebar);
  const { slug, contact } = match;
  await ingestVisibleConversation({
    slug,
    contact,
    visible,
    sidebarTitle: sidebar.title,
    source: "draft-monitor",
  });

  if (!isIncomingLatest(visible)) {
    const turn = findShadowComparisonTurn(visible);
    if (!turn) return { processed: false, reason: "latest-not-incoming" };
    if (state.processed[turn.eventHash]) return { processed: false, reason: "already-processed-shadow" };

    await getOllamaVersion();
    await assertOllamaModelAvailable(DEFAULT_MODEL);
    const memoryContext = await getMemoryContext({ slug, contact });
    const draft = await draftReply({ visible: turn.draftVisible, contact, memoryContext });
    await appendShadowComparison({ since, sidebar, visible, latestHash, turn, draft });
    await recordDraftMemory({ slug, latestHash, draft, action: "shadow-compared", sendResult: null, sidebar });

    const stateRecord = {
      at: new Date().toISOString(),
      action: "shadow-compared",
      sidebar,
      latestHash,
      output: shadowDesktopPath,
      sent: false,
      usage: draft.usage,
    };
    state.processed[turn.eventHash] = stateRecord;
    state.processed[latestHash] = stateRecord;
    return { processed: true, title: sidebar.title, action: "shadow-compared", latestHash, usage: draft.usage };
  }

  await getOllamaVersion();
  await assertOllamaModelAvailable(DEFAULT_MODEL);
  const memoryContext = await getMemoryContext({ slug, contact });
  const draft = await draftReply({ visible, contact, memoryContext });
  const riskResult = await classifyRiskSafely({ visible, contact, memoryContext, draft });
  let action = "drafted";
  let sendResult = null;
  let approvalRequest = null;
  const globalGate = autoSendGlobalGate(config);
  const styleGate = autoSendStyleGate({ contact, memoryContext, draft });
  const sendGate = globalGate.ok ? styleGate : globalGate;

  if (riskResult.risk.suggestedAction === "ignore") {
    action = "ignored";
  } else if (riskResult.risk.approvalRequired) {
    action = approvalStatusForRisk(riskResult.risk);
    if (shouldQueueApproval({ contact, risk: riskResult.risk })) {
      approvalRequest = await createApprovalRequest({
        conversationSlug: slug,
        latestHash,
        sidebar,
        visible,
        incoming: incomingSinceLastOutgoing(visible),
        proposedReply: draft.draft.replyText,
        reason: riskResult.risk.reason,
        risk: riskResult.risk,
        status: action,
        action,
        model: riskResult.model,
        usage: riskResult.usage,
        promptStats: riskResult.promptStats,
      });
    } else {
      action = "draft_only";
    }
  } else if (styleGate.ok) {
    if (globalGate.ok) {
      const verification = await verifyLatestUnchanged(latestHash);
      if (verification.ok) {
        const sendAttempt = await sendReplyForContact(contact, draft.draft.replyText);
        sendResult = sendAttempt.result;
        action = sendResult.ok ? (sendAttempt.mode === "direct" ? "direct-sent" : "sent") : "send-failed";
      } else {
        sendResult = { ok: false, message: verification.reason };
        action = "send-blocked";
      }
    } else {
      sendResult = { ok: false, message: globalGate.reason };
      action = "send-blocked";
    }
  } else if (contact?.autoSend === true && draft.draft.shouldReply) {
    sendResult = { ok: false, message: sendGate.reason };
    action = "send-blocked";
    approvalRequest = await createApprovalRequest({
      conversationSlug: slug,
      latestHash,
      sidebar,
      visible,
      incoming: incomingSinceLastOutgoing(visible),
      proposedReply: draft.draft.replyText,
      reason: sendGate.reason,
      risk: {
        ...riskResult.risk,
        approvalRequired: true,
        category: "send_gate_blocked",
        reason: sendGate.reason,
        suggestedAction: "ask_approval",
      },
      status: "needs_approval",
      action: "send_gate_blocked",
      model: riskResult.model,
      usage: riskResult.usage,
      promptStats: riskResult.promptStats,
    });
  } else {
    action = "draft_only";
  }
  await appendDraft({ since, sidebar, visible, latestHash, draft, riskResult, approvalRequest, action, sendResult });
  await recordDraftMemory({ slug, latestHash, draft, action, sendResult, sidebar });

  const stateRecord = {
    at: new Date().toISOString(),
    action,
    sidebar,
    latestHash,
    output: desktopPath,
    autoSendContact: contact?.autoSend === true ? contact.displayName : null,
    approvalRequestId: approvalRequest?.id || null,
    risk: riskResult.risk,
    sent: sendResult?.ok === true,
    usage: draft.usage,
  };
  state.processed[sidebarHash] = stateRecord;
  state.processed[latestHash] = stateRecord;
  return { processed: true, title: sidebar.title, action, latestHash, usage: draft.usage };
}

async function runCycle({ config, since, state }) {
  const now = new Date();
  let list = await messagesAx.listConversations();
  if (!list.ok) {
    list = await messagesAx.listConversations({ activate: true });
  }
  if (!list.ok) {
    await recoverMessagesWindow();
    list = await messagesAx.listConversations({ activate: true });
  }
  if (!list.ok) {
    const results = [
      {
        processed: false,
        reason: "list-conversations-failed",
        trusted: list.trusted,
        itemCount: list.items?.length || 0,
      },
    ];
    const health = await writeHealth({ since, list, results, state });
    return { results, health };
  }
  const results = [];
  for (const item of list.items || []) {
    try {
      results.push(await processSidebarItem({ config, item, since, state, now }));
    } catch (error) {
      results.push({
        processed: false,
        reason: `item-error: ${error.message}`,
        item: splitSidebarDescription(item.description),
      });
    }
  }
  await saveState(state);
  const health = await writeHealth({ since, list, results, state });
  return { results, health };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }
  const once = process.argv.includes("--once");
  const since = parseSince();
  const releaseLock =
    once || process.env.DRAFT_MONITOR_NO_LOCK === "1"
      ? null
      : await acquireLock(process.env.DRAFT_MONITOR_LOCK_DIR || path.join(repoRoot, "data", "draft-monitor.lock"));
  const state = await loadState();
  const config = await loadConfig();
  await appendStartupNotice({ since });
  let stopping = false;

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ at: new Date().toISOString(), status: `stopping:${signal}` }));
    if (releaseLock) await releaseLock();
  }

  process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

  console.log(`Draft monitor since: ${since.toLocaleString()}`);
  console.log(`Writing drafts to: ${desktopPath}`);
  console.log(`Writing shadow comparisons to: ${shadowDesktopPath}`);
  console.log("Mode: sends require contact autoSend=true, config allowSend=true, and ALLOW_SEND=1.");

  let idleCycles = 0;
  while (true) {
    const { results, health } = await runCycle({ config, since, state });
    const processed = results.filter((result) => result.processed);
    if (processed.length) {
      idleCycles = 0;
      console.log(JSON.stringify({ at: new Date().toISOString(), processed, health }, null, 2));
    } else {
      idleCycles += 1;
      const listFailure = results.find((result) => result.reason === "list-conversations-failed");
      if (listFailure && (idleCycles === 1 || idleCycles % idleLogEveryCycles === 0)) {
        console.error(JSON.stringify({ at: new Date().toISOString(), ...listFailure }, null, 2));
      }
      if (idleLogEveryCycles > 0 && idleCycles % idleLogEveryCycles === 0) {
        console.log(JSON.stringify({ at: new Date().toISOString(), processed: 0, idleCycles, health }, null, 2));
      }
    }
    if (once || stopping) break;
    await sleep(pollIntervalMs);
  }
  if (releaseLock) await releaseLock();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
