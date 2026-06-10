#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error("Usage: node scripts/run-codex-turn.mjs <prompt>");
  process.exit(2);
}

const codexBin = process.env.CODEX_BIN || "codex";
const child = spawn(codexBin, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

const rl = readline.createInterface({ input: child.stdout });
const result = {
  threadId: null,
  turnId: null,
  finalResponse: "",
  completed: false,
  events: [],
};

let nextId = 0;
let settled = false;

function send(method, params = {}, id = ++nextId) {
  child.stdin.write(`${JSON.stringify({ method, params, id })}\n`);
  return id;
}

function finish(ok, extra = {}) {
  if (settled) return;
  settled = true;
  try {
    child.stdin.end();
  } catch {}
  child.kill();
  console.log(JSON.stringify({ ok, ...result, ...extra }, null, 2));
  process.exit(ok ? 0 : 1);
}

const timeout = setTimeout(() => {
  finish(false, { error: "Timed out waiting for Codex turn to complete" });
}, Number.parseInt(process.env.CODEX_TURN_TIMEOUT_MS || "120000", 10));

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (error) => {
  clearTimeout(timeout);
  finish(false, { error: error.message });
});

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.error) {
    clearTimeout(timeout);
    finish(false, { error: msg.error });
    return;
  }

  if (msg.id === 1 && msg.result?.thread?.id) {
    result.threadId = msg.result.thread.id;
    send("turn/start", {
      threadId: result.threadId,
      cwd: process.cwd(),
      input: [{ type: "text", text: prompt }],
    }, 2);
    return;
  }

  if (msg.method === "turn/started") {
    result.turnId = msg.params?.turn?.id || result.turnId;
    return;
  }

  if (msg.method === "item/agentMessage/delta") {
    result.finalResponse += msg.params?.delta || "";
    return;
  }

  if (msg.method === "turn/completed") {
    result.completed = true;
    clearTimeout(timeout);
    finish(true);
    return;
  }

  if (msg.method && result.events.length < 20) {
    result.events.push(msg.method);
  }
});

send("initialize", {
  clientInfo: {
    name: "local_imessage_trigger_poc",
    title: "Local iMessage Trigger POC",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
  },
}, 0);
send("thread/start", {
  cwd: process.cwd(),
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
  ephemeral: true,
}, 1);
