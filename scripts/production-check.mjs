#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.mjs";
import { draftReply } from "../src/decision.mjs";
import { getMemoryContext } from "../src/memory-store.mjs";
import { messagesAx } from "../src/messages-ax.mjs";
import { assertOllamaModelAvailable, DEFAULT_OLLAMA_URL, generateWithOllama, getOllamaVersion } from "../src/ollama-client.mjs";

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, message, ...details }, null, 2));
  process.exit(1);
}

function durationSeconds(start) {
  return Math.round((performance.now() - start) / 100) / 10;
}

const config = await loadConfig();
const autoSendContacts = Object.entries(config.contacts || {}).filter(([, contact]) => contact.autoSend === true);
const sendRequested = process.env.CHECK_SEND_READY === "1";

if (sendRequested && config.settings.allowSend !== true) {
  fail("Config allowSend must be true before starting a sending monitor.");
}
if (sendRequested && process.env.ALLOW_SEND !== "1") {
  fail("ALLOW_SEND=1 is required before starting a sending monitor.");
}
if (sendRequested && autoSendContacts.length !== 1) {
  fail("Expected exactly one auto-send contact for this production start.", {
    autoSendContacts: autoSendContacts.map(([slug, contact]) => ({ slug, displayName: contact.displayName })),
  });
}

const permission = await messagesAx.permission(false);
if (!permission.ok || permission.trusted !== true) {
  fail("Accessibility permission is not trusted for the current runtime.", { permission });
}

const version = await getOllamaVersion();
const model = await assertOllamaModelAvailable(process.env.GEMMA_MODEL || "gemma4:12b");
const pingStart = performance.now();
const ping = await generateWithOllama({
  model: process.env.GEMMA_MODEL || "gemma4:12b",
  system: "Return strict JSON only.",
  prompt: 'Return exactly {"ok":true,"message":"ready"}.',
  format: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
    },
    required: ["ok", "message"],
    additionalProperties: false,
  },
  options: {
    temperature: 0,
    num_ctx: Number(process.env.PRODUCTION_CHECK_NUM_CTX || 2048),
    num_predict: 32,
  },
  timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 120000),
});
const pingDurationSeconds = durationSeconds(pingStart);

let styleDraft = null;
const styleCheckEntry =
  autoSendContacts.find(([, contact]) => contact.styleExamples?.positive?.length) ||
  Object.entries(config.contacts || {}).find(([, contact]) => contact.styleExamples?.positive?.length);
if (styleCheckEntry) {
  const [slug, contact] = styleCheckEntry;
  const positiveExample = contact.styleExamples.positive[0];
  const incoming = (positiveExample.incoming || []).filter(Boolean);
  const visible = {
    conversationTitle: contact.conversationTitle || contact.displayName,
    messages: [
      { direction: "outgoing", text: "How are things there" },
      ...incoming.map((text) => ({ direction: "incoming", text })),
    ],
  };
  const draftStart = performance.now();
  const memoryContext = await getMemoryContext({ slug, contact });
  const draft = await draftReply({ visible, contact, memoryContext });
  if (!draft.draft.shouldReply || !draft.draft.replyText) {
    fail("Style draft check did not produce a sendable reply.", { slug, draft: draft.draft });
  }
  const lowered = draft.draft.replyText.toLowerCase();
  for (const forbidden of contact.draftPolicy?.forbiddenPhrases || []) {
    if (lowered.includes(forbidden)) {
      fail("Style draft check produced a forbidden phrase.", { slug, forbidden, replyText: draft.draft.replyText });
    }
  }
  styleDraft = {
    slug,
    displayName: contact.displayName,
    replyText: draft.draft.replyText,
    reason: draft.draft.reason,
    durationSeconds: durationSeconds(draftStart),
    usage: draft.usage,
    promptStats: draft.promptStats,
  };
}

console.log(
  JSON.stringify(
    {
      ok: true,
      node: process.version,
      ollamaUrl: DEFAULT_OLLAMA_URL,
      ollama: version,
      model: {
        name: model.name,
        size: model.size,
        modifiedAt: model.modified_at,
      },
      permission,
      config: {
        configPath: config.configPath,
        allowSend: config.settings.allowSend,
        autoSendContacts: autoSendContacts.map(([slug, contact]) => ({
          slug,
          displayName: contact.displayName,
          directSend: contact.directSend?.enabled === true,
          phoneNumbers: contact.identity?.phoneNumbers || [],
        })),
      },
      gemmaPing: {
        durationSeconds: pingDurationSeconds,
        usage: ping.usage,
        text: ping.text,
      },
      styleDraft,
    },
    null,
    2
  )
);
