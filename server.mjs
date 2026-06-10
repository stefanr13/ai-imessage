import http from "node:http";
import os from "node:os";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const CODEX_AUTO_RUN = process.env.CODEX_AUTO_RUN === "1";
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function textResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .filter((iface) => iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    const size = chunks.reduce((total, item) => total + item.length, 0);
    if (size > 64 * 1024) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function authorize(req) {
  if (!BRIDGE_TOKEN) return true;
  return req.headers.authorization === `Bearer ${BRIDGE_TOKEN}`;
}

function buildDryRunInstruction(event) {
  const senderHint = event.sender || "[latest unread sender]";
  return [
    "@Computer Open Messages.",
    `Find the conversation from ${senderHint}.`,
    "Read the latest exchange visually.",
    "Summarize what the person needs.",
    "Draft a reply in my tone, but do not send anything.",
    "If anything is ambiguous or sensitive, ask me a direct question first.",
  ].join(" ");
}

async function recordShortcutEvent(input) {
  await mkdir(DATA_DIR, { recursive: true });

  const event = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    source: "iphone-shortcut",
    sender: typeof input.sender === "string" ? input.sender : "",
    messagePreview: typeof input.messagePreview === "string" ? input.messagePreview : "",
    raw: input,
  };

  const dryRunInstruction = buildDryRunInstruction(event);
  const codex = CODEX_AUTO_RUN ? await runCodexDryRun(dryRunInstruction) : { attempted: false };
  await appendFile(EVENTS_FILE, `${JSON.stringify({ ...event, dryRunInstruction, codex })}\n`, "utf8");

  return { event, dryRunInstruction, codex };
}

function runCodexDryRun(prompt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "scripts", "run-codex-turn.mjs"), prompt], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      resolve({ attempted: true, ok: false, error: error.message });
    });

    child.on("close", (code) => {
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }

      resolve({
        attempted: true,
        ok: code === 0,
        code,
        result: parsed,
        stderr: stderr.trim().slice(-2000),
      });
    });
  });
}

async function getRecentEvents(limit = 20) {
  if (!existsSync(EVENTS_FILE)) return [];
  const raw = await readFile(EVENTS_FILE, "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health" && req.method === "GET") {
      jsonResponse(res, 200, {
        ok: true,
        service: "local-imessage-trigger-poc",
        time: new Date().toISOString(),
        authEnabled: Boolean(BRIDGE_TOKEN),
        lanUrls: getLanAddresses().map((address) => `http://${address}:${PORT}`),
      });
      return;
    }

    if (url.pathname === "/events" && req.method === "GET") {
      if (!authorize(req)) {
        jsonResponse(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      jsonResponse(res, 200, { ok: true, events: await getRecentEvents() });
      return;
    }

    if (url.pathname === "/shortcut/message" && req.method === "POST") {
      if (!authorize(req)) {
        jsonResponse(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const input = await readRequestJson(req);
      const { event, dryRunInstruction, codex } = await recordShortcutEvent(input);
      jsonResponse(res, 202, {
        ok: true,
        eventId: event.id,
        receivedAt: event.receivedAt,
        dryRunInstruction,
        codex,
      });
      return;
    }

    textResponse(res, 404, "Not found\n");
  } catch (error) {
    const statusCode = error.statusCode || 500;
    jsonResponse(res, statusCode, {
      ok: false,
      error: error.message || "Internal server error",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Local iMessage trigger POC listening on port ${PORT}`);
  console.log(`Codex auto-run: ${CODEX_AUTO_RUN ? "enabled" : "disabled"}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  for (const address of getLanAddresses()) {
    console.log(`LAN:    http://${address}:${PORT}/health`);
  }
});
