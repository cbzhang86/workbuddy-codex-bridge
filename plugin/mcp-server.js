#!/usr/bin/env node
/**
 * Minimal MCP server for the WorkBuddy bridge plugin.
 *
 * Why this exists: Codex has no plugin hook for process lifecycle in this
 * build (`plugin_hooks` is `removed` in `codex features list`). What it does
 * have is plugin-provided MCP servers, which Codex spawns when a session
 * starts and stops when the plugin is disabled. So this process is the
 * lifecycle hook in disguise: it brings the gateway up on start and takes it
 * back down on exit.
 *
 * Net effect for the user: toggling the plugin in the Codex plugin settings
 * toggles the bridge. Nothing to run in a terminal.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 over stdio. No dependencies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.WB_BRIDGE_PORT || 10100);
const STATE_DIR = path.join(os.homedir(), ".wb-bridge");
const INSTALL_FILE = path.join(STATE_DIR, "install.json");
const LOG_FILE = path.join(STATE_DIR, "plugin.log");

let child = null; // the gateway we started, if any
let owned = false; // true only when we started it ourselves
let startup = null; // in-flight ensureGateway() so tool calls can wait for it
let shuttingDown = false; // set while we are deliberately stopping the gateway

function log(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging is best effort */
  }
}

/**
 * The plugin is materialised into Codex's plugin cache, so it cannot see the
 * repository it came from. Resolve the bridge home from, in order: an explicit
 * env var, the install record the bridge writes on first run, the marketplace
 * source Codex recorded in config.toml when the plugin was installed, then a
 * walk up from the current directory (covers runs inside the checkout).
 *
 * The config.toml step is what makes "install the plugin and never touch a
 * terminal" work: without it the only record of the checkout lives in
 * install.json, which the bridge itself writes.
 */
function findRoot() {
  const explicit = process.env.WB_BRIDGE_HOME;
  if (explicit && fs.existsSync(path.join(explicit, "bin", "wb-bridge.js"))) return explicit;

  try {
    const record = JSON.parse(fs.readFileSync(INSTALL_FILE, "utf8"));
    if (record && record.root && fs.existsSync(path.join(record.root, "bin", "wb-bridge.js"))) {
      return record.root;
    }
  } catch {
    /* no install record yet */
  }

  for (const candidate of marketplaceRoots()) {
    if (fs.existsSync(path.join(candidate, "bin", "wb-bridge.js"))) return candidate;
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, "bin", "wb-bridge.js"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/**
 * Local marketplace roots recorded in CODEX_HOME/config.toml, e.g.
 *
 *     [marketplaces.workbuddy-bridge]
 *     source_type = "local"
 *     source = '\\?\C:\path\to\the\checkout'
 *
 * Windows paths in that file carry an extended-length `\\?\` prefix, which the
 * filesystem APIs accept but path.join() copies verbatim, so strip it.
 */
function marketplaceRoots() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let text = "";
  try {
    text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return [];
  }

  const roots = [];
  const block = /\[marketplaces\.[^\]]+\]([^[]*)/gu;
  for (const match of text.matchAll(block)) {
    const body = match[1];
    if (!/source_type\s*=\s*"local"/u.test(body)) continue;
    const source = /source\s*=\s*'([^']+)'/u.exec(body) || /source\s*=\s*"([^"]+)"/u.exec(body);
    if (!source) continue;
    const root = source[1].replace(/^\\\\\?\\/u, "");
    if (root) roots.push(root);
  }
  return roots;
}

function probe(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: "/healthz", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForHealth(totalMs) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function ensureGateway() {
  if (await probe()) {
    log("gateway already running; leaving it alone");
    owned = false;
    return;
  }

  const root = findRoot();
  if (!root) {
    log("cannot locate the bridge checkout; set WB_BRIDGE_HOME");
    return;
  }

  log(`starting gateway from ${root}`);
  // Capture the gateway's own output: when it fails to come up, its stderr is
  // the only thing that says why, and a plugin has nowhere else to show it.
  let out = null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    out = fs.openSync(path.join(STATE_DIR, "gateway.log"), "a");
  } catch {
    /* fall back to discarding it */
  }

  child = spawn(process.execPath, [path.join(root, "bin", "wb-bridge.js"), "start"], {
    cwd: root,
    // Detached on purpose. Codex kills this plugin server whenever the app
    // closes, and the injected config still points at the gateway's port, so
    // the gateway has to outlive us. Its pid is written to STATE_DIR by the
    // bridge itself, and the next plugin start adopts it instead of spawning a
    // second one.
    detached: true,
    stdio: ["ignore", out ?? "ignore", out ?? "ignore"],
    windowsHide: true,
    // Lets the gateway notice by itself when the plugin gets switched off while
    // no plugin server is running to do the teardown.
    env: { ...process.env, WB_BRIDGE_PLUGIN_GUARD: "1" },
  });
  child.unref();
  child.on("exit", (code) => {
    log(`gateway exited with code ${code}`);
    child = null;
    // Restart it: while the plugin is enabled the Codex config points at this
    // port, so leaving it dead would take the native GPT models down with it.
    if (owned && !shuttingDown) {
      log("gateway exited unexpectedly; restarting it");
      owned = false;
      ensureGateway().catch((error) => log(`restart failed: ${error.message}`));
    }
  });
  child.on("error", (error) => {
    log(`gateway spawn failed: ${error.message}`);
    child = null;
  });

  if (await waitForHealth(20000)) {
    owned = true;
    log("gateway is up");
  } else {
    // A gateway that never came up still left config.toml pointing at a dead
    // port, which would break the native GPT models too. Undo that at once.
    log("gateway did not become healthy in time; restoring the Codex config");
    await runCli(["restore"]);
  }
}

/**
 * Whether the user still has the plugin switched on.
 *
 * This is the difference between "the app closed" and "the user turned me off".
 * Codex kills the plugin server in both cases, and the two need opposite
 * handling:
 *
 *   - App closed, plugin still on -> leave the config injected. The next launch
 *     reads config.toml *before* it spawns this server, so restoring on exit
 *     would make the WB models vanish on every other launch.
 *   - Plugin switched off -> restore the config and stop the gateway, or the
 *     app would keep pointing at a port nobody serves and the native GPT models
 *     would break too.
 *
 * Codex records the switch in config.toml, which is readable here.
 */
function pluginStillEnabled() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let text = "";
  try {
    text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    // No config at all: nothing points at us, so treat it as switched off.
    return false;
  }
  // [plugins."wb-bridge@<marketplace>"] followed by enabled = true
  const block = /\[plugins\."wb-bridge@[^"]*"\]([^[]*)/u.exec(text);
  if (!block) return false; // uninstalled
  return /enabled\s*=\s*true/u.test(block[1]);
}

function stopGateway() {
  if (!owned || !child || child.exitCode !== null) return;
  shuttingDown = true;
  owned = false; // claim the teardown, so the exit hook below does not repeat it

  if (pluginStillEnabled()) {
    // The switch is still on, so this is just the app closing. Keep both the
    // injected config and the gateway: the next launch needs them, and Codex
    // reads the model list before it gets around to spawning us again.
    log("plugin still enabled; leaving the gateway and the Codex config in place");
    return;
  }

  log("stopping gateway because the plugin is switched off");
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    log(`failed to stop gateway: ${error.message}`);
  }
  // The gateway will not be there to serve it any more, so un-inject the Codex
  // config. Otherwise the app keeps pointing at a closed port and the native
  // GPT models stop working as well.
  try {
    spawnSync(process.execPath, [path.join(findRoot() || ".", "bin", "wb-bridge.js"), "restore"], {
      cwd: findRoot() || ".",
      stdio: "ignore",
      windowsHide: true,
    });
    log("restored the Codex config");
  } catch (error) {
    log(`failed to restore the Codex config: ${error.message}`);
  }
}

/** Last lines of the gateway's own log, for diagnosing a failed start. */
function readGatewayTail(limit = 6) {
  try {
    const text = fs.readFileSync(path.join(STATE_DIR, "gateway.log"), "utf8");
    const lines = text.trimEnd().split("\n");
    return lines.slice(-limit).join("\n");
  } catch {
    return "";
  }
}

function runCli(args) {
  const root = findRoot();
  if (!root) return { ok: false, error: "cannot locate the bridge checkout" };
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(root, "bin", "wb-bridge.js"), ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    proc.stdout.on("data", (c) => (out += c.toString("utf8")));
    proc.stderr.on("data", (c) => (out += c.toString("utf8")));
    proc.on("error", (error) => resolve({ ok: false, error: error.message }));
    proc.on("exit", (code) => resolve({ ok: code === 0, code, output: out.trim() }));
  });
}

/** Ask the gateway for the live model list it is exposing. */
function fetchModels() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: "/v1/models", method: "GET", timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString("utf8")));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed.data) ? parsed.data : []);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}

const TOOLS = [
  {
    name: "wb_status",
    description: "Report whether the WorkBuddy bridge is running and how many models it exposes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wb_models",
    description: "List the WorkBuddy models currently available in the Codex model picker.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wb_restore",
    description:
      "Remove the bridge from the Codex configuration and restore the pre-install config.toml backup. Does not uninstall the plugin.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(name) {
  if (name === "wb_status") {
    // A tool call can arrive while the gateway is still booting; wait for that
    // instead of reporting a false negative.
    if (startup) await startup;
    const up = await probe();
    if (!up) {
      const hint = readGatewayTail();
      return `The bridge is not running.${hint ? `\n\nLast gateway output:\n${hint}` : ""}`;
    }
    const models = await fetchModels();
    return `The bridge is running on http://${HOST}:${PORT} with ${models.length} models.`;
  }
  if (name === "wb_models") {
    if (startup) await startup;
    const models = await fetchModels();
    if (!models.length) return "The bridge is not running, so there are no models to list.";
    return models
      .map((m) => `${m.id}${m.display_name ? ` — ${m.display_name}` : ""}`)
      .join("\n");
  }
  if (name === "wb_restore") {
    const result = await runCli(["restore"]);
    return result.ok ? `Restored.\n${result.output}` : `Restore failed.\n${result.output || result.error}`;
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case "initialize": {
      const requested = params && params.protocolVersion;
      reply(id, {
        protocolVersion: requested || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "wb-bridge", version: "1.0.0" },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications never get a response
    case "ping":
      if (isRequest) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      try {
        const text = await callTool(name);
        reply(id, { content: [{ type: "text", text }] });
      } catch (error) {
        reply(id, { content: [{ type: "text", text: error.message }], isError: true });
      }
      return;
    }
    default:
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
let inFlight = 0; // requests still being answered
let stdinClosed = false;

function maybeExit() {
  if (!stdinClosed || inFlight > 0) return;
  stopGateway();
  process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // ignore malformed frames rather than killing the server
    }
    inFlight += 1;
    handle(message)
      .catch((error) => {
        if (message && message.id !== undefined) fail(message.id, -32603, error.message);
      })
      .finally(() => {
        inFlight -= 1;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  // Answer whatever is still queued before shutting the gateway down; a client
  // that closes stdin right after its last request must still get that answer.
  stdinClosed = true;
  setTimeout(maybeExit, 30000).unref();
  maybeExit();
});

function shutdown() {
  stopGateway();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", stopGateway);

log("plugin server started");
startup = ensureGateway().finally(() => {
  startup = null;
});
