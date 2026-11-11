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

console.log(`\n${passed} checks passed.`);
