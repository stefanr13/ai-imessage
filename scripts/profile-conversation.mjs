#!/usr/bin/env node
import { fallbackContactForSidebar, findSidebarContact, visibleTitleMatchesSidebar } from "../src/contact-utils.mjs";
import { getContact, loadConfig } from "../src/config.mjs";
import { refreshConversationProfile } from "../src/memory-profile.mjs";
import { getMemoryContext, ingestVisibleConversation } from "../src/memory-store.mjs";
import { messagesAx } from "../src/messages-ax.mjs";
import { splitSidebarDescription } from "../src/sidebar.mjs";

function usage() {
  console.error("Usage: node scripts/profile-conversation.mjs <contact-slug> [--no-refresh]");
  process.exit(2);
}

function contactMatchesDescription(config, slug, description) {
  const sidebar = splitSidebarDescription(description);
  if (!sidebar) return false;
  const match = findSidebarContact(config, sidebar);
  return match?.slug === slug;
}

async function openConfiguredConversation({ config, slug, contact }) {
  const list = await messagesAx.listConversations();
  if (!list.ok) throw new Error("Could not list Messages conversations.");

  const exact = (list.items || []).find((item) => contactMatchesDescription(config, slug, item.description));
  if (exact) {
    const sidebar = splitSidebarDescription(exact.description);
    const backgroundOpen = await messagesAx.openSidebar(exact.description, { background: true });
    if (backgroundOpen.ok) {
      const visible = await messagesAx.readVisible();
      if (visible.ok && visibleTitleMatchesSidebar(visible, sidebar)) {
        return { sidebar, visible, opened: backgroundOpen };
      }
    }

    const foregroundOpen = await messagesAx.openSidebar(exact.description);
    if (!foregroundOpen.ok) throw new Error(`Could not open sidebar conversation: ${foregroundOpen.message}`);
    const visible = await messagesAx.readVisible();
    return { sidebar, visible, opened: foregroundOpen };
  }

  const opened = await messagesAx.open(contact.searchName || contact.displayName, contact.resultName || contact.displayName);
  if (!opened.ok) throw new Error(`Could not open configured conversation: ${opened.message}`);
  const visible = await messagesAx.readVisible();
  const sidebar = {
    title: contact.resultName || contact.displayName,
    hasUnread: false,
    preview: "",
    timeLabel: "",
  };
  return { sidebar, visible, opened };
}

async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith("--")) usage();
  const refresh = !process.argv.includes("--no-refresh");
  const config = await loadConfig();
  const contact = getContact(config, slug);

  const { sidebar, visible, opened } = await openConfiguredConversation({ config, slug, contact });
  if (!visible.ok) throw new Error("Could not read visible conversation.");

  const match = findSidebarContact(config, sidebar) || fallbackContactForSidebar(sidebar);
  const ingest = await ingestVisibleConversation({
    slug: match.slug,
    contact: match.contact,
    visible,
    sidebarTitle: sidebar.title,
    source: "profile-conversation",
  });

  const profileResult = refresh
    ? await refreshConversationProfile({ slug: match.slug, contact: match.contact, force: true })
    : null;
  const memory = await getMemoryContext({ slug: match.slug, contact: match.contact });

  console.log(
    JSON.stringify(
      {
        ok: true,
        slug: match.slug,
        opened: opened.message,
        title: visible.conversationTitle,
        ingested: ingest,
        refreshedProfile: profileResult
          ? {
              refreshed: profileResult.refreshed,
              sourceMessageCount: profileResult.sourceMessageCount,
              sourceExampleCount: profileResult.sourceExampleCount,
              confidence: profileResult.profile?.confidence || null,
              usage: profileResult.usage || null,
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
