import http from "node:http";
import os from "node:os";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contactMatchesSidebar } from "./src/contact-utils.mjs";
import { loadConfig } from "./src/config.mjs";
import {
  createApprovalRequest,
  getApprovalRequest,
  getConversationMemoryStatus,
  listApprovalRequests,
  listConversationMemoryStatuses,
  listMemoryChunks,
  listRecentDrafts,
  markApprovalSent,
  recordApprovalDecision,
  summarizeApprovalRequests,
} from "./src/memory-store.mjs";
import { messagesAx } from "./src/messages-ax.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || process.env.BRIDGE_HOST || "127.0.0.1";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const CODEX_AUTO_RUN = process.env.CODEX_AUTO_RUN === "1";
const DATA_DIR = path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const HEALTH_FILE = process.env.DRAFT_MONITOR_HEALTH || path.join(DATA_DIR, "draft-monitor-health.json");
const DASHBOARD_FILE = path.join(__dirname, "public", "dashboard.html");

if (!BRIDGE_TOKEN && !["127.0.0.1", "localhost", "::1"].includes(HOST) && process.env.ALLOW_INSECURE_LAN !== "1") {
  console.error("Refusing to bind approval API on a non-localhost interface without BRIDGE_TOKEN.");
  console.error("Set BRIDGE_TOKEN or ALLOW_INSECURE_LAN=1 if you really want unauthenticated LAN access.");
  process.exit(1);
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": process.env.CORS_ORIGIN || "null",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

async function htmlResponse(res, statusCode, filePath) {
  const body = await readFile(filePath, "utf8");
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
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

async function readJsonFileIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRequestJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 128 * 1024) {
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

function requireAuthorized(req) {
  if (authorize(req)) return;
  const error = new Error("Unauthorized");
  error.statusCode = 401;
  throw error;
}

function configuredContact(config, conversationSlug) {
  const contact = config.contacts?.[conversationSlug];
  if (!contact) {
    const error = new Error(`Configured contact required for sending: ${conversationSlug}`);
    error.statusCode = 409;
    throw error;
  }
  return contact;
}

function sendGates(config) {
  if (config.settings.allowSend !== true) {
    return { ok: false, message: "config-allow-send-disabled" };
  }
  if (process.env.ALLOW_SEND !== "1") {
    return { ok: false, message: "missing-ALLOW_SEND=1" };
  }
  return { ok: true, message: null };
}

async function sendExactText({ conversationSlug, text }) {
  const replyText = String(text || "").trim();
  if (!replyText) return { ok: false, message: "approved text is empty" };

  const config = await loadConfig();
  const gates = sendGates(config);
  if (!gates.ok) return gates;

  const contact = configuredContact(config, conversationSlug);
  if (contact.directSend?.enabled === true && String(contact.directSend.handle || "").trim()) {
    const result = await messagesAx.sendDirect({
      handle: contact.directSend.handle,
      serviceType: contact.directSend.serviceType || "iMessage",
      text: replyText,
    });
    return { ...result, mode: "direct" };
  }

  const opened = await messagesAx.open(
    contact.searchName || contact.displayName || contact.conversationTitle,
    contact.resultName || contact.conversationTitle || contact.displayName
  );
  if (!opened.ok) return { ok: false, mode: "ui", message: `open failed: ${opened.message || "unknown error"}` };

  const visible = await messagesAx.readVisible();
  if (!visible.ok) return { ok: false, mode: "ui", message: `read-visible failed: ${visible.message || "unknown error"}` };

  if (!contactMatchesSidebar(contact, { title: visible.conversationTitle || "" })) {
    return {
      ok: false,
      mode: "ui",
      message: `visible conversation mismatch: ${visible.conversationTitle || "(untitled)"}`,
    };
  }

  const result = await messagesAx.send(replyText);
  return { ...result, mode: "ui" };
}

async function approveAndMaybeSend({ id, text = null, send = true }) {
  const existing = await getApprovalRequest(id);
  if (!existing) {
    const error = new Error(`Approval request not found: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  const replyText = String(text ?? existing.proposedReply ?? "").trim();
  if (!replyText) {
    const error = new Error("Approved text is required.");
    error.statusCode = 400;
    throw error;
  }

  let request = await recordApprovalDecision({
    id,
    status: "approved",
    action: send ? "approved_send_exact" : "approved_hold",
    userResponseText: replyText,
  });
  if (!send) return request;

  const sendResult = await sendExactText({ conversationSlug: request.conversationSlug, text: replyText });
  request = await markApprovalSent({
    id,
    status: sendResult.ok ? "sent" : "send_failed",
    sendResult,
  });
  return request;
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

function approvalIdFromPath(pathname, suffix) {
  const match = pathname.match(/^\/approvals\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  if (suffix && match[2] !== suffix) return null;
  return decodeURIComponent(match[1]);
}

function parseLimit(url, fallback = 20) {
  const limit = Number(url.searchParams.get("limit") || fallback);
  return Math.max(1, Math.min(Number.isFinite(limit) ? limit : fallback, 200));
}

function slugFromMemoryPath(pathname, suffix = null) {
  const match = pathname.match(/^\/memory\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  if (suffix && match[2] !== suffix) return null;
  if (!suffix && match[2]) return null;
  return decodeURIComponent(match[1]);
}

function safeLogSlug(slug) {
  return String(slug || "memory")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "memory";
}

function startMemoryIndexProcess({ slug, input }) {
  const args = ["scripts/build-memory-index.mjs", slug];
  if (input.ingest === true) args.push("--ingest");
  if (input.force === true) args.push("--force");
  if (input.skipEmbeddings === true) args.push("--skip-embeddings");
  if (input.skipSummaries === true) args.push("--skip-summaries");
  if (input.refreshProfile === false) args.push("--no-refresh");
  if (Number.isFinite(Number(input.limit))) args.push("--limit", String(Number(input.limit)));
  if (Number.isFinite(Number(input.maxPages))) args.push("--max-pages", String(Number(input.maxPages)));
  if (typeof input.embeddingModel === "string" && input.embeddingModel.trim()) {
    args.push("--embedding-model", input.embeddingModel.trim());
  }

  const logPath = path.join(DATA_DIR, `memory-index.${safeLogSlug(slug)}.log`);
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  child.stderr.on("data", (chunk) => appendFile(logPath, chunk).catch(() => {}));
  child.unref();
  return { pid: child.pid, logPath, args };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      jsonResponse(res, 204, {});
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if ((url.pathname === "/" || url.pathname === "/dashboard") && req.method === "GET") {
      await htmlResponse(res, 200, DASHBOARD_FILE);
      return;
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const approvalSummary = await summarizeApprovalRequests();
      const monitor = await readJsonFileIfExists(HEALTH_FILE);
      const recentDrafts = (await listRecentDrafts({ limit: 5 })).map((draft) => ({
        id: draft.id,
        conversationSlug: draft.conversationSlug,
        action: draft.action,
        sendOk: draft.sendOk,
        createdAt: draft.createdAt,
        sidebarTitle: draft.sidebar?.title || null,
        sidebarTime: draft.sidebar?.timeLabel || null,
      }));
      jsonResponse(res, 200, {
        ok: true,
        service: "local-imessage-approval-api",
        time: new Date().toISOString(),
        host: HOST,
        port: PORT,
        authEnabled: Boolean(BRIDGE_TOKEN),
        lanUrls: HOST === "0.0.0.0" ? getLanAddresses().map((address) => `http://${address}:${PORT}`) : [],
        monitor,
        approvalSummary,
        recentDrafts,
      });
      return;
    }

    if (url.pathname === "/memory/status" && req.method === "GET") {
      requireAuthorized(req);
      jsonResponse(res, 200, {
        ok: true,
        conversations: await listConversationMemoryStatuses(),
      });
      return;
    }

    const memorySlug = slugFromMemoryPath(url.pathname);
    if (memorySlug && req.method === "GET") {
      requireAuthorized(req);
      const status = await getConversationMemoryStatus({ slug: memorySlug });
      if (!status) {
        jsonResponse(res, 404, { ok: false, error: "Not found" });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        conversation: status,
        chunks: await listMemoryChunks({
          slug: memorySlug,
          limit: parseLimit(url, 24),
          includeText: url.searchParams.get("includeText") === "1",
          includeEmbedding: false,
        }),
      });
      return;
    }

    const memoryIndexSlug = slugFromMemoryPath(url.pathname, "index");
    if (memoryIndexSlug && req.method === "POST") {
      requireAuthorized(req);
      const input = await readRequestJson(req);
      const config = await loadConfig();
      configuredContact(config, memoryIndexSlug);
      await mkdir(DATA_DIR, { recursive: true });
      const processInfo = startMemoryIndexProcess({ slug: memoryIndexSlug, input });
      jsonResponse(res, 202, {
        ok: true,
        slug: memoryIndexSlug,
        process: processInfo,
      });
      return;
    }

    if (url.pathname === "/approvals" && req.method === "GET") {
      requireAuthorized(req);
      const status = url.searchParams.get("status") || "open";
      jsonResponse(res, 200, {
        ok: true,
        approvals: await listApprovalRequests({ status, limit: parseLimit(url) }),
      });
      return;
    }

    const approvalGetId = approvalIdFromPath(url.pathname);
    if (approvalGetId && req.method === "GET") {
      requireAuthorized(req);
      const request = await getApprovalRequest(approvalGetId);
      if (!request) {
        jsonResponse(res, 404, { ok: false, error: "Not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, approval: request });
      return;
    }

    const approveId = approvalIdFromPath(url.pathname, "approve");
    if (approveId && req.method === "POST") {
      requireAuthorized(req);
      const input = await readRequestJson(req);
      const approval = await approveAndMaybeSend({
        id: approveId,
        text: typeof input.text === "string" ? input.text : null,
        send: input.send !== false,
      });
      jsonResponse(res, 200, { ok: true, approval });
      return;
    }

    const rejectId = approvalIdFromPath(url.pathname, "reject");
    if (rejectId && req.method === "POST") {
      requireAuthorized(req);
      const input = await readRequestJson(req);
      const approval = await recordApprovalDecision({
        id: rejectId,
        status: "rejected",
        action: "rejected",
        userResponseText: typeof input.reason === "string" ? input.reason : null,
      });
      if (!approval) {
        jsonResponse(res, 404, { ok: false, error: "Not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, approval });
      return;
    }

    const contextId = approvalIdFromPath(url.pathname, "context");
    if (contextId && req.method === "POST") {
      requireAuthorized(req);
      const input = await readRequestJson(req);
      if (typeof input.text !== "string" || !input.text.trim()) {
        jsonResponse(res, 400, { ok: false, error: "text is required" });
        return;
      }
      const approval = await recordApprovalDecision({
        id: contextId,
        status: "needs_approval",
        action: "user_context_added",
        userResponseText: input.text.trim(),
      });
      if (!approval) {
        jsonResponse(res, 404, { ok: false, error: "Not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, approval });
      return;
    }

    if (url.pathname === "/send" && req.method === "POST") {
      requireAuthorized(req);
      const input = await readRequestJson(req);
      if (typeof input.conversationSlug !== "string" || !input.conversationSlug.trim()) {
        jsonResponse(res, 400, { ok: false, error: "conversationSlug is required" });
        return;
      }
      if (typeof input.text !== "string" || !input.text.trim()) {
        jsonResponse(res, 400, { ok: false, error: "text is required" });
        return;
      }
      const approval = await createApprovalRequest({
        conversationSlug: input.conversationSlug.trim(),
        latestHash: `manual:${crypto.randomUUID()}`,
        incoming: [],
        proposedReply: input.text.trim(),
        reason: "Manual send requested from control surface.",
        risk: {
          approvalRequired: true,
          category: "manual_send",
          confidence: "high",
          reason: "Manual send requested from authorized control surface.",
          suggestedAction: "ask_approval",
          contextQuestion: null,
        },
        status: "manual_send_pending",
        action: "manual_send",
        model: "manual",
      });
      if (input.confirm === true) {
        const sentApproval = await approveAndMaybeSend({ id: approval.id, text: input.text.trim(), send: true });
        jsonResponse(res, 200, { ok: true, approval: sentApproval });
        return;
      }
      jsonResponse(res, 202, { ok: true, approval });
      return;
    }

    if (url.pathname === "/events" && req.method === "GET") {
      requireAuthorized(req);
      jsonResponse(res, 200, { ok: true, events: await getRecentEvents() });
      return;
    }

    if (url.pathname === "/shortcut/message" && req.method === "POST") {
      requireAuthorized(req);
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

server.listen(PORT, HOST, () => {
  console.log(`Local iMessage approval API listening on http://${HOST}:${PORT}`);
  console.log(`Auth: ${BRIDGE_TOKEN ? "enabled" : "disabled (localhost only by default)"}`);
  console.log(`Codex auto-run shortcut compatibility: ${CODEX_AUTO_RUN ? "enabled" : "disabled"}`);
  if (HOST === "0.0.0.0") {
    for (const address of getLanAddresses()) {
      console.log(`LAN: http://${address}:${PORT}/health`);
    }
  }
});
