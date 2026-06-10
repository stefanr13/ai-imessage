#!/usr/bin/env node
import { getContact, loadConfig } from "./config.mjs";
import { runContactCycle } from "./orchestrator.mjs";
import { StateStore } from "./state-store.mjs";

async function main() {
  const slug = process.argv[2] || "close-family";
  const mode = process.argv[3] || "dry-run";
  const config = await loadConfig();
  const contact = getContact(config, slug);
  const stateStore = await new StateStore().load();

  const result = await runContactCycle({
    config,
    slug,
    contact,
    stateStore,
    mode,
    forceEvaluate: mode === "dry-run",
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        outPath: result.outPath,
        chosen: result.chosen,
        sendBlocked: result.sendBlocked,
        sent: result.sent,
        usage: result.gemma?.usage || null,
        error: result.error ? String(result.error).split("\n")[0] : null,
      },
      null,
      2
    )
  );

  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
