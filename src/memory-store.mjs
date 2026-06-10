import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";
import { normalizeComparableText, stableHash } from "./transcript.mjs";

export const DEFAULT_MEMORY_DB_PATH = process.env.MEMORY_DB || path.join(repoRoot, "data", "memory.sqlite3");

function runSql(sql, { dbPath = DEFAULT_MEMORY_DB_PATH, json = false } = {}) {
  const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
  return new Promise((resolve, reject) => {
    execFile("sqlite3", args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return sqlValue(JSON.stringify(value ?? null));
}

function nowIso() {
  return new Date().toISOString();
}

async function queryJson(sql, options = {}) {
  const stdout = await runSql(sql, { ...options, json: true });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export async function ensureMemoryDb(dbPath = DEFAULT_MEMORY_DB_PATH) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  await runSql(
    `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS conversations (
  slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sidebar_title TEXT,
  relationship TEXT,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  sender TEXT,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  raw_description TEXT,
  source TEXT NOT NULL,
  visible_order INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_seen
  ON messages(conversation_slug, last_seen_at);

CREATE TABLE IF NOT EXISTS style_examples (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  incoming_json TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_style_examples_conversation_seen
  ON style_examples(conversation_slug, last_seen_at);

CREATE TABLE IF NOT EXISTS conversation_profiles (
  conversation_slug TEXT PRIMARY KEY REFERENCES conversations(slug) ON DELETE CASCADE,
  profile_json TEXT NOT NULL,
  model TEXT,
  usage_json TEXT,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  source_example_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  latest_hash TEXT,
  action TEXT NOT NULL,
  reply_text TEXT,
  reason TEXT,
  send_ok INTEGER,
  send_message TEXT,
  model TEXT,
  usage_json TEXT,
  prompt_stats_json TEXT,
  sidebar_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_evidence (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  evidence_value TEXT NOT NULL,
  label TEXT,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  raw_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_evidence_conversation
  ON identity_evidence(conversation_slug, evidence_type, evidence_value);
`,
    { dbPath }
  );
}

function contactAliases(contact = {}) {
  return [
    contact.displayName,
    contact.searchName,
    contact.resultName,
    contact.conversationTitle,
    contact.identity?.canonicalName,
    ...(contact.titleAliases || []),
    ...(contact.identity?.phoneNumbers || []),
    ...(contact.identity?.emails || []),
    ...(contact.identity?.imessageHandles || []),
  ].filter(Boolean);
}

export async function upsertConversation({ slug, contact = {}, sidebarTitle = null, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  const displayName = contact.displayName || sidebarTitle || slug;
  const aliases = contactAliases(contact);
  await runSql(
    `
INSERT INTO conversations (
  slug, display_name, sidebar_title, relationship, aliases_json, config_json, created_at, updated_at
) VALUES (
  ${sqlValue(slug)},
  ${sqlValue(displayName)},
  ${sqlValue(sidebarTitle)},
  ${sqlValue(contact.relationship || null)},
  ${sqlJson(aliases)},
  ${sqlJson(contact)},
  ${sqlValue(at)},
  ${sqlValue(at)}
)
ON CONFLICT(slug) DO UPDATE SET
  display_name = excluded.display_name,
  sidebar_title = COALESCE(excluded.sidebar_title, conversations.sidebar_title),
  relationship = excluded.relationship,
  aliases_json = excluded.aliases_json,
  config_json = excluded.config_json,
  updated_at = excluded.updated_at;
`,
    { dbPath }
  );
}

function messageId({ slug, message }) {
  return stableHash({
    slug,
    direction: message.direction || "unknown",
    sender: message.sender || null,
    text: normalizeComparableText(message.text),
    rawDescription: message.rawDescription || null,
  });
}

function compactMessage(message) {
  return {
    direction: message.direction || "unknown",
    sender: message.sender || null,
    text: String(message.text || "").trim(),
    rawDescription: message.rawDescription || null,
  };
}

function excludedReplySet(contact = {}) {
  return new Set((contact.draftPolicy?.excludedStyleReplies || []).map((reply) => normalizeComparableText(reply)));
}

function hasDash(value) {
  return /[-\u2010-\u2015]/u.test(String(value || ""));
}

function extractStyleExamples({ slug, messages, source, observedAt, contact = {} }) {
  const examples = [];
  let incomingBatch = [];
  let incomingIds = [];
  const excludedReplies = excludedReplySet(contact);

  for (const message of messages) {
    const text = String(message.text || "").trim();
    if (!text) continue;

    if (message.direction === "incoming") {
      incomingBatch.push(compactMessage(message));
      incomingIds.push(messageId({ slug, message }));
      continue;
    }

    if (message.direction === "outgoing") {
      if (incomingBatch.length) {
        if (excludedReplies.has(normalizeComparableText(text))) {
          incomingBatch = [];
          incomingIds = [];
          continue;
        }
        const incoming = incomingBatch.slice(-6);
        const id = stableHash({
          slug,
          incoming: incoming.map((entry) => normalizeComparableText(entry.text)),
          reply: normalizeComparableText(text),
        });
        examples.push({
          id,
          incoming,
          replyText: text,
          sourceMessageIds: incomingIds.slice(-6),
          source,
          observedAt,
        });
      }
      incomingBatch = [];
      incomingIds = [];
    }
  }

  return examples;
}

export async function ingestVisibleConversation({
  slug,
  contact = {},
  visible,
  sidebarTitle = null,
  source = "visible-ui",
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  await upsertConversation({ slug, contact, sidebarTitle: sidebarTitle || visible?.conversationTitle || null, dbPath });
  const observedAt = nowIso();
  const messages = Array.isArray(visible?.messages) ? visible.messages : [];
  let insertedMessages = 0;
  let insertedExamples = 0;

  for (const [index, message] of messages.entries()) {
    const text = String(message.text || "").trim();
    if (!text) continue;
    const id = messageId({ slug, message });
    await runSql(
      `
INSERT INTO messages (
  id, conversation_slug, direction, sender, text, normalized_text, raw_description,
  source, visible_order, observed_at, first_seen_at, last_seen_at
) VALUES (
  ${sqlValue(id)},
  ${sqlValue(slug)},
  ${sqlValue(message.direction || "unknown")},
  ${sqlValue(message.sender || null)},
  ${sqlValue(text)},
  ${sqlValue(normalizeComparableText(text))},
  ${sqlValue(message.rawDescription || null)},
  ${sqlValue(source)},
  ${sqlValue(index)},
  ${sqlValue(observedAt)},
  ${sqlValue(observedAt)},
  ${sqlValue(observedAt)}
)
ON CONFLICT(id) DO UPDATE SET
  last_seen_at = excluded.last_seen_at,
  visible_order = excluded.visible_order,
  source = excluded.source;
`,
      { dbPath }
    );
    insertedMessages += 1;
  }

  for (const example of extractStyleExamples({ slug, messages, source, observedAt, contact })) {
    await runSql(
      `
INSERT INTO style_examples (
  id, conversation_slug, incoming_json, reply_text, source_message_ids_json,
  source, observed_at, first_seen_at, last_seen_at
) VALUES (
  ${sqlValue(example.id)},
  ${sqlValue(slug)},
  ${sqlJson(example.incoming)},
  ${sqlValue(example.replyText)},
  ${sqlJson(example.sourceMessageIds)},
  ${sqlValue(example.source)},
  ${sqlValue(example.observedAt)},
  ${sqlValue(example.observedAt)},
  ${sqlValue(example.observedAt)}
)
ON CONFLICT(id) DO UPDATE SET
  last_seen_at = excluded.last_seen_at,
  source = excluded.source;
`,
      { dbPath }
    );
    insertedExamples += 1;
  }

  return { messages: insertedMessages, styleExamples: insertedExamples };
}

export async function loadStyleExamples({ slug, limit = 6, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT id, incoming_json, reply_text, last_seen_at
FROM style_examples
WHERE conversation_slug = ${sqlValue(slug)}
ORDER BY last_seen_at DESC
LIMIT ${sqlValue(limit)};
`,
    { dbPath }
  );
  return rows.map((row) => ({
    id: row.id,
    incoming: JSON.parse(row.incoming_json || "[]"),
    replyText: row.reply_text,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function purgeExcludedStyleExamples({ slug, contact = {}, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const excluded = [...excludedReplySet(contact)];
  if (!excluded.length) return { deleted: 0 };
  let deleted = 0;
  for (const normalizedReply of excluded) {
    const before = await queryJson(
      `
SELECT count(*) AS count
FROM style_examples
WHERE conversation_slug = ${sqlValue(slug)}
  AND lower(trim(reply_text)) = ${sqlValue(normalizedReply)};
`,
      { dbPath }
    );
    await runSql(
      `
DELETE FROM style_examples
WHERE conversation_slug = ${sqlValue(slug)}
  AND lower(trim(reply_text)) = ${sqlValue(normalizedReply)};
`,
      { dbPath }
    );
    deleted += Number(before[0]?.count || 0);
  }
  return { deleted };
}

export async function loadConversationProfile({ slug, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT profile_json, model, usage_json, source_message_count, source_example_count, updated_at
FROM conversation_profiles
WHERE conversation_slug = ${sqlValue(slug)}
LIMIT 1;
`,
    { dbPath }
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    profile: JSON.parse(row.profile_json || "{}"),
    model: row.model || null,
    usage: row.usage_json ? JSON.parse(row.usage_json) : null,
    sourceMessageCount: row.source_message_count || 0,
    sourceExampleCount: row.source_example_count || 0,
    updatedAt: row.updated_at,
  };
}

export async function saveConversationProfile({
  slug,
  profile,
  model,
  usage,
  sourceMessageCount,
  sourceExampleCount,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  await runSql(
    `
INSERT INTO conversation_profiles (
  conversation_slug, profile_json, model, usage_json,
  source_message_count, source_example_count, created_at, updated_at
) VALUES (
  ${sqlValue(slug)},
  ${sqlJson(profile)},
  ${sqlValue(model || null)},
  ${sqlJson(usage || null)},
  ${sqlValue(sourceMessageCount || 0)},
  ${sqlValue(sourceExampleCount || 0)},
  ${sqlValue(at)},
  ${sqlValue(at)}
)
ON CONFLICT(conversation_slug) DO UPDATE SET
  profile_json = excluded.profile_json,
  model = excluded.model,
  usage_json = excluded.usage_json,
  source_message_count = excluded.source_message_count,
  source_example_count = excluded.source_example_count,
  updated_at = excluded.updated_at;
`,
    { dbPath }
  );
}

export async function loadProfileSeed({
  slug,
  contact = {},
  messageLimit = 80,
  exampleLimit = 16,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const messages = await queryJson(
    `
SELECT direction, sender, text, raw_description, last_seen_at
FROM messages
WHERE conversation_slug = ${sqlValue(slug)}
ORDER BY last_seen_at DESC, visible_order DESC
LIMIT ${sqlValue(messageLimit)};
`,
    { dbPath }
  );
  let examples = await loadStyleExamples({ slug, limit: exampleLimit, dbPath });
  const excluded = excludedReplySet(contact);
  if (contact.draftPolicy?.forbidDashCharacters) {
    examples = examples.filter((example) => !hasDash(example.replyText));
  }
  return {
    messages: messages
      .reverse()
      .filter((message) => {
        if (message.direction !== "outgoing") return true;
        if (excluded.has(normalizeComparableText(message.text))) return false;
        if (contact.draftPolicy?.forbidDashCharacters && hasDash(message.text)) return false;
        return true;
      })
      .map((message) => ({
        direction: message.direction,
        sender: message.sender || null,
        text: message.text,
        observedAt: message.last_seen_at,
      })),
    examples,
  };
}

export async function getMemoryContext({ slug, contact = {}, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const profile = await loadConversationProfile({ slug, dbPath });
  const examples = await loadStyleExamples({ slug, limit: Number(process.env.MEMORY_EXAMPLE_LIMIT || 6), dbPath });
  return {
    slug,
    contactStyleProfile: contact.styleProfile || null,
    profile: profile?.profile || null,
    profileUpdatedAt: profile?.updatedAt || null,
    styleExamples: examples,
  };
}

export async function recordDraftMemory({
  slug,
  latestHash,
  draft,
  action,
  sendResult = null,
  sidebar = null,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  const id = stableHash({
    slug,
    latestHash,
    action,
    replyText: draft?.draft?.replyText || null,
    at,
  });
  await runSql(
    `
INSERT INTO drafts (
  id, conversation_slug, latest_hash, action, reply_text, reason, send_ok, send_message,
  model, usage_json, prompt_stats_json, sidebar_json, created_at
) VALUES (
  ${sqlValue(id)},
  ${sqlValue(slug)},
  ${sqlValue(latestHash || null)},
  ${sqlValue(action)},
  ${sqlValue(draft?.draft?.replyText || null)},
  ${sqlValue(draft?.draft?.reason || null)},
  ${sendResult ? sqlValue(sendResult.ok ? 1 : 0) : "NULL"},
  ${sqlValue(sendResult?.message || null)},
  ${sqlValue(draft?.model || null)},
  ${sqlJson(draft?.usage || null)},
  ${sqlJson(draft?.promptStats || null)},
  ${sqlJson(sidebar || null)},
  ${sqlValue(at)}
);
`,
    { dbPath }
  );
  return { id };
}

export async function recordIdentityEvidence({
  slug,
  evidenceType,
  value,
  label = null,
  source = "messages-ui",
  confidence = 0.5,
  raw = {},
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const normalizedValue = evidenceType === "phone" ? normalizePhone(value) : String(value || "").trim().toLowerCase();
  if (!normalizedValue) return null;
  const at = nowIso();
  const id = stableHash({ slug, evidenceType, normalizedValue, source });
  await runSql(
    `
INSERT INTO identity_evidence (
  id, conversation_slug, evidence_type, evidence_value, label, source, confidence,
  raw_json, first_seen_at, last_seen_at
) VALUES (
  ${sqlValue(id)},
  ${sqlValue(slug)},
  ${sqlValue(evidenceType)},
  ${sqlValue(normalizedValue)},
  ${sqlValue(label)},
  ${sqlValue(source)},
  ${sqlValue(confidence)},
  ${sqlJson(raw)},
  ${sqlValue(at)},
  ${sqlValue(at)}
)
ON CONFLICT(id) DO UPDATE SET
  label = COALESCE(excluded.label, identity_evidence.label),
  confidence = MAX(identity_evidence.confidence, excluded.confidence),
  raw_json = excluded.raw_json,
  last_seen_at = excluded.last_seen_at;
`,
    { dbPath }
  );
  return { id, value: normalizedValue };
}

export function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return "";
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

export async function recordIdentityBundle({
  slug,
  identity,
  source = "messages-ui-details",
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const recorded = [];
  for (const title of identity.uiTitles || []) {
    const result = await recordIdentityEvidence({
      slug,
      evidenceType: "ui_title",
      value: title,
      source,
      confidence: 0.45,
      raw: identity,
      dbPath,
    });
    if (result) recorded.push(result);
  }
  for (const name of identity.names || []) {
    const result = await recordIdentityEvidence({
      slug,
      evidenceType: "name",
      value: name,
      source,
      confidence: 0.65,
      raw: identity,
      dbPath,
    });
    if (result) recorded.push(result);
  }
  for (const phone of identity.phoneNumbers || []) {
    const result = await recordIdentityEvidence({
      slug,
      evidenceType: "phone",
      value: phone,
      source,
      confidence: 0.9,
      raw: identity,
      dbPath,
    });
    if (result) recorded.push(result);
  }
  for (const email of identity.emails || []) {
    const result = await recordIdentityEvidence({
      slug,
      evidenceType: "email",
      value: email,
      source,
      confidence: 0.9,
      raw: identity,
      dbPath,
    });
    if (result) recorded.push(result);
  }
  return { recorded: recorded.length };
}

export async function loadIdentityEvidence({ slug, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  return queryJson(
    `
SELECT evidence_type, evidence_value, label, source, confidence, last_seen_at
FROM identity_evidence
WHERE conversation_slug = ${sqlValue(slug)}
ORDER BY confidence DESC, last_seen_at DESC;
`,
    { dbPath }
  );
}

export async function findConversationSlugByIdentityValue({ value, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const normalizedText = normalizeComparableText(value);
  const normalizedPhone = normalizePhone(value);
  const values = [normalizedText, normalizedPhone].filter(Boolean);
  if (!values.length) return null;
  const inList = values.map(sqlValue).join(", ");
  const rows = await queryJson(
    `
SELECT conversation_slug, evidence_type, evidence_value, confidence
FROM identity_evidence
WHERE evidence_value IN (${inList})
ORDER BY confidence DESC, last_seen_at DESC
LIMIT 1;
`,
    { dbPath }
  );
  return rows[0] || null;
}
