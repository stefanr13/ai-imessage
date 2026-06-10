import crypto from "node:crypto";

export function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeComparableText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function titleMatches(visibleTitle, contact) {
  const visible = normalizeComparableText(visibleTitle);
  const allowed = [contact.conversationTitle, contact.displayName, ...(contact.titleAliases || [])]
    .filter(Boolean)
    .map(normalizeComparableText);
  return allowed.includes(visible);
}

export function latestVisibleMessage(visible) {
  return [...(visible.messages || [])].reverse().find((message) => {
    return typeof message.text === "string" && message.text.trim();
  }) || null;
}

export function messageFingerprint(message) {
  if (!message) return null;
  return stableHash({
    direction: message.direction || "unknown",
    sender: message.sender || null,
    text: normalizeComparableText(message.text),
  });
}

export function visibleFingerprint(visible) {
  return stableHash({
    title: normalizeComparableText(visible.conversationTitle),
    messages: (visible.messages || []).map((message) => ({
      direction: message.direction || "unknown",
      sender: message.sender || null,
      text: normalizeComparableText(message.text),
    })),
  });
}

function sanitizeMessage(message, includeRaw) {
  if (!message) return null;
  const text = String(message.text || "");
  return {
    direction: message.direction || "unknown",
    senderHash: message.sender ? stableHash(message.sender) : null,
    textHash: stableHash(text),
    textChars: text.length,
    rawDescriptionHash: message.rawDescription ? stableHash(message.rawDescription) : null,
    frame: message.frame || null,
    parentFrame: message.parentFrame || null,
    ...(includeRaw ? { sender: message.sender || null, text, rawDescription: message.rawDescription || null } : {}),
  };
}

export function sanitizeVisible(visible, { includeRaw = false } = {}) {
  return {
    ok: visible.ok,
    trusted: visible.trusted,
    conversationTitle: visible.conversationTitle || null,
    conversationTitleHash: visible.conversationTitle ? stableHash(visible.conversationTitle) : null,
    messageCount: (visible.messages || []).length,
    messages: (visible.messages || []).map((message) => sanitizeMessage(message, includeRaw)),
  };
}

export function summarizeVisible(visible) {
  const latest = latestVisibleMessage(visible);
  return {
    title: visible.conversationTitle || null,
    messageCount: (visible.messages || []).length,
    latestDirection: latest?.direction || null,
    latestHash: messageFingerprint(latest),
    visibleHash: visibleFingerprint(visible),
  };
}
