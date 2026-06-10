#!/usr/bin/env node
import { messagesAx } from "../src/messages-ax.mjs";
import { normalizePhone } from "../src/contact-utils.mjs";
import { splitSidebarDescription } from "../src/sidebar.mjs";

function maskPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return value;
  return normalized.replace(/\d(?=\d{2})/g, "*");
}

function maskText(value) {
  return String(value || "").replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => maskPhone(match));
}

function usage() {
  console.error("Usage: node scripts/list-sidebar.mjs [--raw] [--activate]");
  process.exit(2);
}

const raw = process.argv.includes("--raw");
const activate = process.argv.includes("--activate");
if (process.argv.some((arg) => !["--raw", "--activate"].includes(arg) && arg.startsWith("--"))) usage();

const list = await messagesAx.listConversations({ activate });
if (!list.ok) {
  console.error(JSON.stringify(list, null, 2));
  process.exit(1);
}

const rows = (list.items || []).map((item, index) => {
  const sidebar = splitSidebarDescription(item.description) || {};
  return {
    index,
    selected: item.selected === true,
    title: raw ? sidebar.title : maskText(sidebar.title),
    normalizedPhone: raw ? normalizePhone(sidebar.title) || null : maskPhone(sidebar.title) || null,
    preview: raw ? sidebar.preview : maskText(sidebar.preview),
    timeLabel: sidebar.timeLabel || null,
  };
});

console.log(JSON.stringify(rows, null, 2));
