#!/usr/bin/env node
/**
 * ps.mjs — command-line client for the Remirdy Photoshop bridge.
 * Used by the Claude /photoshop skill. Zero dependencies (Node >= 18).
 *
 *   ps.mjs launch [--wait SEC]        Start Photoshop + bridge if needed, wait for the panel
 *   ps.mjs quit                       Quit Photoshop (refuses if any document is unsaved) and stop the bridge
 *   ps.mjs bridge                     Start the local bridge if it isn't running
 *   ps.mjs stop                       Stop the local bridge
 *   ps.mjs status                     Bridge + Photoshop panel connection status
 *   ps.mjs state [--depth N] [--full-text]
 *                                     Open documents + full layer tree of the active one
 *   ps.mjs preview [out.png] [--max PX]
 *                                     Flattened PNG of the active document (default max 2048px)
 *   ps.mjs run <file.js|-> [opts]     Run a UXP script inside Photoshop (one undo step)
 *   ps.mjs eval '<code>' [opts]       Same as run, with inline code
 *   ps.mjs batchplay <file.json|->    Run an array of batchPlay descriptors (one undo step)
 *   ps.mjs open <file>                Open a PSD/image
 *   ps.mjs save [file]                Save the active document (Save As PSD when a path is given)
 *
 * run/eval options:
 *   --args '<json>'   Value exposed to the script as `args`
 *   --name '<text>'   History step name (default "Claude edit")
 *   --no-history      Don't wrap in a single history step
 *   --no-modal        Run outside executeAsModal (read-only scripts only)
 *   --timeout MS      Job timeout (default 120000, max 300000)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.PHOTOSHOP_MCP_REPO ?? path.resolve(SCRIPT_DIR, "../../..");
const ENV = loadEnv(path.join(REPO_ROOT, ".env"));
const PORT = process.env.BRIDGE_PORT ?? ENV.BRIDGE_PORT ?? "47831";
const BRIDGE_URL = process.env.BRIDGE_URL ?? `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.REMIRDY_BRIDGE_TOKEN ?? ENV.REMIRDY_BRIDGE_TOKEN ?? "dev_insecure_token";
const OUT_DIR = path.join(os.tmpdir(), "claude-photoshop");
const BRIDGE_LOG = path.join(OUT_DIR, "bridge.log");
const BRIDGE_ENTRY = "apps/local-bridge/src/index.ts";
// A bridge started by this CLI shuts itself down after this long without jobs
const BRIDGE_IDLE_EXIT_MINUTES = process.env.BRIDGE_IDLE_EXIT_MINUTES ?? "15";
const PHOTOSHOP_BUNDLE_ID = "com.adobe.Photoshop";

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function request(method, route, body, timeoutMs = 5000) {
  const res = await fetch(BRIDGE_URL + route, {
    method,
    headers: { "Content-Type": "application/json", "X-Bridge-Token": TOKEN },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (res.status === 401) fail("bridge rejected the token. The token in the Photoshop panel must match REMIRDY_BRIDGE_TOKEN in " + path.join(REPO_ROOT, ".env"));
  return { status: res.status, data };
}

async function bridgeHealthy() {
  try {
    const { status } = await request("GET", "/health", null, 1500);
    return status === 200;
  } catch {
    return false;
  }
}

async function startBridge() {
  if (await bridgeHealthy()) return { started: false, url: BRIDGE_URL };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tsx = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  if (!fs.existsSync(tsx)) fail(`tsx not found at ${tsx}. Run \`pnpm install\` in ${REPO_ROOT}.`);
  const log = fs.openSync(BRIDGE_LOG, "a");
  const child = spawn(tsx, [BRIDGE_ENTRY], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, BRIDGE_IDLE_EXIT_MINUTES },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await bridgeHealthy()) return { started: true, url: BRIDGE_URL, pid: child.pid, log: BRIDGE_LOG };
  }
  fail(`bridge did not come up within 10s. See ${BRIDGE_LOG}`);
}

function stopBridge() {
  try {
    execFileSync("pkill", ["-f", BRIDGE_ENTRY]);
    return { stopped: true };
  } catch {
    return { stopped: false, note: "bridge was not running" };
  }
}

function photoshopRunning() {
  try {
    const out = execFileSync("osascript", ["-e", `application id "${PHOTOSHOP_BUNDLE_ID}" is running`], { encoding: "utf8" });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

async function launch(waitSeconds) {
  const wasRunning = photoshopRunning();
  if (!wasRunning) execFileSync("open", ["-b", PHOTOSHOP_BUNDLE_ID]);
  await startBridge();
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const s = await status();
    if (s.photoshop) return { launched: !wasRunning, connected: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(
    `Photoshop is ${wasRunning ? "running" : "starting"} but the Remirdy panel didn't connect within ${waitSeconds}s. ` +
    "Open Plugins > Remirdy MCP once and leave it docked so it reopens with Photoshop."
  );
}

async function quit() {
  if (photoshopRunning()) {
    const s = await status();
    if (s.photoshop) {
      const unsaved = (await sendJob("runScript", {
        code: "return Array.from(app.documents).filter((d) => !d.saved).map((d) => d.title);",
        modal: false,
      })).result;
      if (unsaved.length) fail(`not quitting: unsaved changes in ${unsaved.join(", ")}. Save or close them first.`);
    }
    execFileSync("osascript", ["-e", `tell application id "${PHOTOSHOP_BUNDLE_ID}" to quit`]);
  }
  return { photoshopQuit: true, ...stopBridge() };
}

async function status() {
  if (!(await bridgeHealthy())) {
    return { bridge: false, photoshop: false, hint: "Bridge not running. Run: ps.mjs bridge" };
  }
  const { data } = await request("GET", "/photoshop/status");
  return {
    bridge: true,
    photoshop: !!data.connected,
    ...data,
    ...(data.connected ? {} : { hint: "Bridge is up but the Photoshop panel isn't polling. In Photoshop: Plugins > Remirdy MCP, then Connect Bridge." }),
  };
}

async function sendJob(type, payload, timeoutMs = 120_000) {
  const s = await status();
  if (!s.bridge || !s.photoshop) fail(s.hint);
  let res;
  try {
    res = await request("POST", "/jobs", { type, payload, timeoutMs }, timeoutMs + 5000);
  } catch (e) {
    fail(`job ${type} failed to complete: ${e.message}`);
  }
  const result = res.data;
  if (!result || typeof result !== "object") fail(`unexpected bridge response (${res.status}): ${String(result)}`);
  if (!result.ok) fail(result.message ?? `job ${type} failed`);
  return result.data;
}

function readSource(arg) {
  if (!arg) fail("missing file argument (use - for stdin)");
  if (arg === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path.resolve(arg), "utf8");
}

function scriptPayload(code, flags) {
  let args = {};
  if (flags.args) {
    try { args = JSON.parse(flags.args); } catch (e) { fail(`--args is not valid JSON: ${e.message}`); }
  }
  return {
    code,
    args,
    historyName: typeof flags.name === "string" ? flags.name : undefined,
    history: flags.history !== false,
    modal: flags.modal !== false,
  };
}

function timeoutFrom(flags) {
  return flags.timeout ? Math.min(Number(flags.timeout), 300_000) : 120_000;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  let out;

  switch (command) {
    case "launch":
      out = await launch(flags.wait ? Number(flags.wait) : 120);
      break;
    case "quit":
      out = await quit();
      break;
    case "bridge":
      out = await startBridge();
      break;
    case "stop":
      out = stopBridge();
      break;
    case "status":
      out = await status();
      break;
    case "state":
      out = await sendJob("getDocumentState", {
        maxDepth: flags.depth !== undefined ? Number(flags.depth) : undefined,
        fullText: !!flags["full-text"],
      });
      break;
    case "preview": {
      const maxSize = flags.max ? Number(flags.max) : 2048;
      const requested = path.resolve(positional[0] ?? path.join(OUT_DIR, `preview-${Date.now()}.jpg`));
      fs.mkdirSync(path.dirname(requested), { recursive: true });
      const stem = requested.replace(/\.(png|jpe?g)$/i, "");
      // With Photoshop's imaging API the panel returns a base64 JPEG; otherwise it writes this PNG itself
      const data = await sendJob("exportPreview", { path: stem + ".png", maxSize });
      if (data.base64) {
        const file = stem + ".jpg";
        fs.writeFileSync(file, Buffer.from(data.base64, "base64"));
        const { base64, ...rest } = data;
        out = { path: file, ...rest };
      } else {
        out = data;
      }
      break;
    }
    case "run":
      out = await sendJob("runScript", scriptPayload(readSource(positional[0]), flags), timeoutFrom(flags));
      break;
    case "eval":
      if (!positional[0]) fail("eval needs code");
      out = await sendJob("runScript", scriptPayload(positional[0], flags), timeoutFrom(flags));
      break;
    case "batchplay": {
      let descriptors;
      try { descriptors = JSON.parse(readSource(positional[0])); } catch (e) { fail(`descriptor JSON invalid: ${e.message}`); }
      if (!Array.isArray(descriptors)) descriptors = [descriptors];
      out = await sendJob("batchPlay", {
        descriptors,
        historyName: typeof flags.name === "string" ? flags.name : undefined,
        history: flags.history !== false,
      }, timeoutFrom(flags));
      break;
    }
    case "open": {
      if (!positional[0]) fail("open needs a file path");
      const file = path.resolve(positional[0]);
      if (!fs.existsSync(file)) fail(`no such file: ${file}`);
      out = await sendJob("runScript", {
        code: "const doc = await app.open(await fileEntry(args.path)); return { id: doc.id, title: doc.title, width: doc.width, height: doc.height };",
        args: { path: file },
        history: false,
      });
      break;
    }
    case "save": {
      const file = positional[0] ? path.resolve(positional[0]) : null;
      if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
      out = await sendJob("runScript", {
        code: [
          "const doc = app.activeDocument;",
          "if (!doc) throw new Error('No active document');",
          "if (args.path) { await doc.saveAs.psd(await fileEntry(args.path, { create: true }), { maximizeCompatibility: true }); }",
          "else { await doc.save(); }",
          "let savedPath = args.path; try { savedPath = doc.path || args.path; } catch (e) {}",
          "return { title: doc.title, path: savedPath };",
        ].join("\n"),
        args: { path: file },
        history: false,
      });
      break;
    }
    default:
      process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n\/\*\*\n/, "") + "\n");
      process.exit(command ? 1 : 0);
  }

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((e) => fail(e.stack ?? String(e)));
