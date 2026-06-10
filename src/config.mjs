import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");
export const DEFAULT_LOCAL_CONFIG_PATH = path.join(repoRoot, "config", "contacts.local.json");
export const DEFAULT_CONFIG_PATH = path.join(repoRoot, "config", "contacts.example.json");

const DEFAULT_SETTINGS = {
  pollIntervalMs: 5000,
  baselineExistingMessages: true,
  requireModelConfirmation: true,
  allowSend: false,
  logRawMessages: false,
  healthHost: "127.0.0.1",
  healthPort: 8790,
  maxOpenRetries: 3,
  retryDelayMs: 750,
};

function envBool(name, fallback) {
  if (!(name in process.env)) return fallback;
  return ["1", "true", "yes", "on"].includes(String(process.env[name]).toLowerCase());
}

function envNumber(name, fallback) {
  if (!(name in process.env)) return fallback;
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    ...merged,
    pollIntervalMs: envNumber("POLL_INTERVAL_MS", merged.pollIntervalMs),
    baselineExistingMessages: envBool("BASELINE_EXISTING_MESSAGES", merged.baselineExistingMessages),
    requireModelConfirmation: envBool("REQUIRE_MODEL_CONFIRMATION", merged.requireModelConfirmation),
    allowSend: envBool("CONFIG_ALLOW_SEND", merged.allowSend),
    logRawMessages: envBool("LOG_RAW_MESSAGES", merged.logRawMessages),
    healthHost: process.env.HEALTH_HOST || merged.healthHost,
    healthPort: envNumber("HEALTH_PORT", merged.healthPort),
    maxOpenRetries: envNumber("MAX_OPEN_RETRIES", merged.maxOpenRetries),
    retryDelayMs: envNumber("RETRY_DELAY_MS", merged.retryDelayMs),
  };
}

async function readJsonFileIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadConfig(configPath = process.env.CONTACTS_CONFIG || null) {
  const resolvedPath = configPath || DEFAULT_LOCAL_CONFIG_PATH;
  let config = await readJsonFileIfExists(resolvedPath);
  let usedPath = resolvedPath;
  if (!config && !configPath) {
    config = JSON.parse(await readFile(DEFAULT_CONFIG_PATH, "utf8"));
    usedPath = DEFAULT_CONFIG_PATH;
  }
  if (!config) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }
  return {
    ...config,
    configPath: usedPath,
    settings: normalizeSettings(config.settings),
    contacts: config.contacts || {},
  };
}

export function getContact(config, slug) {
  const contact = config.contacts?.[slug];
  if (!contact) throw new Error(`Unknown contact slug '${slug}' in ${config.configPath || DEFAULT_CONFIG_PATH}`);
  return contact;
}

export function enabledContactSlugs(config) {
  return Object.entries(config.contacts || {})
    .filter(([, contact]) => contact.enabled !== false)
    .map(([slug]) => slug);
}
