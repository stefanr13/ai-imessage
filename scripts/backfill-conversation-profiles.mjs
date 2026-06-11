#!/usr/bin/env node
import { execFile } from "node:child_process";
import { DEFAULT_MODEL } from "../src/decision.mjs";
import { loadMessagesForMemory, listMemoryChunks, saveConversationProfile } from "../src/memory-store.mjs";
import { generateWithOllama, parseJsonResponse } from "../src/ollama-client.mjs";

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    relationshipSummary: { type: "string" },
    toneSummary: { type: "string" },
    userVoiceRules: { type: "array", items: { type: "string" }, maxItems: 8 },
    typicalReplyLength: { type: "string" },
    emojiStyle: { type: "string" },
    punctuationStyle: { type: "string" },
    nicknamesAndPetNames: { type: "array", items: { type: "string" }, maxItems: 6 },
    recurringTopics: { type: "array", items: { type: "string" }, maxItems: 8 },
    insideJokesOrReferences: { type: "array", items: { type: "string" }, maxItems: 6 },
    doNotImitate: { type: "array", items: { type: "string" }, maxItems: 8 },
    askUserBefore: { type: "array", items: { type: "string" }, maxItems: 8 },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "relationshipSummary",
    "toneSummary",
    "userVoiceRules",
    "typicalReplyLength",
    "emojiStyle",
    "punctuationStyle",
    "nicknamesAndPetNames",
    "recurringTopics",
    "insideJokesOrReferences",
    "doNotImitate",
    "askUserBefore",
    "confidence",
  ],
  additionalProperties: false,
};

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function argNumber(name, fallback) {
  const parsed = Number(argValue(name, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function positionalArgs() {
  const args = process.argv.slice(2);
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (["--limit"].includes(arg)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function trimText(value, maxChars = 500) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}[trimmed]`;
}

function unique(values, { maxItems = 8, maxChars = 160 } = {}) {
  const seen = new Set();
  const out = [];
  for (const value of values.flat()) {
    const text = trimText(value, maxChars).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeProfile(profile, fallbackConfidence = "low") {
  return {
    relationshipSummary: trimText(profile?.relationshipSummary, 240).trim(),
    toneSummary: trimText(profile?.toneSummary, 280).trim(),
    userVoiceRules: unique(profile?.userVoiceRules || [], { maxItems: 8, maxChars: 180 }),
    typicalReplyLength: trimText(profile?.typicalReplyLength, 180).trim(),
    emojiStyle: trimText(profile?.emojiStyle, 180).trim(),
    punctuationStyle: trimText(profile?.punctuationStyle, 180).trim(),
    nicknamesAndPetNames: unique(profile?.nicknamesAndPetNames || [], { maxItems: 6, maxChars: 120 }),
    recurringTopics: unique(profile?.recurringTopics || [], { maxItems: 8, maxChars: 140 }),
    insideJokesOrReferences: unique(profile?.insideJokesOrReferences || [], { maxItems: 6, maxChars: 140 }),
    doNotImitate: unique(profile?.doNotImitate || [], { maxItems: 8, maxChars: 180 }),
    askUserBefore: unique(profile?.askUserBefore || [], { maxItems: 8, maxChars: 180 }),
    confidence: ["low", "medium", "high"].includes(profile?.confidence) ? profile.confidence : fallbackConfidence,
  };
}

function messageLine(message) {
  const speaker = message.direction === "outgoing" ? "Me" : message.sender || "Them";
  return `${speaker}: ${trimText(message.text, 220).trim()}`;
}

function chunkNotes(chunks) {
  return chunks.map((chunk) => ({
    oneLineSummary: chunk.summary?.oneLineSummary || "",
    peopleAndContext: chunk.summary?.peopleAndContext || [],
    userToneSignals: chunk.summary?.userToneSignals || [],
    relationshipFacts: chunk.summary?.relationshipFacts || [],
    recurringTopics: chunk.summary?.recurringTopics || [],
    approvalTriggers: chunk.summary?.approvalTriggers || [],
    doNotImitate: chunk.summary?.doNotImitate || [],
  }));
}

function localFallbackProfile({ displayName, messages, chunks }) {
  const notes = chunkNotes(chunks);
  const outgoing = messages.filter((message) => message.direction === "outgoing").map((message) => message.text || "");
  const avgLength = outgoing.length
    ? Math.round(outgoing.reduce((sum, text) => sum + String(text).length, 0) / outgoing.length)
    : 0;
  const topics = unique(notes.map((note) => note.recurringTopics), { maxItems: 8, maxChars: 140 });
  const tone = unique(notes.map((note) => note.userToneSignals), { maxItems: 6, maxChars: 150 });
  const facts = unique(notes.map((note) => note.relationshipFacts || note.peopleAndContext), { maxItems: 5, maxChars: 150 });
  const summary = unique(notes.map((note) => note.oneLineSummary), { maxItems: 2, maxChars: 160 });
  return normalizeProfile(
    {
      relationshipSummary:
        facts.join(" ") || summary.join(" ") || `Conversation with ${displayName || "this contact"} indexed from local messages.`,
      toneSummary: tone.join("; ") || "Use a concise, natural tone based on the user's stored replies.",
      userVoiceRules: [
        avgLength && avgLength < 60 ? "Prefer short, direct replies." : "Match the user's level of detail from recent examples.",
        "Answer the latest message directly; do not over-summarize old context.",
      ],
      typicalReplyLength: avgLength ? `Average stored outgoing reply is about ${avgLength} characters.` : "Unknown.",
      emojiStyle: "Do not add emoji unless the recent conversation clearly supports it.",
      punctuationStyle: "Use natural punctuation; avoid polished assistant phrasing.",
      nicknamesAndPetNames: [],
      recurringTopics: topics,
      insideJokesOrReferences: [],
      askUserBefore: unique(
        [notes.map((note) => note.approvalTriggers), ["plans, commitments, money, sensitive facts, or unclear preferences"]],
        { maxItems: 8, maxChars: 180 }
      ),
      doNotImitate: unique([notes.map((note) => note.doNotImitate), ["generic assistant recaps"]], {
        maxItems: 8,
        maxChars: 180,
      }),
      confidence: messages.length >= 40 ? "medium" : "low",
    },
    messages.length >= 40 ? "medium" : "low"
  );
}

function sqlJson(sql) {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-json", "data/memory.sqlite3", sql], { maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim() ? JSON.parse(stdout) : []);
    });
  });
}

async function loadConversationContact(slug) {
  const escaped = slug.replaceAll("'", "''");
  const rows = await sqlJson(`SELECT display_name, config_json FROM conversations WHERE slug='${escaped}' LIMIT 1;`);
  const row = rows[0] || {};
  const contact = row.config_json ? JSON.parse(row.config_json) : {};
  return {
    displayName: contact.displayName || row.display_name || slug,
    contact: { ...contact, displayName: contact.displayName || row.display_name || slug, autoSend: Boolean(contact.autoSend) },
  };
}

async function buildGemmaProfile({ slug, displayName, messages, chunks }) {
  const recentMessages = messages.slice(-60).map(messageLine);
  const prompt = JSON.stringify(
    {
      task: "Build a compact conversation profile for a local text-message assistant.",
      contact: { displayName },
      chunkNotes: chunkNotes(chunks).slice(0, 8),
      recentMessages,
      rules: [
        "Use only the supplied evidence.",
        "Focus on useful context, relationship, recurring topics, and how the user writes.",
        "Keep strings concise.",
        "Do not include private raw transcripts.",
        "Ask-before items should be reusable rules.",
      ],
    },
    null,
    2
  );
  const result = await generateWithOllama({
    model: DEFAULT_MODEL,
    system: "Return strict JSON only. Build compact memory profiles for a local text-message assistant.",
    prompt,
    format: PROFILE_SCHEMA,
    options: {
      temperature: 0,
      num_ctx: Number(process.env.BACKFILL_PROFILE_NUM_CTX || 4096),
      num_predict: Number(process.env.BACKFILL_PROFILE_NUM_PREDICT || 900),
    },
    timeoutMs: Number(process.env.BACKFILL_PROFILE_TIMEOUT_MS || 90_000),
  });
  return { profile: normalizeProfile(parseJsonResponse(result.text), "medium"), model: result.model, usage: result.usage };
}

async function main() {
  const slugs = positionalArgs();
  if (!slugs.length || hasFlag("--help") || hasFlag("-h")) {
    console.error("Usage: node scripts/backfill-conversation-profiles.mjs <slug...> [--fallback-only]");
    process.exit(slugs.length ? 0 : 2);
  }
  const fallbackOnly = hasFlag("--fallback-only");
  const results = [];
  for (const slug of slugs) {
    const { displayName } = await loadConversationContact(slug);
    const messages = await loadMessagesForMemory({ slug, limit: argNumber("--limit", 120) });
    const chunks = await listMemoryChunks({ slug, limit: 20, includeText: false, includeEmbedding: false });
    let built;
    let warning = null;
    if (!fallbackOnly) {
      try {
        built = await buildGemmaProfile({ slug, displayName, messages, chunks });
      } catch (error) {
        warning = error.message;
      }
    }
    if (!built) {
      built = {
        profile: localFallbackProfile({ displayName, messages, chunks }),
        model: `${DEFAULT_MODEL}:local-backfill`,
        usage: null,
      };
    }
    await saveConversationProfile({
      slug,
      profile: built.profile,
      model: built.model,
      usage: built.usage,
      sourceMessageCount: messages.length,
      sourceExampleCount: 0,
    });
    results.push({ slug, model: built.model, confidence: built.profile.confidence, warning });
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
