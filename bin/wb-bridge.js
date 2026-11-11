#!/usr/bin/env node
// workbuddy-codex-bridge — CLI + single-process HTTP gateway.
//
// Absorbs the wire protocol of dsh-connect-workbuddy (local subscription auth,
// header signing, channel-fingerprint neutralisation, model discovery) and the
// loopback injection strategy of opencodex (root-level config.toml keys +
// shared model catalog), but speaks the Codex Responses API directly, so no
// third-party process is needed and it works on Windows.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DEFAULT_HOST, MODEL_PREFIX, OFFICIAL_CODEX_BASE } from "../src/constants.js";
import { discoverCredential, ensureFreshCredential, oauthLogin, classifyUpstream } from "../src/credentials.js";
import { fetchModels, prepareChatBody, chatStream } from "../src/upstream.js";
import { streamResponses, bufferedResponses, forwardOfficial, sseEvents } from "../src/responses.js";
import { writeCatalog, catalogPath, injectConfig, restoreConfig, injectionStatus } from "../src/codex-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULTS = {
  region: "cn", host: DEFAULT_HOST, port: DEFAULT_PORT,
  credentialFile: "", cnBase: "", apiKey: "", deviceToken: "", deviceFile: "",
  timeoutMs: 120000, emitReasoning: true, keepModelIds: [], extraModelIds: [],
};

function loadConfig() {
  const p = process.env.WB_BRIDGE_CONFIG || path.join(process.cwd(), "config.json");
  let user = {};
  try { user = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* absent / invalid -> defaults */ }
  return { ...DEFAULTS, ...user };
}
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function has(flag) { return process.argv.includes(flag); }
function log(...a) { console.log(...a); }

// Resolve the upstream model id from a Codex model slug ("wb/hy3" -> "hy3").
function stripPrefix(model) {
  const m = String(model || "");
  return m.startsWith(`${MODEL_PREFIX}/`) ? m.slice(MODEL_PREFIX.length + 1) : m;
}
function isWorkBuddyModel(model) { return String(model || "").startsWith(`${MODEL_PREFIX}/`); }

// ---------------------------------------------------------------------------
// setup: credential -> models -> catalog -> config.toml (idempotent)
// ---------------------------------------------------------------------------
let CACHED = null;
async function ensureSetup(config, { quiet = false } = {}) {
  const cred = await ensureFreshCredential(await discoverCredential(config), config);
  let models = await fetchModels(cred, config, config.keepModelIds || []);
  // Optionally append extra ids the operator knows are enabled on the account.
  for (const id of config.extraModelIds || []) {
    if (!models.some((m) => m.id === id)) {
      models.push({ id, name: id, contextWindow: 200000, maxTokens: 32000, supportsImages: true, supportsToolCall: true });
    }
  }
  if (!models.length) throw new Error("model catalog is empty; check the credential / region");
  const cat = writeCatalog(models);
  const inj = injectConfig({ port: config.port, catalogFile: cat.path });
  CACHED = { cred, models, cat, inj };
  if (!quiet) {
    log(`\n  credential : ${cred.source}${cred.filePath ? ` (${cred.filePath})` : ""}  region=${cred.domain || config.region}`);
    log(`  models     : ${models.length} WorkBuddy + ${cat.native} native`);
    log(`  catalog    : ${cat.path}`);
    log(`  config.toml: injected at line ${inj.insertAt} (${inj.configPath})`);
  }
  return CACHED;
}

async function cmdModels(config) {
  const cred = await ensureFreshCredential(await discoverCredential(config), config);
  const models = await fetchModels(cred, config, config.keepModelIds || []);
  log(`WorkBuddy models (region=${cred.domain || config.region}, source=${cred.source}):\n`);
  log("  " + "ID".padEnd(30) + "NAME".padEnd(26) + "CTX".padEnd(10) + "MAXOUT");
  for (const m of models) {
    log("  " + String(m.id).padEnd(30) + String(m.name).slice(0, 25).padEnd(26) +
      String(m.contextWindow).padEnd(10) + String(m.maxTokens));
  }
  log(`\n  ${models.length} models. They appear in the Codex picker as "${MODEL_PREFIX}/<id>" after restart.`);
}

async function cmdStatus(config) {
  const s = injectionStatus();
  const host = config.host, port = config.port;
  log("Codex integration:");
  log(`  config.toml      : ${s.configPath}`);
  log(`  injected         : ${s.injected ? "YES" : "no"}`);
  log(`  pristine backup  : ${s.backupExists ? "present" : "absent"}`);
  log(`  shared catalog   : ${s.catalogExists ? catalogPath() : "absent"}`);
  let alive = false;
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    alive = r.ok;
  } catch { /* not running */ }
  log(`  gateway          : ${alive ? "RUNNING" : "not running"} (http://${host}:${port})`);
  if (s.injected) log(`\n  Rollback: wb-bridge restore   (or just pick a native GPT in the picker = 0 steps)`);
}

async function cmdLogin(config) {
  const region = arg("--region", config.region);
  log(`Starting WorkBuddy device login (region=${region})...`);
  const cred = await oauthLogin({
    region,
    onUri: (url) => {
      log(`\n  Open this URL in your browser and sign in:\n\n  ${url}\n`);
      log("  Waiting for authorisation (up to 10 minutes)...");
    },
  });
  log(`\n  Logged in as ${cred.nickname || cred.uid || "(unknown)"}; credential written to ${cred.filePath}`);
  log("  Now run: wb-bridge setup   (or just: wb-bridge start)");
}

async function cmdRestore() {
  const r = restoreConfig();
  if (r.restored) log(`Restored ${r.configPath} to its pristine state; catalog removed; model cache expired.`);
  else log(`Nothing to restore (${r.reason}).`);
  log("Fully quit the ChatGPT desktop app and reopen it to complete the rollback.");
}

async function cmdSetup(config) {
  await ensureSetup(config);
  log("\n  IMPORTANT: fully QUIT the ChatGPT desktop app (not just close the window)");
  log("  and reopen it. Then open the Codex mode model picker.");
}

// ---------------------------------------------------------------------------
// HTTP gateway
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function authorized(req, config) {
  if (!config.apiKey) return true; // loopback data plane is trusted
  const h = req.headers.authorization || "";
  return h === `Bearer ${config.apiKey}` || h === config.apiKey;
}

// Plain OpenAI Chat Completions endpoint (also handy for other local tools).
async function handleChatCompletions(req, res, raw, config, ctx) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
  const modelId = stripPrefix(body.model || ctx.models[0]?.id || "hy3");
  const upstreamBody = prepareChatBody(body, modelId);
  const upstream = await chatStream(ctx.cred, upstreamBody, config);
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => "");
    const kind = classifyUpstream(upstream.status, t);
    return sendJson(res, upstream.status, { error: { message: t.slice(0, 800), type: kind } });
  }
  if (body.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform", Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally { res.end(); }
    return;
  }
  // non-streaming: aggregate upstream SSE into a single chat.completion
  let text = "", reasoning = "", finish = "stop";
  const calls = new Map();
  if (upstream.body) {
    for await (const ev of sseEvents(upstream.body)) {
      if (ev.done) break;
      const c = ev.json, ch = Array.isArray(c?.choices) ? c.choices[0] : null;
      if (ch?.finish_reason) finish = ch.finish_reason;
      const d = ch?.delta || {};
      if (typeof d.content === "string") text += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      for (const tc of d.tool_calls || []) {
        const i = Number(tc.index ?? 0);
        const st = calls.get(i) || { id: tc.id || "call_x", name: "", args: "" };
        if (tc.id) st.id = tc.id;
        if (tc.function?.name) st.name += tc.function.name;
        if (tc.function?.arguments) st.args += tc.function.arguments;
        calls.set(i, st);
      }
    }
  }
  const msg = { role: "assistant", content: text || null };
  if (reasoning) msg.reasoning_content = reasoning;
  if (calls.size) msg.tool_calls = [...calls.values()].map((s) => ({
    id: s.id, type: "function", function: { name: s.name, arguments: s.args || "{}" },
  }));
  sendJson(res, 200, {
    id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: body.model, choices: [{ index: 0, message: msg, finish_reason: finish }],
  });
}

async function handleResponses(req, res, raw, config, ctx, urlPath) {
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { error: "invalid JSON" }); }
  const sentModel = String(body.model || "");
  if (!isWorkBuddyModel(sentModel)) {
    // 0-step rollback: native GPT requests go straight to the official backend.
    const suffix = urlPath.startsWith("/v1") ? urlPath.slice(3) : urlPath;
    try { return await forwardOfficial(req, res, suffix, raw); }
    catch (e) { return sendJson(res, 502, { error: { message: `official forward failed: ${e.message}`, type: "upstream" } }); }
  }
  const modelId = stripPrefix(sentModel);
  const common = { body, modelId, responseModel: sentModel, cred: ctx.cred, config };
  try {
    if (body.stream === false) {
      const obj = await bufferedResponses(common);
      return sendJson(res, 200, obj);
    }
    await streamResponses({ res, ...common });
  } catch (e) {
    const status = e.status || 500;
    const msg = e.body || e.message || String(e);
    const kind = classifyUpstream(status, msg);
    if (!res.headersSent) {
      return sendJson(res, status, {
        error: { message: msg.slice(0, 800), type: kind, code: kind },
      });
    }
    // Headers already sent (SSE started) -> emit a terminal failed event.
    const { sseWrite } = await import("../src/responses.js");
    sseWrite(res, "response.failed", {
      response: {
        id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
        status: "failed", model: sentModel, output: [],
        error: { type: "server_error", code: kind, message: msg.slice(0, 400) },
        usage: null, incomplete_details: null,
      },
    });
    if (!res.writableEnded) res.end();
  }
}

function createServer(config, ctx) {
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    // health
    if (req.method === "GET" && (urlPath === "/healthz" || urlPath === "/v1/healthz")) {
      return sendJson(res, 200, {
        ok: true, service: "workbuddy-codex-bridge",
        region: ctx.cred.domain || config.region,
        models: ctx.models.length, nativePassthrough: OFFICIAL_CODEX_BASE,
      });
    }
    // OpenAI model list
    if (req.method === "GET" && (urlPath === "/v1/models" || urlPath === "/models")) {
      return sendJson(res, 200, {
        object: "list",
        data: ctx.models.map((m) => ({
          id: `${MODEL_PREFIX}/${m.id}`, object: "model",
          created: Math.floor(Date.now() / 1000), owned_by: "workbuddy",
        })),
      });
    }
    // full shared catalog (debug)
    if (req.method === "GET" && urlPath === "/v1/catalog") {
      try { return sendJson(res, 200, JSON.parse(fs.readFileSync(catalogPath(), "utf8"))); }
      catch (e) { return sendJson(res, 404, { error: e.message }); }
    }
    if (!authorized(req, config)) return sendJson(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });

    const raw = await readBody(req);
    if (urlPath === "/v1/responses" || urlPath === "/responses" ||
        urlPath === "/v1/responses/compact" || urlPath === "/responses/compact") {
      return handleResponses(req, res, raw, config, ctx, urlPath);
    }
    if (urlPath === "/v1/chat/completions" || urlPath === "/chat/completions") {
      try { return await handleChatCompletions(req, res, raw, config, ctx); }
      catch (e) { return sendJson(res, 502, { error: { message: e.message, type: "upstream" } }); }
    }
    // Anything else (e.g. /v1/responses/compact for a native model) forward.
    const suffix = urlPath.startsWith("/v1") ? urlPath.slice(3) : urlPath;
    try { return await forwardOfficial(req, res, suffix, raw); }
    catch (e) { return sendJson(res, 502, { error: { message: e.message } }); }
  });
}

async function cmdStart(config) {
  const ctx = await ensureSetup(config);
  const server = createServer(config, ctx);
  server.listen(config.port, config.host, () => {
    log(`\n  workbuddy-codex-bridge listening on http://${config.host}:${config.port}/v1`);
    log(`  WorkBuddy models : ${ctx.models.length}`);
    log(`  Native GPT       : forwarded to ${OFFICIAL_CODEX_BASE} (0-step rollback)`);
    log(`  Rollback         : wb-bridge restore`);
    log("\n  Fully QUIT and reopen the ChatGPT desktop app, then pick a \"WB · ...\" model in Codex mode.\n");
  });
  // Codex CLI probes the Responses WebSocket transport first. We only speak HTTP,
  // so answer the upgrade handshake with an explicit 405 immediately: that makes
  // Codex fall back to HTTPS on the first try instead of retrying 5 times (~5s).
  server.on("upgrade", (req, socket) => {
    const path = (req.url || "/").split("?")[0];
    log(`  ws upgrade declined (HTTP-only bridge): ${path}`);
    socket.write("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });
  const stop = () => { server.close(() => process.exit(0)); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

// ---------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] || "start";
  const config = loadConfig();
  if (has("--port")) config.port = Number(arg("--port", config.port));
  if (has("--region")) config.region = arg("--region", config.region);
  try {
    switch (cmd) {
      case "setup":    return await cmdSetup(config);
      case "start":    return await cmdStart(config);
      case "restore":  return await cmdRestore();
      case "login":    return await cmdLogin(config);
      case "models":   return await cmdModels(config);
      case "status":   return await cmdStatus(config);
      case "help": case "--help": case "-h":
        log(usage()); return;
      default:
        log(`Unknown command: ${cmd}\n`); log(usage()); process.exitCode = 1;
    }
  } catch (e) {
    console.error(`\n[wb-bridge] ${e.code || "ERROR"}: ${e.message}`);
    if (e.code === "NO_CREDENTIAL") log("  Hint: sign in to the WorkBuddy desktop app, or run `wb-bridge login`.");
    process.exitCode = 1;
  }
}

function usage() {
  return `workbuddy-codex-bridge — inject WorkBuddy subscription models into the ChatGPT desktop Codex picker

Usage:
  wb-bridge start            Set up + run the gateway (foreground). Do this first.
  wb-bridge setup            Discover models, write the catalog, inject config.toml (no server).
  wb-bridge models           List the account's WorkBuddy models.
  wb-bridge status           Show injection state / whether the gateway is running.
  wb-bridge login            Device OAuth login (when no desktop credential is found).
  wb-bridge restore          ONE-COMMAND rollback to the official subscription.

Options:
  --port <n>        Gateway port (default ${DEFAULT_PORT})
  --region cn|global  WorkBuddy edition (default cn)
  WB_BRIDGE_CONFIG   Path to config.json (default ./config.json)

After start, FULLY QUIT (not just close) the ChatGPT desktop app and reopen it.`;
}

main();
