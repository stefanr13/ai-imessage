import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const helperPath = process.env.MESSAGES_AX_BIN || path.join(repoRoot, ".bin", "messages-ax");
const helperTimeoutMs = Number(process.env.MESSAGES_AX_TIMEOUT_MS || 20000);

function runHelper(args) {
  return new Promise((resolve) => {
    execFile(helperPath, args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, timeout: helperTimeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          trusted: true,
          message: `${error.message}\nhelper=${helperPath} ${args.join(" ")}\n${stderr}`.trim(),
        });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        resolve({
          ok: false,
          trusted: true,
          message: `${parseError.message}\nstdout=${stdout}\nstderr=${stderr}`.trim(),
        });
      }
    });
  });
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { cwd: repoRoot, maxBuffer: 1024 * 1024, timeout: helperTimeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          trusted: true,
          message: stderr.trim() || error.message,
        });
        return;
      }
      resolve({
        ok: true,
        trusted: true,
        message: stdout.trim() || "Sent text through Messages AppleScript.",
      });
    });
  });
}

export const messagesAx = {
  permission: (prompt = false) => runHelper(prompt ? ["permission", "--prompt"] : ["permission"]),
  open: (name, resultName = name) => runHelper(["open", name, "--result", resultName]),
  openSidebar: (description, { background = false, noClear = false } = {}) =>
    runHelper([
      "open-sidebar",
      ...(background ? ["--background"] : []),
      ...(noClear ? ["--no-clear"] : []),
      description,
    ]),
  readVisible: ({ activate = false, main = false } = {}) =>
    runHelper(["read-visible", ...(activate ? ["--activate"] : []), ...(main ? ["--main"] : [])]),
  identity: () => runHelper(["identity"]),
  listConversations: ({ activate = false } = {}) =>
    runHelper(activate ? ["list-conversations", "--activate"] : ["list-conversations"]),
  clearSearch: () => runHelper(["clear-search"]),
  clickPoint: ({ x, y }) => runHelper(["click-point", String(x), String(y)]),
  scrollSidebar: (direction, { pages = 1 } = {}) =>
    runHelper(["scroll-sidebar", direction, "--pages", String(pages)]),
  scrollTranscript: (direction, { pages = 1, background = false } = {}) =>
    runHelper([
      "scroll-transcript",
      direction,
      "--pages",
      String(pages),
      ...(background ? ["--background"] : []),
    ]),
  send: (text) => runHelper(["send", text]),
  sendDirect: ({ handle, text, serviceType = "iMessage" }) => {
    const script = [
      'tell application "Messages"',
      `set targetService to first service whose service type = ${appleScriptString(serviceType)}`,
      `set targetBuddy to buddy "${appleScriptString(handle)}" of targetService`,
      `send "${appleScriptString(text)}" to targetBuddy`,
      "end tell",
    ].join("\n");
    return runAppleScript(script);
  },
  snapshot: () => runHelper(["snapshot"]),
};
