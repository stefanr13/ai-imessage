#!/usr/bin/env node
import http from "node:http";
import { enabledContactSlugs, getContact, loadConfig } from "./config.mjs";
import { acquireLock, StateStore } from "./state-store.mjs";
import { runContactCycle } from "./orchestrator.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startHealthServer({ host, port, health }) {
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }
    if (req.url === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contacts: health.contacts }, null, 2));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(port, host);
  return server;
}

async function main() {
  const config = await loadConfig();
  const stateStore = await new StateStore().load();
  const releaseLock = await acquireLock();
  let stopping = false;

  const health = {
    status: "starting",
    startedAt: new Date().toISOString(),
    mode: process.env.DAEMON_MODE || "dry-run",
    cycles: 0,
    lastCycleAt: null,
    contacts: {},
  };

  const healthServer = startHealthServer({
    host: config.settings.healthHost,
    port: config.settings.healthPort,
    health,
  });

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    health.status = `stopping:${signal}`;
    if (healthServer) {
      await new Promise((resolve) => healthServer.close(resolve));
    }
    await releaseLock();
  }

  process.on("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));

  health.status = "running";
  const slugs = enabledContactSlugs(config);
  if (slugs.length === 0) throw new Error("No enabled contacts configured.");

  while (!stopping) {
    health.cycles += 1;
    health.lastCycleAt = new Date().toISOString();

    for (const slug of slugs) {
      if (stopping) break;
      const contact = getContact(config, slug);
      const result = await runContactCycle({
        config,
        slug,
        contact,
        stateStore,
        mode: health.mode,
        forceEvaluate: false,
      });
      health.contacts[slug] = {
        ok: result.ok,
        lastRunAt: result.at,
        lastAction: result.chosen?.action || null,
        sent: Boolean(result.sent?.ok),
        error: result.error ? String(result.error).split("\n")[0] : null,
        usage: result.gemma?.usage || null,
        outPath: result.outPath,
      };
    }

    await sleep(config.settings.pollIntervalMs);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
