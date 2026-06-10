import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./config.mjs";

export const DEFAULT_STATE_PATH = path.join(repoRoot, "data", "assistant-state.json");

export class StateStore {
  constructor(statePath = process.env.STATE_PATH || DEFAULT_STATE_PATH) {
    this.statePath = statePath;
    this.state = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      contacts: {},
    };
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  getContact(slug) {
    return this.state.contacts[slug] || {};
  }

  async updateContact(slug, patch) {
    this.state.contacts[slug] = {
      ...this.getContact(slug),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.save();
    return this.state.contacts[slug];
  }

  async save() {
    this.state.updatedAt = new Date().toISOString();
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.state, null, 2));
    await rename(tmpPath, this.statePath);
  }
}

export async function appendJsonl(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, { flag: "a" });
}

export async function acquireLock(lockDir = path.join(repoRoot, "data", "assistant.lock")) {
  async function tryCreateLock() {
    await mkdir(lockDir, { recursive: false });
    await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`);
  }

  try {
    await tryCreateLock();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;

    let existing = "unknown";
    try {
      existing = (await readFile(path.join(lockDir, "pid"), "utf8")).trim();
    } catch {
      // Ignore stale or unreadable pid metadata; the stale lock cleanup below can still recover.
    }

    const pid = Number(existing);
    const processStillRunning = Number.isInteger(pid) && pid > 0 && (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();

    if (processStillRunning) {
      throw new Error(`Assistant lock already exists at ${lockDir} (pid ${existing}).`);
    }

    await rm(lockDir, { recursive: true, force: true });
    await tryCreateLock();
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await rm(lockDir, { recursive: true, force: true });
  };
}
