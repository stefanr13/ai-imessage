#!/usr/bin/env node
import { findSidebarContact, visibleTitleMatchesSidebar } from "../src/contact-utils.mjs";
import { getContact, loadConfig } from "../src/config.mjs";
import { loadIdentityEvidence, recordIdentityBundle, upsertConversation } from "../src/memory-store.mjs";
import { messagesAx } from "../src/messages-ax.mjs";
import { splitSidebarDescription } from "../src/sidebar.mjs";

function usage() {
  console.error("Usage: node scripts/extract-identity.mjs <contact-slug>");
  process.exit(2);
}

function maskPhone(value) {
  return String(value || "").replace(/\d(?=\d{2})/g, "*");
}

function maskEmail(value) {
  const [user, domain] = String(value || "").split("@");
  if (!domain) return value;
  const maskedUser = user.length <= 2 ? `${user[0] || ""}*` : `${user[0]}${"*".repeat(user.length - 2)}${user.at(-1)}`;
  return `${maskedUser}@${domain}`;
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

  const row = (list.items || []).find((item) => contactMatchesDescription(config, slug, item.description));
  if (row) {
    const sidebar = splitSidebarDescription(row.description);
    const backgroundOpen = await messagesAx.openSidebar(row.description, { background: true });
    if (backgroundOpen.ok) {
      const visible = await messagesAx.readVisible();
      if (visible.ok && visibleTitleMatchesSidebar(visible, sidebar)) {
        return { sidebar, visible, opened: backgroundOpen };
      }
    }
    const foregroundOpen = await messagesAx.openSidebar(row.description);
    if (!foregroundOpen.ok) throw new Error(`Could not open sidebar conversation: ${foregroundOpen.message}`);
    const visible = await messagesAx.readVisible();
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

async function main() {
  const slug = process.argv[2];
  if (!slug || slug.startsWith("--")) usage();

  const config = await loadConfig();
  const contact = getContact(config, slug);
  const { sidebar, visible, opened } = await openConfiguredConversation({ config, slug, contact });
  if (!visible.ok) throw new Error("Could not read visible conversation.");

  await upsertConversation({
    slug,
    contact,
    sidebarTitle: sidebar.title || visible.conversationTitle || null,
  });

  const identity = await messagesAx.identity();
  if (!identity.ok) throw new Error(identity.message || "Could not read Messages identity details.");

  const stored = await recordIdentityBundle({
    slug,
    identity: {
      ...identity,
      uiTitles: [...new Set([visible.conversationTitle, sidebar.title, ...(identity.uiTitles || [])].filter(Boolean))],
    },
    source: "messages-ui-details",
  });
  const evidence = await loadIdentityEvidence({ slug });

  console.log(
    JSON.stringify(
      {
        ok: true,
        slug,
        opened: opened.message,
        conversationTitle: visible.conversationTitle,
        extracted: {
          names: identity.names || [],
          phoneNumbers: (identity.phoneNumbers || []).map(maskPhone),
          emails: (identity.emails || []).map(maskEmail),
          uiTitles: identity.uiTitles || [],
          rawTextCount: identity.rawTexts?.length || 0,
        },
        stored,
        evidence: evidence.map((entry) => ({
          ...entry,
          evidence_value:
            entry.evidence_type === "phone"
              ? maskPhone(entry.evidence_value)
              : entry.evidence_type === "email"
                ? maskEmail(entry.evidence_value)
                : entry.evidence_value,
        })),
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
