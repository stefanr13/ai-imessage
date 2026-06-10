#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, decideNextAction, deterministicRuleDecision } from "../src/decision.mjs";
import { assertOllamaModelAvailable, getOllamaVersion } from "../src/ollama-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = process.env.CONTACTS_CONFIG || path.join(repoRoot, "config", "contacts.example.json");
const slug = process.argv[2] || "close-family";

const config = JSON.parse(await readFile(configPath, "utf8"));
const contact = config.contacts?.[slug];
if (!contact) {
  throw new Error(`Unknown contact slug '${slug}' in ${configPath}`);
}

const visible = {
  conversationTitle: contact.conversationTitle || contact.displayName,
  messages: [
    { direction: "outgoing", text: "Can you reply with Testing when you see this?" },
    { direction: "incoming", text: "Testing" },
  ],
};

const version = await getOllamaVersion();
await assertOllamaModelAvailable(DEFAULT_MODEL);
const deterministic = deterministicRuleDecision({ contact, visible });
const gemma = await decideNextAction({ contact, visible });

console.log(
  JSON.stringify(
    {
      ok: true,
      ollama: version,
      model: DEFAULT_MODEL,
      deterministic,
      gemma,
    },
    null,
    2
  )
);
