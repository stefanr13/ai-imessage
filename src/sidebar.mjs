export function splitSidebarDescription(description) {
  const parts = String(description || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const title = parts[0];
  const timeLabel = parts[parts.length - 1] || "";
  const metadata = new Set();
  const previewParts = [];
  for (const part of parts.slice(1, -1)) {
    if (["Unread", "Summary"].includes(part)) metadata.add(part);
    else previewParts.push(part);
  }

  return {
    title,
    hasUnread: metadata.has("Unread"),
    preview: previewParts.join(", ").trim(),
    timeLabel,
  };
}

export function parseSidebarTimeToday(timeLabel, now = new Date()) {
  const match = String(timeLabel || "").match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridian = match[3].toUpperCase();
  if (meridian === "PM" && hour < 12) hour += 12;
  if (meridian === "AM" && hour === 12) hour = 0;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}
