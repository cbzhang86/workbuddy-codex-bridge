#!/usr/bin/env node
// Live integration tests. These spawn the real gateway against the real
// WorkBuddy subscription and skip themselves when no credential is present.
//
// Everything else in this repo is a pure-function self test; this file exists
// because the expensive bugs found during development (zstd request bodies, the
// WebSocket transport, an unreferenced catalog after restore) only ever showed
// up against the live process.
//
// Run with: npm run test:live
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const href = (p) => pathToFileURL(path.join(ROOT, p)).href;
let passed = 0;
const skip = (why) => { console.log(`  --  ${why}`); };
async function tAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.message}`); process.exitCode = 1; }
}

const PORT = Number(process.env.WB_LIVE_PORT) || 10198;
const BASE = `http://127.0.0.1:${PORT}`;

function waitPort(port, deadline) {
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 25);
      });
    };
    attempt();
  });
}

// Use a throwaway CODEX_HOME: the live test must never touch the user's real
// Codex config, and it needs a config.toml to inject into.
function makeCodexHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-live-"));
  fs.writeFileSync(path.join(dir, "config.toml"), 'model = "gpt-6.1-terra"\n', "utf8");
  return dir;
}

async function startGateway(codexHome) {
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "wb-bridge.js"), "start", "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, CODEX_HOME: codexHome, WB_BRIDGE_STATE: path.join(codexHome, "state") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { out += c; });
  const up = await waitPort(PORT, Date.now() + 60000);
  if (!up) {
    child.kill();
    throw new Error(`gateway did not listen within 60s:\n${out.slice(-1500)}`);
  }
  return { child, output: () => out };
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 4000);
  });
}

// Minimal WebSocket client: open the upgrade, then read text frames.
function wsUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write([
        "GET /v1/responses HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "", "",
      ].join("\r\n"));
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const head = buf.subarray(0, end).toString("utf8");
      resolve({ socket, head, rest: buf.subarray(end + 4), key });
    };
    socket.on("data", onData);
  });
}

function wsFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function readFrames(buf) {
  const frames = [];
  while (buf.length >= 2) {
    const len0 = buf[1] & 0x7f;
    let offset = 2;
    let len = len0;
    if (len0 === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
    else if (len0 === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + len) break;
    frames.push(buf.subarray(offset, offset + len).toString("utf8"));
    buf = buf.subarray(offset + len);
  }
  return { frames, rest: buf };
}

// ---------------------------------------------------------------------------
const CR = await import(href("src/credentials.js"));
const credential = await CR.discoverCredential({}).catch(() => null);
const hasCredential = Boolean(credential && (credential.apiKey || credential.accessToken || credential.cookies));
const modelId = process.env.WB_LIVE_MODEL || "hy3";

const codexHome = makeCodexHome();
// The gateway gets it through the environment; this process needs it too, or
// restoreConfig() below would rewrite the user's real config.
process.env.CODEX_HOME = codexHome;
let gw = null;

if (!hasCredential) {
  skip("live tests skipped: no WorkBuddy credential found on this machine");
} else {
  gw = await startGateway(codexHome);
  await tAsync("live: /healthz answers and reports the model count", async () => {
    const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.ok(j.models > 0, "at least one WorkBuddy model must be published");
  });

  await tAsync("live: the catalog on disk parses and carries routed rows", async () => {
    const p = path.join(codexHome, "workbuddy-catalog.json");
    assert.ok(fs.existsSync(p), "catalog must be written next to config.toml");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const routed = j.models.filter((m) => m.slug.startsWith("wb/"));
    assert.ok(routed.length > 0, "at least one wb/ row");
    assert.ok(routed.every((m) => m.visibility === "list"), "routed rows must be selectable");
    assert.ok(routed.every((m) => typeof m.display_name === "string" && m.display_name.startsWith("WB · ")));
  });

  await tAsync("live: config.toml is injected and points at the catalog", async () => {
    const text = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(text, /model_catalog_json = "/);
    assert.match(text, new RegExp(`openai_base_url = "http://127\\.0\\.0\\.1:${PORT}/v1"`));
  });

  // Regression: the Codex client zstd-compresses its larger request bodies. The
  // gateway used to hand the raw compressed bytes to JSON.parse and answer every
  // turn with a bare 400 {"error":"invalid JSON"}.
  await tAsync("live: a zstd-compressed request body is decoded, not rejected", async () => {
    const plain = JSON.stringify({ model: `wb/${modelId}`, input: "Reply with exactly: ok", stream: false, store: false });
    const r = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd" },
      body: zlib.zstdCompressSync(Buffer.from(plain, "utf8")),
      signal: AbortSignal.timeout(120000),
    });
    const text = await r.text();
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    assert.equal(j.status, "completed");
  });

  await tAsync("live: an unsupported content-encoding is refused with 415", async () => {
    const r = await fetch(`${BASE}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "exotic" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(r.status, 415);
  });

  // Regression: Codex opens a WebSocket first and, when the upgrade is refused,
  // burns ~16s retrying before falling back to HTTPS.
  await tAsync("live: the Responses WebSocket upgrade is accepted and completes a turn", async () => {
    const { socket, head, rest } = await wsUpgrade(PORT);
    let buf = rest;
    const types = [];
    let done = false;
    socket.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); });
    socket.on("close", () => { done = true; });
    try {
      assert.match(head, /^HTTP\/1\.1 101/, `expected 101, got: ${head.split("\r\n")[0]}`);
      socket.write(wsFrame(JSON.stringify({
        type: "response.create",
        model: `wb/${modelId}`,
        stream: true,
        store: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: ok" }] }],
      })));
      const deadline = Date.now() + 120000;
      let terminal = false;
      while (Date.now() < deadline) {
        const { frames, rest: left } = readFrames(buf);
        buf = left;
        for (const frame of frames) {
          try { types.push(JSON.parse(frame).type); } catch { /* not a JSON frame */ }
        }
        if (types.includes("response.completed") || types.includes("response.failed")) { terminal = true; break; }
        if (done) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.ok(types.length > 0, "the socket must carry at least one text frame");
      assert.ok(types.includes("response.created"), `expected response.created, saw: ${types.slice(0, 6).join(", ")}`);
      assert.ok(terminal, `the turn must terminate, saw: ${types.slice(-4).join(", ")}`);
      assert.ok(!types.includes("response.failed"), "the turn must not fail");
    } finally { socket.destroy(); }
  });

  await tAsync("live: restore is idempotent and never orphans the catalog", async () => {
    // Write a second catalog reference by re-running setup, then restore twice.
    const CC = await import(href("src/codex-config.js"));
    const first = CC.restoreConfig();
    assert.equal(first.restored, true);
    const afterFirst = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.ok(!afterFirst.includes("wb-bridge"), "the injected block must be gone");
    assert.ok(!afterFirst.includes("workbuddy-catalog.json"), "no reference to the catalog may remain");
    if (afterFirst.includes("workbuddy-catalog.json")) {
      assert.ok(fs.existsSync(CC.catalogPath()), "a still-referenced catalog must survive");
    }
    const second = CC.restoreConfig();
    assert.equal(second.restored, false, "a second restore is a no-op");
  });
}

await stop(gw?.child);
if (gw) fs.rmSync(codexHome, { recursive: true, force: true });

console.log(`\n${passed} live check${passed === 1 ? "" : "s"} passed.`);
if (!passed && process.exitCode !== 1) console.log("(nothing ran)");
