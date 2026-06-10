import { DEFAULT_MODEL } from "./decision.mjs";
import { refreshConversationProfile } from "./memory-profile.mjs";
import {
  getConversationMemoryStatus,
  listMemoryChunks,
  loadMessagesForMemory,
  saveConversationProfile,
  startMemoryIndexJob,
  updateMemoryChunkEmbedding,
  updateMemoryChunkSummary,
  updateMemoryIndexJob,
  upsertMemoryChunk,
} from "./memory-store.mjs";
import {
  DEFAULT_EMBEDDING_MODEL,
  assertOllamaModelAvailable,
  embedWithOllama,
  generateWithOllama,
  parseJsonResponse,
} from "./ollama-client.mjs";
import { normalizeComparableText, stableHash } from "./transcript.mjs";

const DEFAULT_MESSAGE_LIMIT = Number(process.env.MEMORY_INDEX_MESSAGE_LIMIT || 300);
const DEFAULT_CHUNK_SIZE = Number(process.env.MEMORY_INDEX_CHUNK_SIZE || 36);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.MEMORY_INDEX_CHUNK_OVERLAP || 4);
const DEFAULT_RETRIEVAL_LIMIT = Number(process.env.MEMORY_RETRIEVAL_LIMIT || 6);

const CHUNK_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    oneLineSummary: { type: "string" },
    peopleAndContext: { type: "array", items: { type: "string" }, maxItems: 5 },
    userToneSignals: { type: "array", items: { type: "string" }, maxItems: 5 },
    relationshipFacts: { type: "array", items: { type: "string" }, maxItems: 5 },
    recurringTopics: { type: "array", items: { type: "string" }, maxItems: 5 },
    approvalTriggers: { type: "array", items: { type: "string" }, maxItems: 5 },
    goodStyleExamples: {
      type: "array",
      items: {
        type: "object",
        properties: {
          incoming: { type: "string" },
          userReply: { type: "string" },
          why: { type: "string" },
        },
        required: ["incoming", "userReply", "why"],
        additionalProperties: false,
      },
      maxItems: 3,
    },
    doNotImitate: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
  required: [
    "oneLineSummary",
    "peopleAndContext",
    "userToneSignals",
    "relationshipFacts",
    "recurringTopics",
    "approvalTriggers",
    "goodStyleExamples",
    "doNotImitate",
  ],
  additionalProperties: false,
};

const CHUNK_SUMMARY_SYSTEM = `You build compact memory notes for a local text-message assistant.
Return strict JSON only with exactly the requested keys.
Use only the provided conversation chunk.
Separate durable context from one-off logistics.
Extract how the user replies, not generic advice.
Mark anything involving plans, commitments, money, medical/legal, private facts, or uncertainty as approvalTriggers.
Do not mark simple thanks, casual reactions, or low-risk acknowledgements as approval triggers.
Keep doNotImitate about writing style failures only; do not put source citations there.
Do not invent facts.`;

function boundedInt(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function trimText(value, maxChars = 4000) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}[trimmed ${text.length - maxChars} chars]`;
}

function speakerFor(message, contact = {}) {
  if (message.direction === "outgoing") return "Me";
  return contact.displayName || contact.conversationTitle || "Them";
}

function formatMessages(messages, contact = {}) {
  return messages
    .map((message) => {
      const observed = message.observedAt ? ` (${message.observedAt})` : "";
      return `${speakerFor(message, contact)}${observed}: ${String(message.text || "").trim()}`;
    })
    .join("\n");
}

function chunkMessages(messages, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const size = boundedInt(chunkSize, DEFAULT_CHUNK_SIZE, { min: 8, max: 80 });
  const overlapCount = boundedInt(overlap, DEFAULT_CHUNK_OVERLAP, { min: 0, max: Math.max(0, size - 1) });
  const step = Math.max(1, size - overlapCount);
  const chunks = [];
  for (let start = 0; start < messages.length; start += step) {
    const slice = messages.slice(start, start + size);
    if (!slice.length) break;
    chunks.push(slice);
    if (start + size >= messages.length) break;
  }
  return chunks;
}

function normalizeSummary(summary) {
  const list = (value, maxItems = 5, maxChars = 160) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => trimText(entry, maxChars).trim())
      .filter(Boolean)
      .slice(0, maxItems);
  return {
    oneLineSummary: trimText(summary?.oneLineSummary, 240).trim(),
    peopleAndContext: list(summary?.peopleAndContext),
    userToneSignals: list(summary?.userToneSignals),
    relationshipFacts: list(summary?.relationshipFacts),
    recurringTopics: list(summary?.recurringTopics),
    approvalTriggers: list(summary?.approvalTriggers),
    goodStyleExamples: (Array.isArray(summary?.goodStyleExamples) ? summary.goodStyleExamples : [])
      .map((example) => ({
        incoming: trimText(example?.incoming, 220).trim(),
        userReply: trimText(example?.userReply, 220).trim(),
        why: trimText(example?.why, 180).trim(),
      }))
      .filter((example) => example.incoming && example.userReply)
      .slice(0, 5),
    doNotImitate: list(summary?.doNotImitate),
  };
}

function fallbackChunkSummary(chunk, error) {
  return {
    oneLineSummary: `Conversation chunk ${chunk.chunkIndex + 1} with ${chunk.messageCount} messages.`,
    peopleAndContext: [],
    userToneSignals: [],
    relationshipFacts: [],
    recurringTopics: [],
    approvalTriggers: ["Ask before plans, commitments, money, sensitive facts, or unclear preferences."],
    goodStyleExamples: [],
    doNotImitate: [],
    summaryError: error.message,
  };
}

async function summarizeChunk({ chunk, contact }) {
  const prompt = JSON.stringify(
    {
      task: "Extract durable memory notes from this conversation chunk.",
      contact: {
        displayName: contact.displayName,
        relationship: contact.relationship || null,
        configuredStyleProfile: contact.styleProfile || null,
      },
      conversationChunk: trimText(chunk.text, Number(process.env.MEMORY_CHUNK_PROMPT_MAX_CHARS || 6000)),
      outputGuidance: [
        "Use facts only if the chunk supports them.",
        "Prefer repeated or durable context over one-off logistics.",
        "For style, focus on the user's outgoing replies.",
        "Good style examples should be short incoming-to-user-reply pairs.",
        "Approval triggers should be phrased as reusable rules.",
        "Approval triggers should not include simple low-risk offers or acknowledgements unless they require the user's preference or commitment.",
        "doNotImitate should only contain style patterns to avoid.",
      ],
    },
    null,
    2
  );
  const result = await generateWithOllama({
    model: DEFAULT_MODEL,
    system: CHUNK_SUMMARY_SYSTEM,
    prompt,
    format: CHUNK_SUMMARY_SCHEMA,
    options: {
      temperature: 0,
      num_ctx: boundedInt(process.env.MEMORY_CHUNK_NUM_CTX, 8192, { min: 2048, max: 32768 }),
      num_predict: boundedInt(process.env.MEMORY_CHUNK_NUM_PREDICT, 480, { min: 192, max: 1200 }),
    },
    timeoutMs: boundedInt(process.env.MEMORY_CHUNK_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS, 120_000, {
      min: 10_000,
      max: 600_000,
    }),
  });
  return {
    summary: normalizeSummary(parseJsonResponse(result.text)),
    model: result.model,
    usage: result.usage,
  };
}

function memoryNotesFromChunks(chunks) {
  return chunks
    .filter((chunk) => chunk.summary && Object.keys(chunk.summary).length)
    .map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      messageCount: chunk.messageCount,
      startObservedAt: chunk.startObservedAt,
      endObservedAt: chunk.endObservedAt,
      summary: chunk.summary,
    }));
}

function uniqueStrings(values, { maxItems = 8, maxChars = 180 } = {}) {
  const seen = new Set();
  const output = [];
  for (const value of values.flat()) {
    const text = trimText(value, maxChars).trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(text);
    if (output.length >= maxItems) break;
  }
  return output;
}

function collectSummaryList(notes, key, options = {}) {
  return uniqueStrings(
    notes.map((note) => {
      const value = note.summary?.[key];
      return Array.isArray(value) ? value : value ? [value] : [];
    }),
    options
  );
}

function fallbackProfileFromMemoryNotes({ contact = {}, notes = [], messageCount = 0 } = {}) {
  const summaries = uniqueStrings(notes.map((note) => note.summary?.oneLineSummary || ""), {
    maxItems: 3,
    maxChars: 160,
  });
  const toneSignals = collectSummaryList(notes, "userToneSignals", { maxItems: 8, maxChars: 160 });
  const relationshipFacts = collectSummaryList(notes, "relationshipFacts", { maxItems: 6, maxChars: 150 });
  const topics = collectSummaryList(notes, "recurringTopics", { maxItems: 8, maxChars: 140 });
  const approvalTriggers = collectSummaryList(notes, "approvalTriggers", { maxItems: 8, maxChars: 170 });
  const doNotImitate = collectSummaryList(notes, "doNotImitate", { maxItems: 10, maxChars: 170 });
  const relationshipParts = [
    contact.relationship ? `Relationship: ${contact.relationship}.` : "",
    ...relationshipFacts.slice(0, 3),
    ...summaries.slice(0, 1),
  ].filter(Boolean);
  const toneParts = toneSignals.length
    ? toneSignals.slice(0, 4)
    : ["Use concise, natural replies grounded in this conversation's examples."];
  const standardApprovalTriggers = [
    "Ask before plans, commitments, money, sensitive family decisions, medical/legal advice, or unclear preferences.",
  ];

  return {
    relationshipSummary: trimText(
      relationshipParts.join(" ") || "Conversation profile built from local memory chunks.",
      240
    ).trim(),
    toneSummary: trimText(toneParts.join("; "), 280).trim(),
    userVoiceRules: uniqueStrings(
      [
        toneSignals,
        contact.styleProfile ? ["Prefer short, specific, casual replies over polished summaries."] : [],
        ["Answer the active message directly and avoid over-addressing stale context."],
      ],
      { maxItems: 8, maxChars: 180 }
    ),
    typicalReplyLength: "Prefer concise replies; expand only when the latest message clearly needs detail.",
    emojiStyle: "Do not add emoji unless recent examples or the latest message support it.",
    punctuationStyle: "Use natural, sparse punctuation; avoid polished assistant cadence.",
    nicknamesAndPetNames: [],
    recurringTopics: topics,
    insideJokesOrReferences: [],
    doNotImitate: uniqueStrings(
      [doNotImitate, ["ChatGPT-style recaps", "generic enthusiasm", "stale one-off logistics"]],
      { maxItems: 10, maxChars: 180 }
    ),
    askUserBefore: uniqueStrings([approvalTriggers, standardApprovalTriggers], { maxItems: 8, maxChars: 180 }),
    confidence: notes.length >= 3 && messageCount >= 80 ? "medium" : "low",
  };
}

async function saveFallbackProfileFromMemoryNotes({ slug, contact, notes, messageCount }) {
  const profile = fallbackProfileFromMemoryNotes({ contact, notes, messageCount });
  await saveConversationProfile({
    slug,
    profile,
    model: `${DEFAULT_MODEL}:chunk-notes`,
    usage: null,
    sourceMessageCount: messageCount,
    sourceExampleCount: 0,
  });
  return {
    refreshed: true,
    fallback: true,
    profile,
    model: `${DEFAULT_MODEL}:chunk-notes`,
    usage: null,
    sourceMessageCount: messageCount,
    sourceExampleCount: 0,
  };
}

function embeddingInputForChunk(chunk) {
  const summary = chunk.summary?.oneLineSummary ? `Summary: ${chunk.summary.oneLineSummary}\n` : "";
  return `search_document: ${summary}${chunk.text}`;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -Infinity;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = Number(a[index] || 0);
    const bv = Number(b[index] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return -Infinity;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function buildConversationMemory({
  slug,
  contact = {},
  messageLimit = DEFAULT_MESSAGE_LIMIT,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  skipEmbeddings = false,
  skipSummaries = false,
  refreshProfile = true,
  force = false,
} = {}) {
  if (!slug) throw new Error("buildConversationMemory requires slug.");
  const targetMessageCount = boundedInt(messageLimit, DEFAULT_MESSAGE_LIMIT, { min: 1, max: 2000 });
  const messages = await loadMessagesForMemory({ slug, limit: targetMessageCount });
  const job = await startMemoryIndexJob({
    slug,
    targetMessageCount,
    observedMessageCount: messages.length,
    embeddingModel: skipEmbeddings ? null : embeddingModel,
    profileModel: refreshProfile ? DEFAULT_MODEL : null,
    options: {
      chunkSize,
      chunkOverlap,
      skipEmbeddings,
      skipSummaries,
      refreshProfile,
      force,
    },
  });

  try {
    if (!messages.length) throw new Error(`No stored messages for '${slug}'. Run ingest-history first.`);
    if (!skipEmbeddings) await assertOllamaModelAvailable(embeddingModel);

    const chunkSlices = chunkMessages(messages, { chunkSize, overlap: chunkOverlap });
    const chunks = [];
    for (const [index, slice] of chunkSlices.entries()) {
      const sourceMessageIds = slice.map((message) => message.id);
      const text = formatMessages(slice, contact);
      const id = stableHash({
        type: "memory-chunk",
        slug,
        sourceMessageIds,
        textHash: normalizeComparableText(text),
      });
      const chunk = await upsertMemoryChunk({
        id,
        conversationSlug: slug,
        chunkIndex: index,
        sourceMessageIds,
        startObservedAt: slice[0]?.observedAt || null,
        endObservedAt: slice.at(-1)?.observedAt || null,
        messageCount: slice.length,
        text,
      });
      chunks.push(chunk);
    }

    await updateMemoryIndexJob({ id: job.id, chunkCount: chunks.length, observedMessageCount: messages.length });

    let embeddedChunkCount = 0;
    let summarizedChunkCount = 0;
    const processedChunks = [];
    for (const chunk of chunks) {
      let current = chunk;
      if (!skipSummaries && (force || !current.summarizedAt)) {
        let summary;
        try {
          summary = await summarizeChunk({ chunk: current, contact });
        } catch (error) {
          summary = {
            summary: fallbackChunkSummary(current, error),
            model: `${DEFAULT_MODEL}:fallback`,
            usage: null,
          };
        }
        current = await updateMemoryChunkSummary({
          id: current.id,
          summary: summary.summary,
          model: summary.model,
          usage: summary.usage,
        });
      }
      if (current.summarizedAt) summarizedChunkCount += 1;

      if (!skipEmbeddings && (force || !current.embeddedAt || current.embeddingModel !== embeddingModel)) {
        const embedding = await embedWithOllama({
          model: embeddingModel,
          input: embeddingInputForChunk(current),
          options: {
            num_ctx: boundedInt(process.env.EMBEDDING_NUM_CTX, 8192, { min: 512, max: 32768 }),
          },
        });
        current = await updateMemoryChunkEmbedding({
          id: current.id,
          embedding: embedding.embeddings[0],
          model: embedding.model,
        });
      }
      if (current.embeddedAt) embeddedChunkCount += 1;
      processedChunks.push(current);
      await updateMemoryIndexJob({
        id: job.id,
        chunkCount: chunks.length,
        embeddedChunkCount,
        summarizedChunkCount,
      });
    }

    let profile = null;
    let profileError = null;
    const profileMemoryNotes = memoryNotesFromChunks(processedChunks);
    if (refreshProfile) {
      try {
        profile = await refreshConversationProfile({
          slug,
          contact,
          force: true,
          messageLimit: targetMessageCount,
          exampleLimit: Number(process.env.MEMORY_INDEX_PROFILE_EXAMPLES || 60),
          memoryNotes: profileMemoryNotes,
        });
      } catch (error) {
        profileError = error.message;
        if (profileMemoryNotes.length) {
          try {
            profile = await saveFallbackProfileFromMemoryNotes({
              slug,
              contact,
              notes: profileMemoryNotes,
              messageCount: messages.length,
            });
          } catch (fallbackError) {
            profileError = `${profileError}; fallback profile save failed: ${fallbackError.message}`;
          }
        }
      }
    }

    const completedJob = await updateMemoryIndexJob({
      id: job.id,
      status: profileError ? "completed_with_warnings" : "completed",
      observedMessageCount: messages.length,
      chunkCount: chunks.length,
      embeddedChunkCount,
      summarizedChunkCount,
      error: profileError ? `Profile refresh failed: ${profileError}` : null,
      completed: true,
    });

    return {
      ok: true,
      slug,
      job: completedJob,
      targetMessageCount,
      observedMessageCount: messages.length,
      chunkCount: chunks.length,
      embeddedChunkCount,
      summarizedChunkCount,
      profile,
      profileError,
      status: await getConversationMemoryStatus({ slug }),
    };
  } catch (error) {
    await updateMemoryIndexJob({
      id: job.id,
      status: "failed",
      error: error.message,
      completed: true,
    });
    throw error;
  }
}

export async function retrieveRelevantMemory({
  slug,
  query,
  limit = DEFAULT_RETRIEVAL_LIMIT,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
} = {}) {
  if (!slug || !String(query || "").trim()) return [];
  const chunks = await listMemoryChunks({ slug, limit: 2000, includeText: false, includeEmbedding: true });
  const indexed = chunks.filter((chunk) => chunk.embeddingModel === embeddingModel && Array.isArray(chunk.embedding));
  if (!indexed.length) return [];
  const queryEmbedding = await embedWithOllama({
    model: embeddingModel,
    input: `search_query: ${query}`,
    options: {
      num_ctx: boundedInt(process.env.EMBEDDING_NUM_CTX, 8192, { min: 512, max: 32768 }),
    },
  });
  const vector = queryEmbedding.embeddings[0];
  return indexed
    .map((chunk) => ({
      ...chunk,
      score: cosineSimilarity(vector, chunk.embedding),
      embedding: undefined,
    }))
    .filter((chunk) => Number.isFinite(chunk.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, boundedInt(limit, DEFAULT_RETRIEVAL_LIMIT, { min: 1, max: 20 }));
}
