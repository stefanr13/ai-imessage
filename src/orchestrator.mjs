import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";
import { messagesAx } from "./messages-ax.mjs";
import { DEFAULT_MODEL, decideNextAction, deterministicRuleDecision } from "./decision.mjs";
import { assertOllamaModelAvailable, getOllamaVersion } from "./ollama-client.mjs";
import { appendJsonl } from "./state-store.mjs";
import {
  latestVisibleMessage,
  messageFingerprint,
  sanitizeVisible,
  summarizeVisible,
  titleMatches,
} from "./transcript.mjs";

const runsDir = path.join(repoRoot, "data", "runs");
const eventsLogPath = path.join(repoRoot, "data", "assistant-events.jsonl");

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry({ label, attempts, delayMs, fn, isOk = (value) => Boolean(value?.ok) }) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn();
      lastResult = result;
      if (isOk(result)) return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  if (lastError) throw lastError;
  throw new Error(`${label} failed after ${attempts} attempts: ${JSON.stringify(lastResult)}`);
}

export function choosePolicyDecision({ deterministic, gemma }) {
  const modelDecision = gemma?.decision || null;
  if (!modelDecision) return deterministic;

  if (deterministic.action === "reply") {
    if (modelDecision.action === "reply" && modelDecision.replyText === deterministic.replyText) {
      return modelDecision;
    }
    return {
      action: "ask_user",
      replyText: null,
      matchedRule: deterministic.matchedRule,
      reason: "Model did not confirm the deterministic auto-reply rule.",
    };
  }

  return deterministic;
}

function canSend({ mode, settings }) {
  return mode === "send" && settings.allowSend === true && process.env.ALLOW_SEND === "1";
}

function shouldUseGemma({ deterministic, settings }) {
  return deterministic.action === "reply" && settings.requireModelConfirmation !== false;
}

function safeRecord({ record, includeRaw }) {
  return {
    ...record,
    visible: record.visible ? sanitizeVisible(record.visible, { includeRaw }) : null,
    verificationVisible: record.verificationVisible
      ? sanitizeVisible(record.verificationVisible, { includeRaw })
      : null,
  };
}

async function writeRunRecord({ slug, record, includeRaw }) {
  const outPath = path.join(runsDir, `${nowStamp()}-${slug}.json`);
  const safe = safeRecord({ record, includeRaw });
  await appendJsonl(eventsLogPath, {
    at: record.at,
    slug,
    mode: record.mode,
    ok: record.ok,
    chosen: record.chosen,
    sent: record.sent,
    usage: record.gemma?.usage || null,
    summary: record.visible ? summarizeVisible(record.visible) : null,
    error: record.error || null,
  });
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(safe, null, 2));
  return outPath;
}

async function verifyBeforeSend({ contact, settings, expectedLatestHash }) {
  const searchName = contact.searchName || contact.displayName;
  const resultName = contact.resultName || contact.displayName;
  await retry({
    label: "re-open before send",
    attempts: settings.maxOpenRetries,
    delayMs: settings.retryDelayMs,
    fn: () => messagesAx.open(searchName, resultName),
  });
  const { result: verificationVisible } = await retry({
    label: "read before send",
    attempts: 2,
    delayMs: settings.retryDelayMs,
    fn: () => messagesAx.readVisible(),
  });
  if (!titleMatches(verificationVisible.conversationTitle, contact)) {
    return {
      ok: false,
      verificationVisible,
      reason: `Conversation title changed before send: ${verificationVisible.conversationTitle || "(none)"}`,
    };
  }
  const latestHash = messageFingerprint(latestVisibleMessage(verificationVisible));
  if (latestHash !== expectedLatestHash) {
    return {
      ok: false,
      verificationVisible,
      reason: "Latest message changed before send.",
    };
  }
  return { ok: true, verificationVisible };
}

export async function runContactCycle({
  config,
  slug,
  contact,
  stateStore,
  mode = "dry-run",
  forceEvaluate = false,
} = {}) {
  const settings = config.settings;
  const at = new Date().toISOString();
  const record = {
    at,
    slug,
    mode,
    ok: false,
    opened: null,
    visible: null,
    deterministic: null,
    gemma: null,
    chosen: null,
    modelDecision: null,
    sent: null,
    sendBlocked: null,
    verificationVisible: null,
    error: null,
  };

  try {
    const permission = await messagesAx.permission(false);
    if (!permission.trusted && !permission.ok) {
      throw new Error("Accessibility permission is not granted.");
    }

    const searchName = contact.searchName || contact.displayName;
    const resultName = contact.resultName || contact.displayName;
    const opened = await retry({
      label: "open conversation",
      attempts: settings.maxOpenRetries,
      delayMs: settings.retryDelayMs,
      fn: () => messagesAx.open(searchName, resultName),
    });
    record.opened = opened.result;

    const read = await retry({
      label: "read conversation",
      attempts: 2,
      delayMs: settings.retryDelayMs,
      fn: () => messagesAx.readVisible(),
    });
    record.visible = read.result;

    if (!titleMatches(record.visible.conversationTitle, contact)) {
      throw new Error(`Opened conversation title did not match ${contact.displayName}.`);
    }

    const latest = latestVisibleMessage(record.visible);
    const latestHash = messageFingerprint(latest);
    const previous = stateStore?.getContact(slug) || {};

    if (!latestHash) {
      record.chosen = { action: "ignore", replyText: null, matchedRule: null, reason: "No visible latest message." };
    } else if (!forceEvaluate && !previous.lastSeenHash && settings.baselineExistingMessages) {
      record.chosen = {
        action: "ignore",
        replyText: null,
        matchedRule: null,
        reason: "Baselined existing latest message on first observation.",
      };
    } else if (!forceEvaluate && previous.lastSeenHash === latestHash) {
      record.chosen = {
        action: "ignore",
        replyText: null,
        matchedRule: null,
        reason: "Latest visible message was already processed.",
      };
    } else {
      record.deterministic = deterministicRuleDecision({ contact, visible: record.visible });
      if (shouldUseGemma({ deterministic: record.deterministic, settings })) {
        await getOllamaVersion();
        await assertOllamaModelAvailable(DEFAULT_MODEL);
        record.gemma = await decideNextAction({ contact, visible: record.visible });
      }
      record.modelDecision = record.gemma?.decision || null;
      record.chosen = choosePolicyDecision({ deterministic: record.deterministic, gemma: record.gemma });
    }

    if (record.chosen?.action === "reply") {
      if (!canSend({ mode, settings })) {
        record.sendBlocked = "Send disabled. Requires mode=send, config allowSend=true, and ALLOW_SEND=1.";
      } else {
        const verification = await verifyBeforeSend({ contact, settings, expectedLatestHash: latestHash });
        record.verificationVisible = verification.verificationVisible || null;
        if (!verification.ok) {
          record.sendBlocked = verification.reason;
        } else {
          record.sent = await messagesAx.send(record.chosen.replyText);
        }
      }
    }

    record.ok = true;
    if (stateStore) {
      await stateStore.updateContact(slug, {
        lastRunAt: at,
        lastSeenHash: latestHash,
        lastChosenAction: record.chosen?.action || null,
        lastSentAt: record.sent?.ok ? new Date().toISOString() : previous.lastSentAt || null,
        lastError: null,
        consecutiveFailures: 0,
      });
    }
  } catch (error) {
    record.error = error.stack || error.message;
    if (stateStore) {
      const previous = stateStore.getContact(slug);
      await stateStore.updateContact(slug, {
        lastRunAt: at,
        lastError: error.message,
        consecutiveFailures: (previous.consecutiveFailures || 0) + 1,
      });
    }
  }

  record.outPath = await writeRunRecord({ slug, record, includeRaw: config.settings.logRawMessages });
  return record;
}
