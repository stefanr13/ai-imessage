import { stableHash } from "./transcript.mjs";

export function normalizeText(value) {
  let normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (normalized.startsWith("maybe:")) {
    normalized = normalized.slice("maybe:".length).trim();
  }
  return normalized;
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

function comparableValues(value) {
  const text = normalizeText(value);
  const phone = normalizePhone(value);
  return [text, phone].filter(Boolean);
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
  const sidebarValues = new Set(comparableValues(sidebar.title));
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
    .flatMap(comparableValues);
  return aliases.some((alias) => sidebarValues.has(alias));
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
  const visiblePhone = normalizePhone(visible?.conversationTitle);
  const sidebarPhone = normalizePhone(sidebar?.title);
  return (
    visibleTitle === sidebarTitle ||
    visibleTitle.startsWith(`${sidebarTitle},`) ||
    visibleTitle.includes(sidebarTitle) ||
    (visiblePhone && sidebarPhone && visiblePhone === sidebarPhone)
  );
}
