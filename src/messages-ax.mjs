import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const helperPath = process.env.MESSAGES_AX_BIN || path.join(repoRoot, ".bin", "messages-ax");

function runHelper(args) {
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr}`;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        parseError.message = `${parseError.message}\nstdout=${stdout}\nstderr=${stderr}`;
        reject(parseError);
      }
    });
  });
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { cwd: repoRoot, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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
  openSidebar: (description, { background = false } = {}) =>
    runHelper(background ? ["open-sidebar", "--background", description] : ["open-sidebar", description]),
  readVisible: () => runHelper(["read-visible"]),
  identity: () => runHelper(["identity"]),
  listConversations: ({ activate = false } = {}) =>
    runHelper(activate ? ["list-conversations", "--activate"] : ["list-conversations"]),
  clearSearch: () => runHelper(["clear-search"]),
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
