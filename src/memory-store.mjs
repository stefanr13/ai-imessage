import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";
import { normalizeComparableText, stableHash } from "./transcript.mjs";

export const DEFAULT_MEMORY_DB_PATH = process.env.MEMORY_DB || path.join(repoRoot, "data", "memory.sqlite3");

function runSql(sql, { dbPath = DEFAULT_MEMORY_DB_PATH, json = false } = {}) {
  const args = json ? ["-cmd", ".timeout 5000", "-json", dbPath, sql] : ["-cmd", ".timeout 5000", dbPath, sql];
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

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL,
  latest_hash TEXT,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  proposed_reply TEXT,
  reason TEXT,
  risk_json TEXT NOT NULL DEFAULT '{}',
  sidebar_json TEXT,
  visible_json TEXT,
  incoming_json TEXT,
  model TEXT,
  usage_json TEXT,
  prompt_stats_json TEXT,
  user_response_text TEXT,
  send_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status_updated
  ON approval_requests(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_conversation_updated
  ON approval_requests(conversation_slug, updated_at);

CREATE TABLE IF NOT EXISTS memory_index_jobs (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  status TEXT NOT NULL,
  target_message_count INTEGER NOT NULL DEFAULT 0,
  observed_message_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  embedded_chunk_count INTEGER NOT NULL DEFAULT 0,
  summarized_chunk_count INTEGER NOT NULL DEFAULT 0,
  embedding_model TEXT,
  profile_model TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_index_jobs_conversation_updated
  ON memory_index_jobs(conversation_slug, updated_at);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  conversation_slug TEXT NOT NULL REFERENCES conversations(slug) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  source_message_ids_json TEXT NOT NULL DEFAULT '[]',
  start_observed_at TEXT,
  end_observed_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  summary_model TEXT,
  summary_usage_json TEXT,
  summarized_at TEXT,
  embedding_model TEXT,
  embedding_json TEXT,
  embedding_dim INTEGER,
  embedding_norm REAL,
  embedded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_conversation_index
  ON memory_chunks(conversation_slug, chunk_index);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_conversation_updated
  ON memory_chunks(conversation_slug, updated_at);

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

export async function loadMessagesForMemory({ slug, limit = 300, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT id, direction, sender, text, raw_description, visible_order, last_seen_at
FROM messages
WHERE conversation_slug = ${sqlValue(slug)}
ORDER BY last_seen_at DESC, visible_order DESC
LIMIT ${sqlValue(Math.max(1, Math.min(Number(limit) || 300, 2000)))};
`,
    { dbPath }
  );
  return rows.reverse().map((row) => ({
    id: row.id,
    direction: row.direction,
    sender: row.sender || null,
    text: row.text,
    rawDescription: row.raw_description || null,
    visibleOrder: row.visible_order,
    observedAt: row.last_seen_at,
  }));
}

export async function startMemoryIndexJob({
  slug,
  targetMessageCount = 300,
  observedMessageCount = 0,
  embeddingModel = null,
  profileModel = null,
  options = {},
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  const id = stableHash({
    type: "memory-index-job",
    slug,
    targetMessageCount,
    embeddingModel,
    profileModel,
    at,
  });
  await runSql(
    `
INSERT INTO memory_index_jobs (
  id, conversation_slug, status, target_message_count, observed_message_count,
  embedding_model, profile_model, options_json, started_at, updated_at
) VALUES (
  ${sqlValue(id)},
  ${sqlValue(slug)},
  'running',
  ${sqlValue(targetMessageCount)},
  ${sqlValue(observedMessageCount)},
  ${sqlValue(embeddingModel || null)},
  ${sqlValue(profileModel || null)},
  ${sqlJson(options || {})},
  ${sqlValue(at)},
  ${sqlValue(at)}
);
`,
    { dbPath }
  );
  return getMemoryIndexJob(id, { dbPath });
}

export async function updateMemoryIndexJob({
  id,
  status = null,
  observedMessageCount = null,
  chunkCount = null,
  embeddedChunkCount = null,
  summarizedChunkCount = null,
  error = null,
  completed = false,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  await runSql(
    `
UPDATE memory_index_jobs
SET
  status = COALESCE(${sqlValue(status)}, status),
  observed_message_count = COALESCE(${sqlValue(observedMessageCount)}, observed_message_count),
  chunk_count = COALESCE(${sqlValue(chunkCount)}, chunk_count),
  embedded_chunk_count = COALESCE(${sqlValue(embeddedChunkCount)}, embedded_chunk_count),
  summarized_chunk_count = COALESCE(${sqlValue(summarizedChunkCount)}, summarized_chunk_count),
  error = ${error === null ? "error" : sqlValue(error)},
  updated_at = ${sqlValue(at)},
  completed_at = ${completed ? sqlValue(at) : "completed_at"}
WHERE id = ${sqlValue(id)};
`,
    { dbPath }
  );
  return getMemoryIndexJob(id, { dbPath });
}

export async function getMemoryIndexJob(id, { dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT *
FROM memory_index_jobs
WHERE id = ${sqlValue(id)}
LIMIT 1;
`,
    { dbPath }
  );
  return rowToMemoryIndexJob(rows[0] || null);
}

function rowToMemoryIndexJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationSlug: row.conversation_slug,
    status: row.status,
    targetMessageCount: Number(row.target_message_count || 0),
    observedMessageCount: Number(row.observed_message_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    embeddedChunkCount: Number(row.embedded_chunk_count || 0),
    summarizedChunkCount: Number(row.summarized_chunk_count || 0),
    embeddingModel: row.embedding_model || null,
    profileModel: row.profile_model || null,
    options: parseJsonField(row.options_json, {}),
    error: row.error || null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
}

function vectorNorm(vector) {
  if (!Array.isArray(vector)) return null;
  const sumSquares = vector.reduce((sum, value) => sum + Number(value || 0) ** 2, 0);
  return Math.sqrt(sumSquares);
}

function rowToMemoryChunk(row, { includeText = true, includeEmbedding = false } = {}) {
  if (!row) return null;
  const embedding = includeEmbedding ? parseJsonField(row.embedding_json, null) : null;
  return {
    id: row.id,
    conversationSlug: row.conversation_slug,
    chunkIndex: Number(row.chunk_index || 0),
    sourceMessageIds: parseJsonField(row.source_message_ids_json, []),
    startObservedAt: row.start_observed_at || null,
    endObservedAt: row.end_observed_at || null,
    messageCount: Number(row.message_count || 0),
    ...(includeText ? { text: row.text || "" } : { textChars: String(row.text || "").length }),
    summary: parseJsonField(row.summary_json, {}),
    summaryModel: row.summary_model || null,
    summaryUsage: parseJsonField(row.summary_usage_json, null),
    summarizedAt: row.summarized_at || null,
    embeddingModel: row.embedding_model || null,
    embeddingDim: row.embedding_dim || null,
    embeddingNorm: row.embedding_norm || null,
    ...(includeEmbedding ? { embedding } : {}),
    embeddedAt: row.embedded_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertMemoryChunk({
  id,
  conversationSlug,
  chunkIndex,
  sourceMessageIds = [],
  startObservedAt = null,
  endObservedAt = null,
  messageCount = 0,
  text,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  await runSql(
    `
INSERT INTO memory_chunks (
  id, conversation_slug, chunk_index, source_message_ids_json, start_observed_at,
  end_observed_at, message_count, text, created_at, updated_at
) VALUES (
  ${sqlValue(id)},
  ${sqlValue(conversationSlug)},
  ${sqlValue(chunkIndex)},
  ${sqlJson(sourceMessageIds)},
  ${sqlValue(startObservedAt || null)},
  ${sqlValue(endObservedAt || null)},
  ${sqlValue(messageCount)},
  ${sqlValue(text || "")},
  ${sqlValue(at)},
  ${sqlValue(at)}
)
ON CONFLICT(id) DO UPDATE SET
  chunk_index = excluded.chunk_index,
  source_message_ids_json = excluded.source_message_ids_json,
  start_observed_at = excluded.start_observed_at,
  end_observed_at = excluded.end_observed_at,
  message_count = excluded.message_count,
  text = excluded.text,
  updated_at = excluded.updated_at;
`,
    { dbPath }
  );
  return getMemoryChunk(id, { dbPath });
}

export async function getMemoryChunk(id, { dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT *
FROM memory_chunks
WHERE id = ${sqlValue(id)}
LIMIT 1;
`,
    { dbPath }
  );
  return rowToMemoryChunk(rows[0] || null);
}

export async function listMemoryChunks({
  slug,
  limit = 100,
  includeText = true,
  includeEmbedding = false,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT *
FROM memory_chunks
WHERE conversation_slug = ${sqlValue(slug)}
ORDER BY chunk_index ASC
LIMIT ${sqlValue(Math.max(1, Math.min(Number(limit) || 100, 2000)))};
`,
    { dbPath }
  );
  return rows.map((row) => rowToMemoryChunk(row, { includeText, includeEmbedding }));
}

export async function updateMemoryChunkSummary({
  id,
  summary,
  model,
  usage = null,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  await runSql(
    `
UPDATE memory_chunks
SET
  summary_json = ${sqlJson(summary || {})},
  summary_model = ${sqlValue(model || null)},
  summary_usage_json = ${sqlJson(usage || null)},
  summarized_at = ${sqlValue(at)},
  updated_at = ${sqlValue(at)}
WHERE id = ${sqlValue(id)};
`,
    { dbPath }
  );
  return getMemoryChunk(id, { dbPath });
}

export async function updateMemoryChunkEmbedding({
  id,
  embedding,
  model,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  const at = nowIso();
  const norm = vectorNorm(embedding);
  await runSql(
    `
UPDATE memory_chunks
SET
  embedding_model = ${sqlValue(model || null)},
  embedding_json = ${sqlJson(embedding || null)},
  embedding_dim = ${sqlValue(Array.isArray(embedding) ? embedding.length : null)},
  embedding_norm = ${sqlValue(norm)},
  embedded_at = ${sqlValue(at)},
  updated_at = ${sqlValue(at)}
WHERE id = ${sqlValue(id)};
`,
    { dbPath }
  );
  return getMemoryChunk(id, { dbPath });
}

export async function getConversationMemoryStatus({ slug, dbPath = DEFAULT_MEMORY_DB_PATH }) {
  const rows = await listConversationMemoryStatuses({ dbPath });
  return rows.find((row) => row.slug === slug) || null;
}

export async function listConversationMemoryStatuses({ dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT
  c.slug,
  c.display_name,
  c.relationship,
  c.sidebar_title,
  c.updated_at AS conversation_updated_at,
  (SELECT count(*) FROM messages m WHERE m.conversation_slug = c.slug) AS message_count,
  (SELECT max(m.last_seen_at) FROM messages m WHERE m.conversation_slug = c.slug) AS latest_message_at,
  (SELECT count(*) FROM style_examples se WHERE se.conversation_slug = c.slug) AS style_example_count,
  (SELECT count(*) FROM memory_chunks mc WHERE mc.conversation_slug = c.slug) AS chunk_count,
  (SELECT count(*) FROM memory_chunks mc WHERE mc.conversation_slug = c.slug AND mc.embedding_json IS NOT NULL) AS embedded_chunk_count,
  (SELECT count(*) FROM memory_chunks mc WHERE mc.conversation_slug = c.slug AND mc.summarized_at IS NOT NULL) AS summarized_chunk_count,
  p.profile_json,
  p.model AS profile_model,
  p.source_message_count AS profile_source_message_count,
  p.source_example_count AS profile_source_example_count,
  p.updated_at AS profile_updated_at,
  j.id AS latest_job_id,
  j.status AS latest_job_status,
  j.target_message_count AS latest_job_target_message_count,
  j.observed_message_count AS latest_job_observed_message_count,
  j.embedding_model AS latest_job_embedding_model,
  j.profile_model AS latest_job_profile_model,
  j.error AS latest_job_error,
  j.started_at AS latest_job_started_at,
  j.updated_at AS latest_job_updated_at,
  j.completed_at AS latest_job_completed_at
FROM conversations c
LEFT JOIN conversation_profiles p ON p.conversation_slug = c.slug
LEFT JOIN memory_index_jobs j ON j.id = (
  SELECT id FROM memory_index_jobs j2
  WHERE j2.conversation_slug = c.slug
  ORDER BY j2.updated_at DESC
  LIMIT 1
)
ORDER BY c.updated_at DESC;
`,
    { dbPath }
  );
  return rows.map((row) => {
    const profile = parseJsonField(row.profile_json, null);
    return {
      slug: row.slug,
      displayName: row.display_name,
      relationship: row.relationship || null,
      sidebarTitle: row.sidebar_title || null,
      conversationUpdatedAt: row.conversation_updated_at,
      messageCount: Number(row.message_count || 0),
      latestMessageAt: row.latest_message_at || null,
      styleExampleCount: Number(row.style_example_count || 0),
      chunkCount: Number(row.chunk_count || 0),
      embeddedChunkCount: Number(row.embedded_chunk_count || 0),
      summarizedChunkCount: Number(row.summarized_chunk_count || 0),
      profile: profile
        ? {
            confidence: profile.confidence || "low",
            relationshipSummary: profile.relationshipSummary || "",
            toneSummary: profile.toneSummary || "",
            userVoiceRules: profile.userVoiceRules || [],
            recurringTopics: profile.recurringTopics || [],
            askUserBefore: profile.askUserBefore || [],
            doNotImitate: profile.doNotImitate || [],
          }
        : null,
      profileModel: row.profile_model || null,
      profileSourceMessageCount: Number(row.profile_source_message_count || 0),
      profileSourceExampleCount: Number(row.profile_source_example_count || 0),
      profileUpdatedAt: row.profile_updated_at || null,
      latestJob: row.latest_job_id
        ? {
            id: row.latest_job_id,
            status: row.latest_job_status,
            targetMessageCount: Number(row.latest_job_target_message_count || 0),
            observedMessageCount: Number(row.latest_job_observed_message_count || 0),
            embeddingModel: row.latest_job_embedding_model || null,
            profileModel: row.latest_job_profile_model || null,
            error: row.latest_job_error || null,
            startedAt: row.latest_job_started_at,
            updatedAt: row.latest_job_updated_at,
            completedAt: row.latest_job_completed_at || null,
          }
        : null,
    };
  });
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

export const APPROVAL_OPEN_STATUSES = [
  "needs_approval",
  "needs_context",
  "manual_send_pending",
  "unverified_ui_state",
  "blocked_safety",
  "send_failed",
];

function parseJsonField(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function approvalRequestId({
  id = null,
  conversationSlug,
  latestHash = null,
  sidebar = null,
  proposedReply = null,
  action = null,
  status = null,
  reason = null,
}) {
  if (id) return id;
  return stableHash({
    type: "approval-request",
    conversationSlug,
    latestHash,
    sidebarTitle: sidebar?.title || null,
    sidebarPreview: sidebar?.preview || null,
    sidebarTimeLabel: sidebar?.timeLabel || null,
    proposedReply: proposedReply || null,
    action: action || null,
    status: status || null,
    reason: typeof reason === "string" ? reason : reason?.reason || reason?.category || null,
  });
}

function rowToApprovalRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationSlug: row.conversation_slug,
    latestHash: row.latest_hash || null,
    status: row.status,
    action: row.action,
    proposedReply: row.proposed_reply || null,
    reason: row.reason || null,
    risk: parseJsonField(row.risk_json, {}),
    sidebar: parseJsonField(row.sidebar_json, null),
    visible: parseJsonField(row.visible_json, null),
    incoming: parseJsonField(row.incoming_json, []),
    model: row.model || null,
    usage: parseJsonField(row.usage_json, null),
    promptStats: parseJsonField(row.prompt_stats_json, null),
    userResponseText: row.user_response_text || null,
    sendResult: parseJsonField(row.send_result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at || null,
    sentAt: row.sent_at || null,
  };
}

export async function createApprovalRequest({
  id = null,
  conversationSlug,
  latestHash = null,
  sidebar = null,
  visible = null,
  incoming = [],
  proposedReply = null,
  reason = null,
  risk = {},
  status = "needs_approval",
  action = "ask_approval",
  model = null,
  usage = null,
  promptStats = null,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  if (!conversationSlug) throw new Error("createApprovalRequest requires conversationSlug.");
  const at = nowIso();
  const requestId = approvalRequestId({
    id,
    conversationSlug,
    latestHash,
    sidebar,
    proposedReply,
    action,
    status,
    reason,
  });
  const reasonText = typeof reason === "string" ? reason : reason?.reason || reason?.category || null;
  await runSql(
    `
INSERT INTO approval_requests (
  id, conversation_slug, latest_hash, status, action, proposed_reply, reason, risk_json,
  sidebar_json, visible_json, incoming_json, model, usage_json, prompt_stats_json,
  created_at, updated_at
) VALUES (
  ${sqlValue(requestId)},
  ${sqlValue(conversationSlug)},
  ${sqlValue(latestHash || null)},
  ${sqlValue(status)},
  ${sqlValue(action)},
  ${sqlValue(proposedReply || null)},
  ${sqlValue(reasonText)},
  ${sqlJson(risk || {})},
  ${sqlJson(sidebar || null)},
  ${sqlJson(visible || null)},
  ${sqlJson(incoming || [])},
  ${sqlValue(model || null)},
  ${sqlJson(usage || null)},
  ${sqlJson(promptStats || null)},
  ${sqlValue(at)},
  ${sqlValue(at)}
)
ON CONFLICT(id) DO UPDATE SET
  latest_hash = COALESCE(excluded.latest_hash, approval_requests.latest_hash),
  status = CASE
    WHEN approval_requests.status IN ('sent', 'rejected') THEN approval_requests.status
    ELSE excluded.status
  END,
  action = CASE
    WHEN approval_requests.status IN ('sent', 'rejected') THEN approval_requests.action
    ELSE excluded.action
  END,
  proposed_reply = COALESCE(excluded.proposed_reply, approval_requests.proposed_reply),
  reason = COALESCE(excluded.reason, approval_requests.reason),
  risk_json = excluded.risk_json,
  sidebar_json = COALESCE(excluded.sidebar_json, approval_requests.sidebar_json),
  visible_json = COALESCE(excluded.visible_json, approval_requests.visible_json),
  incoming_json = excluded.incoming_json,
  model = COALESCE(excluded.model, approval_requests.model),
  usage_json = COALESCE(excluded.usage_json, approval_requests.usage_json),
  prompt_stats_json = COALESCE(excluded.prompt_stats_json, approval_requests.prompt_stats_json),
  updated_at = excluded.updated_at;
`,
    { dbPath }
  );
  return getApprovalRequest(requestId, { dbPath });
}

export async function getApprovalRequest(id, { dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT *
FROM approval_requests
WHERE id = ${sqlValue(id)}
LIMIT 1;
`,
    { dbPath }
  );
  return rowToApprovalRequest(rows[0] || null);
}

function approvalStatusWhere(status) {
  if (!status || status === "open") {
    return `status IN (${APPROVAL_OPEN_STATUSES.map(sqlValue).join(", ")})`;
  }
  if (Array.isArray(status)) {
    return `status IN (${status.map(sqlValue).join(", ")})`;
  }
  return `status = ${sqlValue(status)}`;
}

export async function listApprovalRequests({ status = "open", limit = 20, dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT *
FROM approval_requests
WHERE ${approvalStatusWhere(status)}
ORDER BY updated_at DESC
LIMIT ${sqlValue(Math.max(1, Math.min(Number(limit) || 20, 200)))};
`,
    { dbPath }
  );
  return rows.map(rowToApprovalRequest);
}

export async function countApprovalRequests({ status = "open", dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT count(*) AS count
FROM approval_requests
WHERE ${approvalStatusWhere(status)};
`,
    { dbPath }
  );
  return Number(rows[0]?.count || 0);
}

export async function summarizeApprovalRequests({ dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT status, count(*) AS count, max(updated_at) AS latest_at
FROM approval_requests
GROUP BY status
ORDER BY latest_at DESC;
`,
    { dbPath }
  );
  return rows.map((row) => ({
    status: row.status,
    count: Number(row.count || 0),
    latestAt: row.latest_at || null,
  }));
}

export async function recordApprovalDecision({
  id,
  status,
  action = null,
  userResponseText = null,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  if (!id) throw new Error("recordApprovalDecision requires id.");
  if (!status) throw new Error("recordApprovalDecision requires status.");
  const at = nowIso();
  await runSql(
    `
UPDATE approval_requests
SET
  status = ${sqlValue(status)},
  action = COALESCE(${sqlValue(action)}, action),
  user_response_text = COALESCE(${sqlValue(userResponseText)}, user_response_text),
  decided_at = ${sqlValue(at)},
  updated_at = ${sqlValue(at)}
WHERE id = ${sqlValue(id)};
`,
    { dbPath }
  );
  return getApprovalRequest(id, { dbPath });
}

export async function markApprovalSent({
  id,
  status = "sent",
  sendResult = null,
  dbPath = DEFAULT_MEMORY_DB_PATH,
}) {
  await ensureMemoryDb(dbPath);
  if (!id) throw new Error("markApprovalSent requires id.");
  const at = nowIso();
  await runSql(
    `
UPDATE approval_requests
SET
  status = ${sqlValue(status)},
  send_result_json = ${sqlJson(sendResult || null)},
  sent_at = CASE WHEN ${sqlValue(status)} = 'sent' THEN ${sqlValue(at)} ELSE sent_at END,
  updated_at = ${sqlValue(at)}
WHERE id = ${sqlValue(id)};
`,
    { dbPath }
  );
  return getApprovalRequest(id, { dbPath });
}

export async function listRecentDrafts({ limit = 10, dbPath = DEFAULT_MEMORY_DB_PATH } = {}) {
  await ensureMemoryDb(dbPath);
  const rows = await queryJson(
    `
SELECT id, conversation_slug, latest_hash, action, reply_text, reason, send_ok, send_message,
  model, usage_json, prompt_stats_json, sidebar_json, created_at
FROM drafts
ORDER BY created_at DESC
LIMIT ${sqlValue(Math.max(1, Math.min(Number(limit) || 10, 100)))};
`,
    { dbPath }
  );
  return rows.map((row) => ({
    id: row.id,
    conversationSlug: row.conversation_slug,
    latestHash: row.latest_hash || null,
    action: row.action,
    replyText: row.reply_text || null,
    reason: row.reason || null,
    sendOk: row.send_ok === null || row.send_ok === undefined ? null : Boolean(row.send_ok),
    sendMessage: row.send_message || null,
    model: row.model || null,
    usage: parseJsonField(row.usage_json, null),
    promptStats: parseJsonField(row.prompt_stats_json, null),
    sidebar: parseJsonField(row.sidebar_json, null),
    createdAt: row.created_at,
  }));
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
