#!/usr/bin/env node
import { execFile } from "node:child_process";
import { findSidebarContact, fallbackContactForSidebar, visibleTitleMatchesSidebar } from "../src/contact-utils.mjs";
import { enabledContactSlugs, getContact, loadConfig } from "../src/config.mjs";
import { buildConversationMemory } from "../src/memory-index.mjs";
import {
  getConversationMemoryStatus,
  ingestVisibleConversation,
  listConversationMemoryStatuses,
  purgeExcludedStyleExamples,
} from "../src/memory-store.mjs";
import { messagesAx } from "../src/messages-ax.mjs";
import { splitSidebarDescription } from "../src/sidebar.mjs";
import { messageFingerprint, stableHash } from "../src/transcript.mjs";

function usage() {
  console.error(`Usage:
  node scripts/index-sidebar-chats.mjs [--count 10] [--min-messages 10] [--limit 300] [--max-pages 70] [--max-sidebar-pages 12] [--skip-existing] [--no-refresh]

Indexes the next eligible Messages sidebar conversations into local memory.
Eligibility defaults to at least 10 stored messages with both incoming and outgoing messages.
Non-configured chats are stored with autoSend=false.
`);
  process.exit(2);
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

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000 }, (error) => resolve({ ok: !error, error }));
  });
}

function pageFingerprint(visible) {
  return stableHash({
    title: visible.conversationTitle,
    messages: (visible.messages || []).map((message) => messageFingerprint(message)),
  });
}

function cleanMessages(messages) {
  const seen = new Set();
  const unique = [];
  for (const message of messages) {
    const hash = messageFingerprint(message);
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    unique.push(message);
  }
  return unique;
}

function directionCounts(messages) {
  return messages.reduce(
    (counts, message) => {
      if (message.direction === "incoming") counts.incoming += 1;
      if (message.direction === "outgoing") counts.outgoing += 1;
      return counts;
    },
    { incoming: 0, outgoing: 0 }
  );
}

function contactForSidebar(config, sidebar) {
  const configured = findSidebarContact(config, sidebar);
  if (configured) return configured;
  return fallbackContactForSidebar(sidebar);
}

async function listSidebarConversations() {
  let list = await messagesAx.listConversations({ activate: true });
  if (!list.ok || !(list.items || []).length) {
    await runCommand("open", ["-b", "com.apple.MobileSMS"]);
    await sleep(1500);
    try {
      await messagesAx.clearSearch();
    } catch {
      // Best effort; the retry reports whether Messages recovered.
    }
    list = await messagesAx.listConversations({ activate: true });
  }
  if (!list.ok) throw new Error(`Could not list Messages conversations: ${list.message || "unknown error"}`);
  return list.items || [];
}

async function settleToNewest(sidebar) {
  let visible = await messagesAx.readVisible({ main: true });
  if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) return visible;

  let previous = null;
  for (let index = 0; index < 12; index += 1) {
    const current = pageFingerprint(visible);
    if (current === previous) break;
    previous = current;
    const scroll = await messagesAx.scrollTranscript("newer", { pages: 1 });
    if (!scroll.ok) break;
    visible = await messagesAx.readVisible({ main: true });
    if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) break;
  }
  return visible;
}

async function readHistory({ sidebar, limit, maxPages }) {
  const opened = sidebar.frame
    ? await messagesAx.clickPoint({
        x: sidebar.frame.x + sidebar.frame.width / 2,
        y: sidebar.frame.y + sidebar.frame.height / 2,
      })
    : await messagesAx.openSidebar(sidebar.description, { noClear: true });
  if (!opened.ok) throw new Error(`Could not open '${sidebar.title}': ${opened.message}`);
  const initialVisible = await messagesAx.readVisible({ main: true });
  if (!initialVisible.ok || !visibleTitleMatchesSidebar(initialVisible, sidebar)) {
    const messageCount = Array.isArray(initialVisible.messages) ? initialVisible.messages.length : 0;
    if (!initialVisible.ok || messageCount === 0) {
      throw new Error(`Opened '${sidebar.title}' but saw '${initialVisible.conversationTitle || "(none)"}'.`);
    }
  }

  const newestVisible = await settleToNewest(sidebar);
  const pages = [];
  const seenPages = new Set();
  let pagesRead = 0;
  let stagnantScrolls = 0;
  let visible = newestVisible.ok ? newestVisible : initialVisible;

  while (pagesRead < maxPages && cleanMessages(pages.flat()).length < limit) {
    const fingerprint = pageFingerprint(visible);
    if (seenPages.has(fingerprint)) {
      stagnantScrolls += 1;
    } else {
      seenPages.add(fingerprint);
      pagesRead += 1;
      pages.push(visible.messages || []);
      stagnantScrolls = 0;
    }

    if (cleanMessages(pages.flat()).length >= limit) break;
    if (stagnantScrolls >= 2) break;

    const scroll = await messagesAx.scrollTranscript("older", { pages: 1 });
    if (!scroll.ok) break;
    visible = await messagesAx.readVisible({ main: true });
    if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) {
      throw new Error(`Conversation changed while reading '${sidebar.title}'. Saw '${visible.conversationTitle || "(none)"}'.`);
    }
  }

  return {
    visibleTitle: initialVisible.conversationTitle,
    pagesRead,
    messages: cleanMessages([...pages].reverse().flat()).slice(-limit),
  };
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const config = await loadConfig();
  const count = argNumber("--count", 10);
  const minMessages = argNumber("--min-messages", 10);
  const limit = argNumber("--limit", Number(process.env.MEMORY_INDEX_MESSAGE_LIMIT || 300));
  const maxPages = argNumber("--max-pages", Number(process.env.HISTORY_MAX_PAGES || 70));
  const maxSidebarPages = argNumber("--max-sidebar-pages", 12);
  const skipExisting = hasFlag("--skip-existing");
  const refreshProfile = !hasFlag("--no-refresh");
  const configuredSlugs = new Set(enabledContactSlugs(config));
  const existing = new Map((await listConversationMemoryStatuses()).map((status) => [status.slug, status]));
  const results = [];
  const skipped = [];
  const seenSidebarDescriptions = new Set();
  let sidebarPagesRead = 0;

  while (results.length < count && sidebarPagesRead < maxSidebarPages) {
    const sidebarItems = await listSidebarConversations();
    const newItems = sidebarItems.filter((item) => item.description && !seenSidebarDescriptions.has(item.description));
    if (!newItems.length && sidebarPagesRead > 0) break;
    for (const item of newItems) {
      seenSidebarDescriptions.add(item.description);
      if (results.length >= count) break;
      const sidebar = splitSidebarDescription(item.description);
      if (!sidebar?.title) continue;
      sidebar.description = item.description;
      sidebar.frame = item.frame || null;
    const { slug, contact } = contactForSidebar(config, sidebar);
    const existingStatus = existing.get(slug) || (await getConversationMemoryStatus({ slug }));
    const latestStatus = existingStatus?.latestJob?.status || null;
    const hasCompletedIndex =
      existingStatus?.chunkCount > 0 && ["completed", "completed_with_warnings"].includes(latestStatus);
    if (skipExisting && hasCompletedIndex) {
      skipped.push({ slug, title: sidebar.title, reason: "already_indexed" });
      continue;
    }

    try {
      const history = await readHistory({ sidebar, limit, maxPages });
      const counts = directionCounts(history.messages);
      if (history.messages.length < minMessages || counts.incoming === 0 || counts.outgoing === 0) {
        skipped.push({
          slug,
          title: sidebar.title,
          reason: "not_enough_back_and_forth",
          messages: history.messages.length,
          incoming: counts.incoming,
          outgoing: counts.outgoing,
        });
        continue;
      }

      const syntheticVisible = {
        ok: true,
        trusted: true,
        conversationTitle: history.visibleTitle,
        messages: history.messages,
      };
      const safeContact = {
        ...contact,
        autoSend: configuredSlugs.has(slug) ? Boolean(contact.autoSend) : false,
      };
      const ingest = await ingestVisibleConversation({
        slug,
        contact: safeContact,
        visible: syntheticVisible,
        sidebarTitle: sidebar.title,
        source: "sidebar-history-ingest",
      });
      await purgeExcludedStyleExamples({ slug, contact: safeContact });
      const memory = await buildConversationMemory({
        slug,
        contact: safeContact,
        messageLimit: limit,
        refreshProfile,
      });
      results.push({
        slug,
        title: sidebar.title,
        configured: configuredSlugs.has(slug),
        autoSend: Boolean(safeContact.autoSend),
        messagesRead: history.messages.length,
        incoming: counts.incoming,
        outgoing: counts.outgoing,
        pagesRead: history.pagesRead,
        ingested: ingest,
        chunkCount: memory.chunkCount,
        embeddedChunkCount: memory.embeddedChunkCount,
        summarizedChunkCount: memory.summarizedChunkCount,
        latestJobStatus: memory.status?.latestJob?.status || null,
        profileConfidence: memory.status?.profile?.confidence || null,
      });
    } catch (error) {
      skipped.push({ slug, title: sidebar.title, reason: "error", error: error.message });
    }
  }
    sidebarPagesRead += 1;
    if (results.length >= count || sidebarPagesRead >= maxSidebarPages) break;
    const scroll = await messagesAx.scrollSidebar("older", { pages: 2 });
    if (!scroll.ok) {
      skipped.push({ slug: null, title: null, reason: "sidebar-scroll-failed", error: scroll.message || "unknown" });
      break;
    }
    await sleep(600);
  }

  console.log(
    JSON.stringify({ ok: true, requested: count, indexed: results.length, sidebarPagesRead, results, skipped }, null, 2)
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
