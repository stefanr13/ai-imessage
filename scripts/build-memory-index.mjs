#!/usr/bin/env node
import { execFile } from "node:child_process";
import { getContact, loadConfig, enabledContactSlugs } from "../src/config.mjs";
import { buildConversationMemory } from "../src/memory-index.mjs";
import { getConversationMemoryStatus, listConversationMemoryStatuses } from "../src/memory-store.mjs";
import { DEFAULT_EMBEDDING_MODEL } from "../src/ollama-client.mjs";

function usage() {
  console.error(`Usage:
  node scripts/build-memory-index.mjs <contact-slug> [--limit 300] [--chunk-size 36] [--ingest] [--max-pages 70] [--force]
  node scripts/build-memory-index.mjs --all-configured [--limit 300] [--ingest] [--force]

Options:
  --limit N            Stored messages to learn from. Default: 300.
  --chunk-size N       Messages per memory chunk. Default: 36.
  --chunk-overlap N    Overlap between chunks. Default: 4.
  --embedding-model M  Ollama embedding model. Default: ${DEFAULT_EMBEDDING_MODEL}.
  --ingest             Run scripts/ingest-history.mjs first for configured contacts.
  --max-pages N        Max Messages pages for --ingest. Default: 70.
  --skip-embeddings    Build summaries/profile only.
  --skip-summaries     Build embeddings/profile from raw chunks only.
  --no-refresh         Do not refresh the Gemma conversation profile.
  --force              Rebuild summaries/embeddings even if chunks already have them.
  --status             Print current memory status and exit.
`);
  process.exit(2);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function argNumber(name, fallback) {
  const parsed = Number(argValue(name, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runScript(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: Number(process.env.MEMORY_INDEX_INGEST_TIMEOUT_MS || 15 * 60 * 1000),
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

async function maybeIngest({ slug, limit, maxPages }) {
  await runScript("scripts/ingest-history.mjs", [
    slug,
    "--limit",
    String(limit),
    "--max-pages",
    String(maxPages),
    "--no-refresh",
  ]);
}

async function printStatus(slugs = null) {
  const statuses = await listConversationMemoryStatuses();
  const filtered = slugs ? statuses.filter((status) => slugs.includes(status.slug)) : statuses;
  console.log(JSON.stringify({ ok: true, conversations: filtered }, null, 2));
}

async function buildOne({ config, slug, options }) {
  const contact = getContact(config, slug);
  if (options.ingest) {
    await maybeIngest({ slug, limit: options.limit, maxPages: options.maxPages });
  }
  const result = await buildConversationMemory({
    slug,
    contact,
    messageLimit: options.limit,
    chunkSize: options.chunkSize,
    chunkOverlap: options.chunkOverlap,
    embeddingModel: options.embeddingModel,
    skipEmbeddings: options.skipEmbeddings,
    skipSummaries: options.skipSummaries,
    refreshProfile: options.refreshProfile,
    force: options.force,
  });
  return {
    slug,
    observedMessageCount: result.observedMessageCount,
    chunkCount: result.chunkCount,
    embeddedChunkCount: result.embeddedChunkCount,
    summarizedChunkCount: result.summarizedChunkCount,
    profileConfidence: result.profile?.profile?.confidence || result.status?.profile?.confidence || null,
    status: await getConversationMemoryStatus({ slug }),
  };
}

async function main() {
  const target = process.argv[2];
  if (!target || target.startsWith("--") && !["--all-configured", "--status"].includes(target)) usage();

  const config = await loadConfig();
  const options = {
    limit: argNumber("--limit", Number(process.env.MEMORY_INDEX_MESSAGE_LIMIT || 300)),
    chunkSize: argNumber("--chunk-size", Number(process.env.MEMORY_INDEX_CHUNK_SIZE || 36)),
    chunkOverlap: argNumber("--chunk-overlap", Number(process.env.MEMORY_INDEX_CHUNK_OVERLAP || 4)),
    maxPages: argNumber("--max-pages", Number(process.env.HISTORY_MAX_PAGES || 70)),
    embeddingModel: argValue("--embedding-model", DEFAULT_EMBEDDING_MODEL),
    ingest: hasFlag("--ingest"),
    skipEmbeddings: hasFlag("--skip-embeddings"),
    skipSummaries: hasFlag("--skip-summaries"),
    refreshProfile: !hasFlag("--no-refresh"),
    force: hasFlag("--force"),
  };

  const slugs = target === "--all-configured" ? enabledContactSlugs(config) : target === "--status" ? null : [target];
  if (hasFlag("--status") || target === "--status") {
    await printStatus(slugs);
    return;
  }

  const results = [];
  for (const slug of slugs) {
    results.push(await buildOne({ config, slug, options }));
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        options,
        results,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

