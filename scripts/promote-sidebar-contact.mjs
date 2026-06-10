#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LOCAL_CONFIG_PATH, loadConfig, repoRoot } from "../src/config.mjs";
import { normalizePhone } from "../src/contact-utils.mjs";

const configPath = process.env.CONTACTS_CONFIG || DEFAULT_LOCAL_CONFIG_PATH;

function usage() {
  console.error(`Usage:
  node scripts/promote-sidebar-contact.mjs <slug> --display-name "Name" --title "Messages sidebar title" [--phone "+15551234567"] [--email "name@example.com"]

This updates config/contacts.local.json only. Use it when Messages shows phone
numbers instead of synced contact names.`);
  process.exit(2);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const slug = process.argv[2];
if (!slug || slug.startsWith("--")) usage();

const displayName = argValue("--display-name");
const title = argValue("--title");
const phone = argValue("--phone");
const email = argValue("--email");
if (!displayName || !title) usage();

const config = await loadConfig(configPath).catch(async (error) => {
  if (!/Config file not found/.test(error.message)) throw error;
  return JSON.parse(await readFile(path.join(repoRoot, "config", "contacts.example.json"), "utf8"));
});

config.settings = {
  ...(config.settings || {}),
  allowSend: false,
};
config.contacts = config.contacts || {};
const existing = config.contacts[slug] || {};
const normalizedPhone = normalizePhone(phone || title);
const identity = existing.identity || {};

config.contacts[slug] = {
  ...existing,
  displayName,
  searchName: existing.searchName || title,
  resultName: existing.resultName || title,
  conversationTitle: existing.conversationTitle || title,
  titleAliases: unique([...(existing.titleAliases || []), title, displayName]),
  enabled: existing.enabled !== false,
  autoSend: false,
  identity: {
    ...identity,
    canonicalName: identity.canonicalName || displayName,
    phoneNumbers: unique([...(identity.phoneNumbers || []), normalizedPhone]),
    emails: unique([...(identity.emails || []), email]),
    imessageHandles: identity.imessageHandles || [],
  },
  directSend: {
    enabled: false,
    serviceType: existing.directSend?.serviceType || "iMessage",
    handle: existing.directSend?.handle || "",
  },
};

delete config.configPath;
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, configPath, slug, autoSend: false }, null, 2));
