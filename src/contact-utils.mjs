import { stableHash } from "./transcript.mjs";

export function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function slugFromSidebarTitle(title) {
  const normalized = normalizeText(title);
  const readable = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return readable || `conversation-${stableHash(title).slice(0, 12)}`;
}

export function contactMatchesSidebar(contact, sidebar) {
  const sidebarTitle = normalizeText(sidebar.title);
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
  ]
    .filter(Boolean)
    .map(normalizeText);
  return aliases.includes(sidebarTitle);
}

export function findSidebarContact(config, sidebar) {
  for (const [slug, contact] of Object.entries(config.contacts || {})) {
    if (contactMatchesSidebar(contact, sidebar)) return { slug, contact };
  }
  return null;
}

export function fallbackContactForSidebar(sidebar) {
  return {
    slug: slugFromSidebarTitle(sidebar.title),
    contact: {
      displayName: sidebar.title,
      conversationTitle: sidebar.title,
      titleAliases: [sidebar.title],
      autoSend: false,
      enabled: true,
    },
  };
}

export function visibleTitleMatchesSidebar(visible, sidebar) {
  const visibleTitle = normalizeText(visible?.conversationTitle);
  const sidebarTitle = normalizeText(sidebar?.title);
  if (!visibleTitle || !sidebarTitle) return false;
  return visibleTitle === sidebarTitle || visibleTitle.startsWith(`${sidebarTitle},`) || visibleTitle.includes(sidebarTitle);
}
