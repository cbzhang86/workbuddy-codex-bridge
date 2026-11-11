#!/usr/bin/env node
// Zero-dependency self-test: pure-function checks only. No network, no writes
// to ~/.codex, no credentials. Safe to run anywhere.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const href = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const B = await import(href("bin/wb-bridge.js"));
const C = await import(href("src/constants.js"));
const U = await import(href("src/upstream.js"));
const R = await import(href("src/responses.js"));
const CR = await import(href("src/credentials.js"));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}
function tAsync(name, fn) {
  return fn().then(
    () => { passed++; console.log(`  ok  ${name}`); },
    (e) => { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; },
  );
}

console.log("workbuddy-codex-bridge self-test\n");

// --- constants -------------------------------------------------------------
t("constants: ZERO_WIDTH_SPACE is U+200B", () => {
  assert.equal(C.ZERO_WIDTH_SPACE.length, 1);
  assert.equal(C.ZERO_WIDTH_SPACE.codePointAt(0), 0x200b);
});
t("constants: CLIENT_UA / CN bases are the validated wire values", () => {
  assert.equal(C.CLIENT_UA, "CLI/2.63.2 CodeBuddy/2.63.2");
  assert.equal(C.CN_CHAT_BASE, "https://copilot.tencent.com");
  assert.equal(C.CHAT_PATH, "/v2/chat/completions");
  assert.equal(C.OFFICIAL_CODEX_BASE, "https://chatgpt.com/backend-api/codex");
});
t("constants: IDENTITY_CLAUSE matches the DeepSeek Harness opening", () => {
  C.IDENTITY_CLAUSE.lastIndex = 0;
  assert.equal(C.IDENTITY_CLAUSE.test("You are an AI agent powered by DeepSeek Harness"), true);
  C.IDENTITY_CLAUSE.lastIndex = 0;
  assert.equal(C.IDENTITY_CLAUSE.test("You are Claude Code, Anthropic's official CLI for Claude"), false);
  C.IDENTITY_CLAUSE.lastIndex = 0;
});
t("constants: markers are distinct and reversible", () => {
  assert.notEqual(C.INJECT_BEGIN, C.INJECT_END);
  assert.ok(C.INJECT_BEGIN.includes("wb-bridge restore"));
});

// --- credentials -----------------------------------------------------------
t("regionOf: .workbuddy.ai / .codebuddy.ai -> global, others -> cn", () => {
  assert.equal(CR.regionOf("www.workbuddy.ai"), "global");
  assert.equal(CR.regionOf("www.codebuddy.ai"), "global");
  assert.equal(CR.regionOf("www.workbuddy.cn"), "cn");
  assert.equal(CR.regionOf("copilot.tencent.com"), "cn");
  assert.equal(CR.regionOf(""), "cn");
});
t("chatBase: global splits workbuddy.ai vs codebuddy.ai; cn honours override", () => {
  assert.equal(CR.chatBase("www.workbuddy.ai"), C.GLOBAL_BASE);
  assert.equal(CR.chatBase("www.codebuddy.ai"), C.GLOBAL_CODEBUDDY_BASE);
  assert.equal(CR.chatBase("www.workbuddy.cn"), C.CN_CHAT_BASE);
  assert.equal(CR.chatBase("www.workbuddy.cn", "https://wb.tencentbuddy.com"), "https://wb.tencentbuddy.com");
});
t("originReferer: cn -> codebuddy.cn billing origin", () => {
  assert.equal(CR.originReferer("www.workbuddy.cn"), C.CN_BILLING_BASE);
});
t("classifyUpstream: error codes / credit / rate / session", () => {
  assert.equal(CR.classifyUpstream(402, ""), "hard_credit");
  assert.equal(CR.classifyUpstream(200, "积分不足"), "hard_credit");
  assert.equal(CR.classifyUpstream(400, "code 11128 unapproved channel"), "channel_reject");
  assert.equal(CR.classifyUpstream(400, "code 11133 invalid params"), "invalid_params");
  assert.equal(CR.classifyUpstream(400, "code 11140 unusual activity"), "account_restricted");
  assert.equal(CR.classifyUpstream(400, "code 11101 stream required"), "non_stream_rejected");
  assert.equal(CR.classifyUpstream(400, "code 11102 model not found"), "unknown_model");
  assert.equal(CR.classifyUpstream(429, ""), "soft_rate");
  assert.equal(CR.classifyUpstream(401, "Offline user session not found"), "session_dead");
  assert.equal(CR.classifyUpstream(503, ""), "server");
  assert.equal(CR.classifyUpstream(404, ""), "not_found");
});
t("needsRefresh: expiring token needs refresh, fresh one does not", () => {
  assert.equal(CR.needsRefresh({ expiresAtMs: Date.now() + 60000 }), true);
  assert.equal(CR.needsRefresh({ expiresAtMs: Date.now() + 3600000 }), false);
  assert.equal(CR.needsRefresh({ expiresAtMs: 0 }), true);
});

// --- upstream body rewriting ----------------------------------------------
t("prepareChatBody: forces stream, system head, model override", () => {
  const out = JSON.parse(U.prepareChatBody({ model: "x", messages: [{ role: "user", content: "hi" }] }, "hy3"));
  assert.equal(out.model, "hy3");
  assert.equal(out.stream, true);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content, "You are a helpful assistant.");
  assert.equal(out.messages[1].content, "hi");
});
t("prepareChatBody: developer -> system", () => {
  const out = JSON.parse(U.prepareChatBody({ messages: [{ role: "developer", content: "rules" }] }, "m"));
  assert.equal(out.messages[0].role, "system");
});
t("prepareChatBody: neutralises the unapproved channel opening", () => {
  const src = { messages: [{ role: "system", content: "You are an AI agent powered by DeepSeek Harness. Help." }] };
  const out = JSON.parse(U.prepareChatBody(src, "m"));
  const s = out.messages[0].content;
  assert.ok(s.startsWith("You are a helpful assistant.\n\n"));
  assert.ok(s.includes("\u200b"), "U+200B inserted to break the exact fingerprint");
});
t("prepareChatBody: normalises object tool_choice to a string", () => {
  for (const [tc, want] of [
    [{ type: "auto" }, "auto"],
    [{ type: "required" }, "required"],
    [{ type: "function", function: { name: "do_it" } }, "do_it"],
  ]) {
    const out = JSON.parse(U.prepareChatBody({ messages: [], tool_choice: tc }, "m"));
    assert.equal(out.tool_choice, want);
  }
  const none = JSON.parse(U.prepareChatBody({ messages: [], tool_choice: "none", tools: [{ type: "function" }] }, "m"));
  assert.equal(none.tool_choice, undefined);
  assert.equal(none.tools, undefined);
});
t("prepareChatBody: drops reasoning_effort=off (avoids 11133)", () => {
  const out = JSON.parse(U.prepareChatBody({ messages: [], reasoning_effort: "off" }, "m"));
  assert.equal(out.reasoning_effort, undefined);
});
t("prepareChatBody: max_completion_tokens -> max_tokens", () => {
  const out = JSON.parse(U.prepareChatBody({ messages: [], max_completion_tokens: 321 }, "m"));
  assert.equal(out.max_tokens, 321);
  assert.equal(out.max_completion_tokens, undefined);
});
t("chatHeaders: carries full WorkBuddy identity triple + Bearer, no X-Refresh-Token", () => {
  const cred = { accessToken: "AT", refreshToken: "RT", domain: "www.workbuddy.cn", uid: "u1", enterpriseId: "" };
  const h = U.chatHeaders(cred, {});
  assert.equal(h.Authorization, "Bearer AT");
  assert.equal(h["X-User-Id"], "u1");
  assert.equal(h["X-No-Enterprise-Id"], "1");
  assert.equal(h["X-Domain"], "www.workbuddy.cn");
  assert.equal(h["X-Agent-Purpose"], "conversation");
  assert.equal(h["X-IDE-Name"], "WorkBuddy");
  assert.equal(h["X-Product"], "WorkBuddy");
  assert.ok(h["X-Conversation-ID"] && h["X-Conversation-Request-ID"] && h["X-Conversation-Message-ID"]);
  assert.equal(h["X-Refresh-Token"], undefined, "refresh token must NEVER be in a chat request");
  assert.equal(h["User-Agent"], C.CLIENT_UA);
});
t("chatHeaders: fresh conversation ids per request", () => {
  const cred = { accessToken: "AT", domain: "", uid: "" };
  assert.notEqual(U.chatHeaders(cred, {})["X-Conversation-ID"], U.chatHeaders(cred, {})["X-Conversation-ID"]);
});

// --- Responses translation -------------------------------------------------
t("translateResponsesToChat: instructions + string input", () => {
  const c = R.translateResponsesToChat({ instructions: "sys", input: "hello", model: "wb/hy3" }, "hy3");
  assert.equal(c.messages[0].role, "system");
  assert.equal(c.messages[1].content, "hello");
  assert.equal(c.model, "hy3");
});
t("translateResponsesToChat: content parts, function_call, function_call_output", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "reasoning", summary: [] },
    ],
  };
  const c = R.translateResponsesToChat(body, "m");
  assert.equal(c.messages[0].content, "hi");
  assert.equal(c.messages[1].tool_calls[0].id, "c1");
  assert.equal(c.messages[1].tool_calls[0].function.name, "f");
  assert.equal(c.messages[2].role, "tool");
  assert.equal(c.messages[2].content, "ok");
  assert.equal(c.messages.length, 3, "reasoning item dropped, not leaked as an answer");
});
t("translateResponsesToChat: function tools + tool_choice + params passthrough", () => {
  const c = R.translateResponsesToChat({
    input: "x",
    tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }, { type: "web_search" }],
    tool_choice: { type: "function", name: "f" },
    max_output_tokens: 900, reasoning: { effort: "high" },
  }, "m");
  assert.equal(c.tools.length, 1);
  assert.equal(c.tools[0].function.name, "f");
  assert.deepEqual(c.tool_choice, { type: "function", function: { name: "f" } });
  assert.equal(c.max_tokens, 900);
  assert.equal(c.reasoning_effort, "high");
});
t("translateResponsesToChat: reasoning none/off is not forwarded", () => {
  assert.equal(R.translateResponsesToChat({ input: "x", reasoning: { effort: "none" } }, "m").reasoning_effort, undefined);
  assert.equal(R.translateResponsesToChat({ input: "x", reasoning: { effort: "off" } }, "m").reasoning_effort, undefined);
});
t("sseWrite: emits a valid Responses SSE frame", async () => {
  const chunks = [];
  const res = { writableEnded: false, destroyed: false, write: (s) => chunks.push(s) };
  R.sseWrite(res, "response.created", { response: { id: "r1" } });
  const s = chunks.join("");
  assert.ok(s.startsWith("event: response.created\n"));
  assert.ok(s.endsWith("\n\n"));
  assert.equal(JSON.parse(s.slice(s.indexOf("data: ") + 6)).response.id, "r1");
  assert.equal(JSON.parse(s.slice(s.indexOf("data: ") + 6)).type, "response.created");
});
await tAsync("sseEvents: parses multi-chunk SSE and stops at [DONE]", async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
      ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\nda'));
      ctrl.enqueue(enc.encode('ta: [DONE]\n\n'));
      ctrl.close();
    },
  });
  const got = [];
  for await (const ev of R.sseEvents(stream)) {
    if (ev.done) break;
    got.push(ev.json?.choices?.[0]?.delta?.content || "");
  }
  assert.equal(got.join(""), "Hello");
});

// --- codex config (sandboxed to a temp CODEX_HOME) --------------------------
t("codex-config: inject/strip/restore is fully reversible in a temp home", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bridge-test-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;
  try {
    // Dynamic import so codexHome() picks up the temp dir via env at call time.
    const CC = await import(href("src/codex-config.js"));
    fs.writeFileSync(CC.configPath(), [
      'notify = ["bell"]',
      'model = "gpt-6.1-terra"',
      'model_reasoning_effort = "high"',
      "",
      "[marketplaces.openai-bundled]",
      'enabled = true',
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(tmp, "models_cache.json"), JSON.stringify({
      fetched_at: 1, etag: "x", models: [{
        slug: "gpt-6.1-terra", display_name: "GPT-6.1 Terra", description: "native",
        default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high" }],
        visibility: "list", supported_in_api: true, priority: 100,
        context_window: 272000, max_context_window: 272000,
        model_messages: { instructions_template: "You are GPT-6." },
      }],
    }), "utf8");

    const cat = CC.writeCatalog([
      { id: "hy3", name: "Hy3", contextWindow: 256000, maxTokens: 128000, supportsImages: false, supportsToolCall: true },
      { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, maxTokens: 64000 },
    ]);
    assert.equal(cat.injected, 2);
    assert.equal(cat.native, 1);
    const doc = JSON.parse(fs.readFileSync(cat.path, "utf8"));
    assert.equal(doc.models.length, 3);
    const wb = doc.models.find((m) => m.slug === "wb/hy3");
    assert.equal(wb.supported_in_api, true);
    assert.equal(wb.visibility, "list");
    assert.equal(wb.context_window, 256000);
    assert.equal(wb.model_messages.instructions_template, "You are a helpful assistant.",
      "GPT identity must be replaced to avoid upstream 11128");
    assert.equal(wb.input_modalities.includes("image"), false);

    const inj = CC.injectConfig({ port: 10100, catalogFile: cat.path });
    const text = fs.readFileSync(CC.configPath(), "utf8");
    const lines = text.split("\n");
    // Root keys must sit BEFORE the first [table].
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l) && !/^\s*\[\[/.test(l));
    const b = lines.indexOf(C.INJECT_BEGIN);
    assert.ok(b >= 0 && b < firstTable, "injected block must precede the first [table]");
    assert.ok(text.includes('openai_base_url = "http://127.0.0.1:10100/v1"'));
    assert.ok(text.includes("model_catalog_json"));
    assert.ok(text.includes("disable_response_storage = true"));
    assert.equal(CC.injectionStatus().injected, true);
    // idempotency: a second inject must not duplicate the block
    CC.injectConfig({ port: 10100, catalogFile: cat.path });
    assert.equal((fs.readFileSync(CC.configPath(), "utf8").match(/workbuddy-codex-bridge \(undo/g) || []).length, 1);

    const r = CC.restoreConfig();
    assert.equal(r.restored, true);
    const restored = fs.readFileSync(CC.configPath(), "utf8");
    assert.ok(!restored.includes("openai_base_url"));
    assert.ok(!restored.includes("model_catalog_json"));
    assert.ok(restored.includes('model = "gpt-6.1-terra"'), "user's own keys preserved");
    assert.ok(restored.includes("[marketplaces.openai-bundled]"));
    assert.equal(CC.injectionStatus().injected, false);
    assert.equal(CC.injectionStatus().backupExists, false);
    assert.equal(CC.injectionStatus().catalogExists, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "models_cache.json"), "utf8")).fetched_at, 0);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- readBody content-encoding handling -------------------------------------
// Regression: the Codex client sends request bodies zstd-compressed once they
// grow past a few kilobytes. Before this was handled, those requests reached
// the handlers as opaque bytes and died as a bare "invalid JSON".
await tAsync("readBody: decodes identity/gzip/deflate/br/zstd bodies", async () => {
  const zlib = await import("node:zlib");
  const { Duplex } = await import("node:stream");
  const { readBody } = B;
  const fakeReq = (buf, headers = {}) => {
    const r = new Duplex({ read() { this.push(buf); this.push(null); }, write(_c, _e, cb) { cb(); } });
    r.headers = headers;
    return r;
  };
  const payload = Buffer.from(JSON.stringify({ model: "wb/hy3", input: "hi" }));
  const cases = [
    ["identity", payload, {}],
    ["gzip", zlib.gzipSync(payload), { "content-encoding": "gzip" }],
    ["deflate", zlib.deflateSync(payload), { "content-encoding": "deflate" }],
    ["br", zlib.brotliCompressSync(payload), { "content-encoding": "br" }],
    ["zstd", zlib.zstdCompressSync(payload), { "content-encoding": "zstd" }],
  ];
  for (const [enc, buf, headers] of cases) {
    const got = await readBody(fakeReq(buf, headers));
    assert.equal(got.toString("utf8"), payload.toString("utf8"), enc);
  }
});

await tAsync("readBody: rejects unknown encoding (415) and corrupt body (400)", async () => {
  const zlib = await import("node:zlib");
  const { Duplex } = await import("node:stream");
  const { readBody } = B;
  const fakeReq = (buf, headers = {}) => {
    const r = new Duplex({ read() { this.push(buf); this.push(null); }, write(_c, _e, cb) { cb(); } });
    r.headers = headers;
    return r;
  };
  await assert.rejects(() => readBody(fakeReq(Buffer.from("x"), { "content-encoding": "exotic" })), (e) => e.status === 415);
  await assert.rejects(() => readBody(fakeReq(Buffer.from("not gzip"), { "content-encoding": "gzip" })), (e) => e.status === 400);
});

// --- catalog metadata (credits / promo badges / queue state) ----------------
t("parseCreditMultiplier: reads the leading number of the credits string", () => {
  assert.equal(U.parseCreditMultiplier("x0.29 credits"), 0.29);
  assert.equal(U.parseCreditMultiplier("x0.00 credits"), 0);
  assert.equal(U.parseCreditMultiplier("x0.11"), 0.11);
  assert.equal(U.parseCreditMultiplier("x2.20 credits"), 2.2);
  assert.equal(U.parseCreditMultiplier("x1.00"), 1);
  assert.equal(U.parseCreditMultiplier("free"), undefined);
  assert.equal(U.parseCreditMultiplier(undefined), undefined);
  assert.equal(U.parseCreditMultiplier(0.5), 0.5);
});

t("parseBadges: extracts promo labels and drops the colour", () => {
  assert.deepEqual(U.parseBadges(["craft", "badge:限时免费:#FF0000"]), ["限时免费"]);
  assert.deepEqual(U.parseBadges(["badge:夜间折扣:#1E90FF", "badge:限时免费:#FF0000"]), ["夜间折扣", "限时免费"]);
  // A label containing a colon must survive: split on the LAST colon only.
  assert.deepEqual(U.parseBadges(["badge:限时:半价:#FF0000"]), ["限时:半价"]);
  assert.deepEqual(U.parseBadges(["craft", "text-to-image"]), []);
  assert.deepEqual(U.parseBadges(undefined), []);
});

t("busyLabel: maps upstream levels to the picker wording", () => {
  assert.equal(U.busyLabel("idle"), "空闲");
  assert.equal(U.busyLabel("normal"), "正常");
  assert.equal(U.busyLabel("busy"), "繁忙");
  assert.equal(U.busyLabel(undefined), "未知");
  assert.equal(U.busyLabel("something-new"), "未知");
});

t("buildCatalog: display_name carries cost + promo, and collisions are qualified", async () => {
  const CR = await import(href("src/codex-config.js"));
  const models = [
    { id: "hy3", name: "Hy3", contextWindow: 192000, creditMultiplier: 0, badges: ["限时免费"] },
    { id: "hy3-x", name: "Hy3", contextWindow: 192000, creditMultiplier: 0.05 },
    { id: "glm-5.2", name: "GLM-5.2", contextWindow: 1000000, creditMultiplier: 0.79, badges: ["夜间折扣"], busyLevel: "idle" },
  ];
  const cat = CR.buildCatalog(models);
  const rows = new Map(cat.models.filter((r) => r.slug.startsWith("wb/")).map((r) => [r.slug, r]));
  // hy3 and hy3-x are the free tier and the billed tier of the same product.
  // The product name is the honest label; the price keeps them apart.
  assert.equal(rows.get("wb/hy3").display_name, "WB · Hy3 · x0.00 · 限时免费");
  assert.equal(rows.get("wb/hy3-x").display_name, "WB · Hy3 · x0.05");
  assert.notEqual(rows.get("wb/hy3").display_name, rows.get("wb/hy3-x").display_name);
  assert.equal(rows.get("wb/hy3").slug, "wb/hy3");
  assert.equal(rows.get("wb/hy3-x").slug, "wb/hy3-x");
  assert.equal(rows.get("wb/glm-5.2").display_name, "WB · GLM-5.2 · x0.79 · 夜间折扣");
  assert.match(rows.get("wb/glm-5.2").description, /queue: 空闲/);
  assert.match(rows.get("wb/glm-5.2").description, /cost x0\.79 credits/);
  // A model with no price must not render a dangling separator.
  const bare = CR.buildCatalog([{ id: "m", name: "M", contextWindow: 1000 }]);
  const bareRow = bare.models.find((r) => r.slug === "wb/m");
  assert.equal(bareRow.display_name, "WB · M");
});


// --- WebSocket transport ---------------------------------------------------
const WS = await import(href("src/websocket.js"));
{
  const { acceptKey, encodeFrame, decodeFrames, frameSink } = WS.__test;
  t("ws acceptKey: matches the RFC 6455 example", () => {
    // RFC 6455 section 1.3: this key maps to this accept value.
    assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
  t("ws encodeFrame: single-byte, 16-bit and 64-bit length branches", () => {
    const small = encodeFrame("hi");
    assert.equal(small[0], 0x81);
    assert.equal(small[1], 2);
    const mid = encodeFrame("x".repeat(200));
    assert.equal(mid[1], 126);
    assert.equal(mid.readUInt16BE(2), 200);
    const big = encodeFrame("x".repeat(70000));
    assert.equal(big[1], 127);
    assert.equal(Number(big.readBigUInt64BE(2)), 70000);
  });
  t("ws decodeFrames: unmasks a client frame and keeps the remainder", () => {
    const payload = Buffer.from('{"type":"response.create"}');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]), mask, masked,
      Buffer.from([0x81]), // a partial frame: must stay in "rest"
    ]);
    const { frames, rest } = decodeFrames(frame);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString("utf8"), '{"type":"response.create"}');
    assert.equal(rest.length, 1);
  });
  t("ws frameSink: turns SSE into text frames and drops [DONE]", () => {
    const written = [];
    const socket = { destroyed: false, write: (b) => { written.push(b); return true; } };
    const sink = frameSink(socket, null);
    sink.write('event: response.created\ndata: {"type":"response.created"}\n\n');
    sink.write("data: [DONE]\n\n");
    sink.end();
    const text = Buffer.concat(written).toString("utf8");
    assert.ok(text.includes('{"type":"response.created"}'));
    assert.ok(!text.includes("[DONE]"), "the WS transport must not emit the SSE terminator");
  });
}

// --- proxy-aware transport -------------------------------------------------
const PX = await import(href("src/proxy.js"));
t("proxy: reads flat, scheme-prefixed and per-scheme values", () => {
  PX.resetProxyCache();
  assert.deepEqual(PX.detectProxy({ HTTPS_PROXY: "127.0.0.1:7890" }), { protocol: "http:", host: "127.0.0.1", port: 7890 });
  PX.resetProxyCache();
  assert.deepEqual(PX.detectProxy({ HTTP_PROXY: "http://10.0.0.5:8080" }), { protocol: "http:", host: "10.0.0.5", port: 8080 });
  PX.resetProxyCache();
  // A PAC script URL is not a proxy: it must never be used as one. An invalid
  // env value falls through to the OS setting, which is acceptable.
  const pac = PX.detectProxy({ HTTPS_PROXY: "http://proxy.local:5/pac.js" });
  assert.ok(!pac || pac.host !== "proxy.local", "a PAC path is not a proxy");
  // No env proxy: whatever the OS reports (the Windows registry here) is fine,
  // so only assert the shape when a proxy is detected at all.
  PX.resetProxyCache();
  const osProxy = PX.detectProxy({});
  if (osProxy) assert.equal(typeof osProxy.port, "number");
});
t("proxy: bypasses NO_PROXY hosts", () => {
  const env = { NO_PROXY: "localhost,.internal,*.corp" };
  assert.equal(PX.bypassProxy("localhost", env), true);
  assert.equal(PX.bypassProxy("api.internal", env), true);
  assert.equal(PX.bypassProxy("a.corp", env), true);
  assert.equal(PX.bypassProxy("chatgpt.com", env), false);
});

// --- plugin ----------------------------------------------------------------
// The plugin is what makes "toggle it in the Codex plugin settings" work, so
// its manifest and lifecycle wiring are worth asserting. Nothing here spawns
// the gateway; these are structural checks on the files Codex reads.
const pluginRoot = path.join(ROOT, "plugin");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(pluginRoot, rel), "utf8"));

t("plugin: manifest declares the name Codex keys installs on", () => {
  const manifest = readJson(".codex-plugin/plugin.json");
  assert.equal(manifest.name, "wb-bridge");
  assert.match(manifest.name, /^[a-z][a-z0-9-]*$/u);
  assert.equal(manifest.mcpServers, "./.mcp.json");
});

t("plugin: marketplace entry points at the plugin directory", () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, ".agents/plugins/marketplace.json"), "utf8"));
  const entry = marketplace.plugins.find((p) => p.name === "wb-bridge");
  assert.ok(entry, "wb-bridge missing from the marketplace");
  assert.equal(entry.source.path, "./plugin");
  // Codex rejects any source path that escapes the marketplace root.
  assert.ok(!entry.source.path.includes(".."), "source path must stay inside the root");
});

t("plugin: MCP manifest launches the server that is actually present", () => {
  const mcp = readJson(".mcp.json");
  const server = mcp.mcpServers["wb-bridge"];
  assert.equal(server.command, "node");
  const target = path.resolve(pluginRoot, server.args[0]);
  assert.ok(fs.existsSync(target), `missing ${target}`);
});

t("plugin: every declared tool is dispatched, and unknown tools fail loudly", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  for (const name of ["wb_status", "wb_models", "wb_restore"]) {
    assert.match(source, new RegExp(`name: "${name}"`, "u"), `${name} not declared`);
    assert.match(source, new RegExp(`name === "${name}"`, "u"), `${name} not dispatched`);
  }
  assert.match(source, /unknown tool/u);
});

t("plugin: teardown restores the config exactly once", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  // stopGateway() runs from both maybeExit() and the process exit hook. It has
  // to release `owned` before restoring, otherwise the config gets rewritten
  // twice and the second pass races the first.
  const body = source.slice(source.indexOf("function stopGateway()"), source.indexOf("/** Last lines of the gateway"));
  assert.match(body, /owned = false;/u, "stopGateway must release ownership");
  const ownerless = body.slice(body.indexOf("owned = false;"));
  assert.match(ownerless, /"restore"/u, "restore must happen after ownership is released");
});

t("plugin: restore is skipped while the gateway is still starting", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  // A failed start must not leave config.toml aimed at a dead port.
  assert.match(source, /restoring the Codex config/u);
  assert.match(source, /restarting it/u);
});

t("plugin: resolves the checkout from the marketplace source in config.toml", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  // "Install the plugin and never open a terminal" only works if the checkout
  // can be recovered from Codex's own config: install.json is written by the
  // bridge itself, so it does not exist on a fresh plugin-only install.
  assert.match(source, /function marketplaceRoots/u);
  assert.match(source, /\[marketplaces\./u);
  assert.match(source, /source_type/u);
  // Codex records Windows paths with an extended-length prefix.
  assert.match(source, /\\\\\\\?/u, "must strip the \\\\?\\ prefix Codex writes");
});

t("plugin: findRoot prefers an explicit override, then install.json, then config", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  const body = source.slice(source.indexOf("function findRoot()"), source.indexOf("function marketplaceRoots"));
  const order = ["WB_BRIDGE_HOME", "INSTALL_FILE", "marketplaceRoots()", "process.cwd()"].map((token) => {
    const at = body.indexOf(token);
    assert.ok(at >= 0, `${token} missing from findRoot`);
    return at;
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "findRoot resolved sources out of order");
});

t("plugin: the two teardown paths are told apart by the stored switch", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "mcp-server.js"), "utf8");
  const body = source.slice(source.indexOf("function stopGateway()"));
  // Closing the app keeps everything; only an explicit opt-out tears down.
  // Getting this backwards makes the WB models appear on alternate launches.
  assert.match(body, /if \(pluginStillEnabled\(\)\)/u);
  const keeps = body.slice(body.indexOf("pluginStillEnabled()"), body.indexOf("stopping gateway because the plugin is switched off"));
  assert.match(keeps, /leaving the gateway and the Codex config in place/u);
  assert.ok(!/restore/u.test(keeps), "the keep path must not restore the config");
  // The gateway is detached so it survives the app closing; the pid file lets
  // the next launch adopt it rather than start a second one.
  assert.match(source, /detached: true/u);
  assert.match(source, /child\.unref\(\)/u);
});

t("gateway: records its pid and self-stops only when it was plugin-spawned", () => {
  const source = fs.readFileSync(path.join(ROOT, "bin", "wb-bridge.js"), "utf8");
  assert.match(source, /function recordPid/u);
  assert.match(source, /gateway\.pid/u);
  // An opted-out plugin leaves no plugin server alive to run the teardown, so
  // the detached gateway has to notice by itself.
  const guard = source.slice(source.indexOf("function watchPluginSwitch"), source.indexOf("function stripPrefix"));
  assert.match(guard, /WB_BRIDGE_PLUGIN_GUARD/u, "the watchdog must be opt-in");
  assert.match(guard, /restoreConfig\(\)/u, "the watchdog must restore the config");
  assert.match(guard, /clearPid\(\)/u, "the watchdog must clear the pid file");
});

await tAsync("config: restore never deletes a catalog the config still points at", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-bridge-catalog-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmp;
  try {
    const CR2 = await import(`${href("src/codex-config.js")}?catalog`);
    const models = [{ id: "hy3", name: "Hy3", contextWindow: 192000 }];
    fs.writeFileSync(CR2.configPath(), 'model = "gpt-6.1-terra"\n\n[marketplaces.openai-bundled]\nenabled = true\n', "utf8");
    CR2.writeCatalog(models);
    CR2.injectConfig({ port: 10100, catalogFile: CR2.catalogPath() });
    assert.ok(fs.existsSync(CR2.catalogPath()), "catalog must exist after inject");

    // Simulate the failure that actually bit: a stale backup still carrying the
    // model_catalog_json line. Deleting a referenced file makes Codex reject its
    // whole config, which takes the official models down as well.
    CR2.restoreConfig();
    const after = fs.readFileSync(path.join(tmp, "config.toml"), "utf8");
    if (after.includes("workbuddy-catalog.json")) {
      assert.ok(fs.existsSync(CR2.catalogPath()), "a referenced catalog must survive restore");
    }
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- model cache (startup served before the first network trip) -------------
await tAsync("cache: round-trips a list and reports its age", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache-"));
  const prev = process.env.WB_BRIDGE_STATE;
  process.env.WB_BRIDGE_STATE = tmp;
  try {
    const CM = await import(`${href("src/cache.js")}?cache`);
    assert.equal(CM.readCachedModels(), null, "an absent cache reads as null");
    CM.writeCachedModels({ models: [{ id: "hy3", name: "Hy3" }], region: "cn", source: "vault" });
    const back = CM.readCachedModels();
    assert.equal(back.models.length, 1);
    assert.equal(back.models[0].id, "hy3");
    assert.equal(back.region, "cn");
    assert.equal(back.stale, false, "a fresh write is not stale");
    assert.ok(back.ageMs >= 0 && back.ageMs < 5000);
  } finally {
    if (prev === undefined) delete process.env.WB_BRIDGE_STATE;
    else process.env.WB_BRIDGE_STATE = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await tAsync("cache: rejects a corrupt or empty entry rather than serving it", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cache2-"));
  const prev = process.env.WB_BRIDGE_STATE;
  process.env.WB_BRIDGE_STATE = tmp;
  try {
    const CM = await import(`${href("src/cache.js")}?cache2`);
    fs.writeFileSync(CM.cachePath(), "{ not json", "utf8");
    assert.equal(CM.readCachedModels(), null, "unparseable cache is ignored");
    fs.writeFileSync(CM.cachePath(), JSON.stringify({ savedAt: Date.now(), region: "cn", models: [] }), "utf8");
    assert.equal(CM.readCachedModels(), null, "an empty list is not a usable catalog");
    fs.writeFileSync(CM.cachePath(), JSON.stringify({ savedAt: Date.now(), region: "cn", models: [{ id: 5 }] }), "utf8");
    assert.equal(CM.readCachedModels(), null, "entries without a string id are rejected");
  } finally {
    if (prev === undefined) delete process.env.WB_BRIDGE_STATE;
    else process.env.WB_BRIDGE_STATE = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await tAsync("cache: fingerprint ignores queue churn but catches real changes", async () => {
  const CM = await import(`${href("src/cache.js")}?cache3`);
  const base = [
    { id: "hy3", name: "Hy3", contextWindow: 192000, creditMultiplier: 0, badges: ["x"], busyLevel: "idle" },
    { id: "glm-5.3", name: "GLM-5.3", contextWindow: 1000000, creditMultiplier: 0.69, badges: [], busyLevel: "busy" },
  ];
  const fp = CM.modelsFingerprint(base);
  assert.equal(CM.modelsFingerprint(base.map((m) => ({ ...m, busyLevel: "idle" }))), fp,
    "a flapping queue level must not republish the catalog");
  assert.notEqual(CM.modelsFingerprint(base.map((m) => ({ ...m, creditMultiplier: 0.5 }))), fp,
    "a price change must republish");
  assert.notEqual(CM.modelsFingerprint(base.slice(1)), fp, "a dropped model must republish");
  assert.equal(CM.modelsFingerprint([base[1], base[0]]), fp, "order alone is not a change");
});

console.log(`\n${passed} checks passed.`);
