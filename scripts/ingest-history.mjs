#!/usr/bin/env node
import { execFile } from "node:child_process";
import { findSidebarContact, visibleTitleMatchesSidebar } from "../src/contact-utils.mjs";
import { getContact, loadConfig } from "../src/config.mjs";
import { refreshConversationProfile } from "../src/memory-profile.mjs";
import {
  getMemoryContext,
  ingestVisibleConversation,
  purgeExcludedStyleExamples,
} from "../src/memory-store.mjs";
import { messagesAx } from "../src/messages-ax.mjs";
import { splitSidebarDescription } from "../src/sidebar.mjs";
import { messageFingerprint, stableHash } from "../src/transcript.mjs";

function usage() {
  console.error("Usage: node scripts/ingest-history.mjs <contact-slug> [--limit N] [--max-pages N] [--no-refresh]");
  process.exit(2);
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pageFingerprint(visible) {
  return stableHash({
    title: visible.conversationTitle,
    messages: (visible.messages || []).map((message) => messageFingerprint(message)),
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000 }, (error) => resolve({ ok: !error, error }));
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

function contactMatchesDescription(config, slug, description) {
  const sidebar = splitSidebarDescription(description);
  if (!sidebar) return false;
  const match = findSidebarContact(config, sidebar);
  return match?.slug === slug;
}

function matchingConfiguredVisibleTitle(visible, contact) {
  const aliases = [
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
  return aliases.find((title) => visibleTitleMatchesSidebar(visible, { title })) || null;
}

async function openConfiguredConversation({ config, slug, contact }) {
  let list = await messagesAx.listConversations({ activate: true });
  if (!list.ok || !(list.items || []).length) {
    await runCommand("open", ["-b", "com.apple.MobileSMS"]);
    await sleep(1500);
    try {
      await messagesAx.clearSearch();
    } catch {
      // Best effort; the retry below reports whether Messages recovered.
    }
    list = await messagesAx.listConversations({ activate: true });
  }
  if (!list.ok) throw new Error("Could not list Messages conversations.");

  if (!(list.items || []).length) {
    const visible = await messagesAx.readVisible();
    const matchedTitle = visible.ok ? matchingConfiguredVisibleTitle(visible, contact) : null;
    if (visible.ok && matchedTitle) {
      return {
        sidebar: {
          title: matchedTitle,
          hasUnread: false,
          preview: "",
          timeLabel: "",
        },
        visible,
        opened: { ok: true, message: "Using currently visible configured conversation." },
      };
    }
  }

  const row = (list.items || []).find((item) => contactMatchesDescription(config, slug, item.description));
  if (row) {
    const sidebar = splitSidebarDescription(row.description);
    const foregroundOpen = await messagesAx.openSidebar(row.description);
    if (!foregroundOpen.ok) throw new Error(`Could not open sidebar conversation: ${foregroundOpen.message}`);
    const visible = await messagesAx.readVisible();
    if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) {
      throw new Error(`Opened conversation did not match ${slug}. Saw ${visible.conversationTitle || "(none)"}`);
    }
    return { sidebar, visible, opened: foregroundOpen };
  }

  const opened = await messagesAx.open(contact.searchName || contact.displayName, contact.resultName || contact.displayName);
  if (!opened.ok) throw new Error(`Could not open configured conversation: ${opened.message}`);
  const visible = await messagesAx.readVisible();
  return {
    sidebar: {
      title: contact.resultName || contact.displayName,
      hasUnread: false,
      preview: "",
      timeLabel: "",
    },
    visible,
    opened,
  };
}

async function settleToNewest({ sidebar, maxScrolls = 12 }) {
  let visible = await messagesAx.readVisible();
  if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) return visible;

  let previous = null;
  for (let index = 0; index < maxScrolls; index += 1) {
    const current = pageFingerprint(visible);
    if (current === previous) break;
    previous = current;
    const scroll = await messagesAx.scrollTranscript("newer", { pages: 1 });
    if (!scroll.ok) break;
    visible = await messagesAx.readVisible();
    if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) break;
  }
  return visible;
}

async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith("--")) usage();

  const limit = argValue("--limit", Number(process.env.HISTORY_LIMIT || 150));
  const maxPages = argValue("--max-pages", Number(process.env.HISTORY_MAX_PAGES || 40));
  const refresh = !process.argv.includes("--no-refresh");

  const config = await loadConfig();
  const contact = getContact(config, slug);
  const { sidebar, visible: initialVisible, opened } = await openConfiguredConversation({ config, slug, contact });
  const newestVisible = await settleToNewest({ sidebar });

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
    visible = await messagesAx.readVisible();
    if (!visible.ok || !visibleTitleMatchesSidebar(visible, sidebar)) {
      throw new Error(`Conversation changed during history ingestion. Saw ${visible.conversationTitle || "(none)"}`);
    }
  }

  const uniqueMessages = cleanMessages([...pages].reverse().flat()).slice(-limit);
  const syntheticVisible = {
    ok: true,
    trusted: true,
    conversationTitle: initialVisible.conversationTitle,
    messages: uniqueMessages,
  };
  const ingest = await ingestVisibleConversation({
    slug,
    contact,
    visible: syntheticVisible,
    sidebarTitle: sidebar.title,
    source: "history-ingest",
  });
  const purge = await purgeExcludedStyleExamples({ slug, contact });
  const profile = refresh ? await refreshConversationProfile({ slug, contact, force: true }) : null;
  const memory = await getMemoryContext({ slug, contact });

  console.log(
    JSON.stringify(
      {
        ok: true,
        slug,
        opened: opened.message,
      title: initialVisible.conversationTitle,
        limit,
        maxPages,
        pagesRead,
        uniqueMessages: uniqueMessages.length,
        ingested: ingest,
        purged: purge,
        refreshedProfile: profile
          ? {
              refreshed: profile.refreshed,
              sourceMessageCount: profile.sourceMessageCount,
              sourceExampleCount: profile.sourceExampleCount,
              confidence: profile.profile?.confidence || null,
              usage: profile.usage,
            }
          : false,
        memory: {
          hasProfile: Boolean(memory.profile),
          profileUpdatedAt: memory.profileUpdatedAt,
          styleExamples: memory.styleExamples.length,
        },
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
