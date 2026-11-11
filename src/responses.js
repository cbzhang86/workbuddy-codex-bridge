// Responses API <-> WorkBuddy Chat Completions translation.
//
// Codex (inside the official ChatGPT desktop app) only speaks the OpenAI
// Responses API: POST <base_url>/responses with `input`, `tools`, `reasoning`…,
// and expects an SSE stream of `response.*` events back. The WorkBuddy
// subscription backend only speaks streaming Chat Completions at
// /v2/chat/completions. This module is the adapter between the two.
import crypto from "node:crypto";
import { OFFICIAL_CODEX_BASE } from "./constants.js";
import { prepareChatBody, chatStream } from "./upstream.js";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const msgId = () => `msg_${uid()}`;
const fcId = () => `fc_${uid()}`;
const rsId = () => `rs_${uid()}`;
const respId = () => `resp_${uid()}`;

// ---------------------------------------------------------------------------
// Request translation: Responses body -> Chat Completions body
// ---------------------------------------------------------------------------
function contentPartsToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    const t = p.type;
    if (["input_text", "output_text", "text", "summary_text"].includes(t) && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (t === "input_image" || t === "image_url") {
      const url = p.image_url || p.url || (typeof p.image_url === "string" ? p.image_url : "");
      const u = typeof url === "string" ? url : url?.url;
      if (u) parts.push({ type: "image_url", image_url: { url: u } });
    } else if (t === "input_file" && p.file_data) {
      // WorkBuddy has no file input; keep a textual placeholder.
      parts.push({ type: "text", text: `[attached file: ${p.filename || "file"}]` });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text).join("\n");
  return parts;
}

function pushAssistantToolCalls(messages, calls) {
  if (calls.length === 0) return;
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: calls.map((c) => ({
      id: c.call_id || `call_${uid()}`,
      type: "function",
      function: { name: c.name || "", arguments: c.arguments || "{}" },
    })),
  });
}

export function translateResponsesToChat(body, modelId) {
  const out = { model: modelId, stream: true, messages: [] };
  if (typeof body.instructions === "string" && body.instructions) {
    out.messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  const items = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : Array.isArray(input) ? input : [];

  let pendingCalls = [];
  const flushCalls = () => { pushAssistantToolCalls(out.messages, pendingCalls); pendingCalls = []; };
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "message": {
        flushCalls();
        out.messages.push({
          role: item.role === "developer" ? "system" : (item.role || "user"),
          content: contentPartsToChat(item.content),
        });
        break;
      }
      case "function_call":
      case "custom_tool_call": {
        pendingCalls.push({
          call_id: item.call_id || item.id || `call_${uid()}`,
          name: item.name || "",
          arguments: typeof item.arguments === "string" ? item.arguments : (typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? {})),
        });
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        flushCalls();
        out.messages.push({
          role: "tool",
          tool_call_id: item.call_id || "",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        });
        break;
      }
      case "reasoning": {
        // Reasoning items are server-side state; the subscription backend is
        // stateless, so we do not replay them. Drop (do not leak as answers).
        break;
      }
      default:
        // computer_call, web_search_call, item_reference, image_generation_call …
        // are ignored: they are OpenAI-side tools we cannot honour upstream.
        break;
    }
  }
  flushCalls();

  // tools
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = body.tools
      .filter((t) => t && (t.type === "function" || (!t.type && t.name)))
      .map((t) => ({
        type: "function",
        function: {
          name: t.name || "",
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (tools.length) out.tools = tools;
  }
  // tool_choice: Responses uses {type:"function", name}; Chat uses a string.
  if (typeof body.tool_choice === "string") out.tool_choice = body.tool_choice;
  else if (body.tool_choice?.type === "function") {
    out.tool_choice = { type: "function", function: { name: body.tool_choice.name || "" } };
  }

  if (Number.isFinite(body.max_output_tokens)) out.max_tokens = body.max_output_tokens;
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;
  const effort = body.reasoning?.effort;
  if (effort && effort !== "none" && effort !== "off") out.reasoning_effort = effort;
  if (body.text?.format?.type === "json_schema") {
    try {
      out.response_format = {
        type: "json_schema",
        json_schema: {
          name: body.text.format.name || "response",
          schema: body.text.format.schema || {},
          strict: Boolean(body.text.format.strict),
        },
      };
    } catch { /* optional */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------
// Codex's eventsource parser expects a monotonically increasing sequence_number
// on every typed frame (verified against opencodex src/bridge/sse.ts).
// The counter lives on `res` so every sseWrite() call site is automatically
// numbered and concurrent requests never share a sequence.
function nextSeq(res) {
  if (res.__wbSeq === undefined) res.__wbSeq = 0;
  return res.__wbSeq++;
}
export function sseWrite(res, type, data) {
  if (res.writableEnded || res.destroyed) return;
  const frame = { type, sequence_number: nextSeq(res), ...data };
  res.write(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`);
}
function sseDone(res) {
  if (res.writableEnded || res.destroyed) return;
  // The Responses stream must end with exactly one terminal [DONE] marker.
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function* sseEvents(readable, signal) {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;
      buf += decoder.decode(value, { stream: true });
      // Normalise CRLF.
      buf = buf.replace(/\r\n/gu, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = block.split("\n").filter((l) => l.startsWith("data:"));
        if (dataLines.length === 0) continue;
        const data = dataLines.map((l) => l.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") { yield { done: true }; return; }
        try { yield { done: false, json: JSON.parse(data) }; }
        catch { /* skip malformed chunk */ }
      }
    }
    // trailing block without the final blank line
    const tail = buf.trim();
    if (tail.startsWith("data:")) {
      const data = tail.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") {
        try { yield { done: false, json: JSON.parse(data) }; } catch { /* ignore */ }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Stream translation: Chat Completions SSE -> Responses SSE
// ---------------------------------------------------------------------------
export async function streamResponses({ res, body, modelId, responseModel, cred, config, clientSignal }) {
  const chatBody = prepareChatBody(translateResponsesToChat(body, modelId), modelId);
  const upstream = await chatStream(cred, chatBody, config, clientSignal);
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const err = new Error(`workbuddy upstream http ${upstream.status}: ${text.slice(0, 600)}`);
    err.status = upstream.status; err.body = text;
    throw err;
  }
  if (!upstream.body) throw new Error("workbuddy upstream returned no body");

  const createdAt = Math.floor(Date.now() / 1000);
  const id = respId();
  // Echo the request's own settings back in the Response object so the strict
  // Codex deserialiser sees every field it sent.
  const echo = { ...body };
  delete echo.input; delete echo.stream; delete echo.stream_options;
  const baseResponse = {
    ...echo,
    id, object: "response", created_at: createdAt,
    status: "in_progress", model: responseModel,
    output: [], error: null, incomplete_details: null, usage: null,
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  sseWrite(res, "response.created", { response: { ...baseResponse } });
  sseWrite(res, "response.in_progress", { response: { ...baseResponse } });

  const finalOutput = [];
  let outputIndex = 0;
  // --- message / text state
  let msgItem = null, msgText = "", msgStarted = false, contentIndex = 0;
  // --- reasoning state
  let rsItem = null, rsText = "", rsStarted = false, summaryIndex = 0;
  // --- tool calls state
  const toolStates = new Map(); // index -> {item, args, started, name, callId}
  let usage = null;
  let finishReason = null;

  const openMessage = () => {
    if (msgStarted) return;
    msgStarted = true;
    msgItem = { type: "message", id: msgId(), role: "assistant", status: "in_progress", content: [] };
    finalOutput.push(msgItem);
    sseWrite(res, "response.output_item.added", { output_index: outputIndex, item: { ...msgItem } });
    sseWrite(res, "response.content_part.added", {
      item_id: msgItem.id, output_index: outputIndex, content_index: contentIndex,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };
  const closeMessage = () => {
    if (!msgStarted) return;
    const part = { type: "output_text", text: msgText, annotations: [] };
    sseWrite(res, "response.output_text.done", {
      item_id: msgItem.id, output_index: outputIndex, content_index: contentIndex,
      text: msgText, logprobs: [],
    });
    sseWrite(res, "response.content_part.done", {
      item_id: msgItem.id, output_index: outputIndex, content_index: contentIndex, part,
    });
    const doneItem = { ...msgItem, status: "completed", content: [part] };
    msgItem.status = "completed"; msgItem.content = [part];
    sseWrite(res, "response.output_item.done", { output_index: outputIndex, item: doneItem });
    outputIndex += 1;
    msgStarted = false;
    msgText = ""; // next message item must not inherit this one's text
  };
  const openReasoning = () => {
    if (rsStarted) return;
    rsStarted = true;
    rsItem = { type: "reasoning", id: rsId(), summary: [], status: "in_progress" };
    finalOutput.push(rsItem);
    sseWrite(res, "response.output_item.added", { output_index: outputIndex, item: { ...rsItem } });
    sseWrite(res, "response.reasoning_summary_part.added", {
      item_id: rsItem.id, output_index: outputIndex, summary_index: summaryIndex,
      part: { type: "summary_text", text: "" },
    });
  };
  const closeReasoning = () => {
    if (!rsStarted) return;
    const part = { type: "summary_text", text: rsText };
    sseWrite(res, "response.reasoning_summary_text.done", {
      item_id: rsItem.id, output_index: outputIndex, summary_index: summaryIndex, text: rsText,
    });
    sseWrite(res, "response.reasoning_summary_part.done", {
      item_id: rsItem.id, output_index: outputIndex, summary_index: summaryIndex, part,
    });
    const doneItem = { ...rsItem, status: "completed", summary: [part] };
    rsItem.status = "completed"; rsItem.summary = [part];
    sseWrite(res, "response.output_item.done", { output_index: outputIndex, item: doneItem });
    outputIndex += 1;
    rsStarted = false;
    rsText = ""; // next reasoning item must not inherit this one's text
  };

  const openTool = (i, st) => {
    if (st.started) return;
    st.started = true;
    st.item = {
      type: "function_call", id: fcId(), call_id: st.callId,
      name: st.name, arguments: "", status: "in_progress",
    };
    finalOutput.push(st.item);
    sseWrite(res, "response.output_item.added", { output_index: outputIndex, item: { ...st.item } });
    st.outputIndex = outputIndex;
    outputIndex += 1;
  };
  const closeAllTools = () => {
    for (const st of toolStates.values()) {
      if (!st.started) continue;
      sseWrite(res, "response.function_call_arguments.done", {
        item_id: st.item.id, output_index: st.outputIndex, arguments: st.args,
      });
      const doneItem = { ...st.item, status: "completed", arguments: st.args || "{}" };
      st.item.status = "completed"; st.item.arguments = st.args || "{}";
      sseWrite(res, "response.output_item.done", { output_index: st.outputIndex, item: doneItem });
    }
  };

  try {
    for await (const ev of sseEvents(upstream.body, clientSignal)) {
      if (ev.done) break;
      const chunk = ev.json;
      if (!chunk || typeof chunk !== "object") continue;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta || {};

      if (typeof delta.reasoning_content === "string" && delta.reasoning_content && config.emitReasoning !== false) {
        if (msgStarted) closeMessage();
        openReasoning();
        rsText += delta.reasoning_content;
        sseWrite(res, "response.reasoning_summary_text.delta", {
          item_id: rsItem.id, output_index: outputIndex, summary_index: summaryIndex,
          delta: delta.reasoning_content,
        });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (rsStarted) closeReasoning();
        openMessage();
        msgText += delta.content;
        sseWrite(res, "response.output_text.delta", {
          item_id: msgItem.id, output_index: outputIndex, content_index: contentIndex,
          delta: delta.content, logprobs: [],
        });
      }
      // The WorkBuddy gateway emits `tool_calls: []` on EVERY chunk (verified
      // against the live stream). An empty array is not tool-call activity;
      // treating it as such would close/reopen the reasoning item per chunk.
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        if (rsStarted) closeReasoning();
        if (msgStarted) closeMessage();
        for (const tc of delta.tool_calls) {
          const i = Number(tc.index ?? 0);
          let st = toolStates.get(i);
          if (!st) {
            st = { args: "", started: false, name: "", callId: tc.id || `call_${uid()}` };
            toolStates.set(i, st);
          }
          if (tc.id) st.callId = tc.id;
          if (tc.function?.name) st.name += tc.function.name;
          // A tool call can only be opened once we know its name.
          if (st.name) openTool(i, st);
          const frag = tc.function?.arguments;
          if (typeof frag === "string" && frag && st.started) {
            st.args += frag;
            sseWrite(res, "response.function_call_arguments.delta", {
              item_id: st.item.id, output_index: st.outputIndex, delta: frag,
            });
          }
        }
      }
    }
  } catch (e) {
    if (!clientSignal?.aborted) {
      const failed = {
        ...baseResponse, status: "failed", output: finalOutput,
        error: { type: "server_error", code: "upstream_stream_error", message: String(e.message || e) },
        usage: normalizeUsage(usage, body, msgText),
      };
      sseWrite(res, "response.failed", { response: failed });
      sseDone(res);
      return;
    }
  }

  if (rsStarted) closeReasoning();
  if (msgStarted) closeMessage();
  closeAllTools();

  const status = finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed";
  const completed = {
    ...baseResponse,
    status,
    output: finalOutput.map((it) => ({ ...it })),
    usage: normalizeUsage(usage, body, msgText),
    ...(status === "incomplete" ? { incomplete_details: { reason: finishReason === "length" ? "max_output_tokens" : "content_filter" } } : {}),
  };
  if (status === "completed") sseWrite(res, "response.completed", { response: completed });
  else sseWrite(res, "response.incomplete", { response: completed });
  sseDone(res);
}

function normalizeUsage(raw, body, text) {
  const input = Math.max(0, Math.round(raw?.prompt_tokens ?? raw?.input_tokens ?? JSON.stringify(body.input ?? "").length / 4));
  const output = Math.max(0, Math.round(raw?.completion_tokens ?? raw?.output_tokens ?? String(text || "").length / 4));
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

// ---------------------------------------------------------------------------
// Non-streaming Responses: aggregate the upstream stream into one Response JSON
// ---------------------------------------------------------------------------
export async function bufferedResponses({ body, modelId, responseModel, cred, config, clientSignal }) {
  const chatBody = prepareChatBody(translateResponsesToChat(body, modelId), modelId);
  const upstream = await chatStream(cred, chatBody, config, clientSignal);
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const err = new Error(`workbuddy upstream http ${upstream.status}: ${text.slice(0, 600)}`);
    err.status = upstream.status; err.body = text;
    throw err;
  }
  let text = "", reasoning = "", usage = null, finishReason = null;
  const calls = new Map();
  if (upstream.body) {
    for await (const ev of sseEvents(upstream.body, clientSignal)) {
      if (ev.done) break;
      const c = ev.json;
      if (c?.usage) usage = c.usage;
      const ch = Array.isArray(c?.choices) ? c.choices[0] : null;
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      const d = ch?.delta || {};
      if (typeof d.content === "string") text += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      for (const tc of d.tool_calls || []) {
        const i = Number(tc.index ?? 0);
        const st = calls.get(i) || { id: tc.id || `call_${uid()}`, name: "", args: "" };
        if (tc.id) st.id = tc.id;
        if (tc.function?.name) st.name += tc.function.name;
        if (tc.function?.arguments) st.args += tc.function.arguments;
        calls.set(i, st);
      }
    }
  }
  const output = [];
  if (reasoning && config.emitReasoning !== false) {
    output.push({ type: "reasoning", id: rsId(), status: "completed", summary: [{ type: "summary_text", text: reasoning }] });
  }
  if (text) {
    output.push({
      type: "message", id: msgId(), role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const st of calls.values()) {
    output.push({
      type: "function_call", id: fcId(), call_id: st.id, name: st.name,
      arguments: st.args || "{}", status: "completed",
    });
  }
  const echo = { ...body };
  delete echo.input; delete echo.stream; delete echo.stream_options;
  return {
    ...echo,
    id: respId(), object: "response", created_at: Math.floor(Date.now() / 1000),
    status: finishReason === "length" ? "incomplete" : "completed",
    model: responseModel, output, error: null, incomplete_details: null,
    usage: normalizeUsage(usage, body, text),
  };
}

// ---------------------------------------------------------------------------
// Native OpenAI passthrough (0-step rollback: pick a native GPT in the picker)
// ---------------------------------------------------------------------------
const FORWARD_HEADERS = [
  "authorization", "chatgpt-account-id", "openai-beta", "originator",
  "session_id", "x-session-id", "content-type", "accept",
  "openai-organization", "openai-project", "user-agent",
];
export function pickForwardHeaders(req) {
  const out = {};
  for (const h of FORWARD_HEADERS) {
    if (req.headers[h] !== undefined) out[h] = req.headers[h];
  }
  return out;
}
export async function forwardOfficial(req, res, pathSuffix, rawBody) {
  const url = `${OFFICIAL_CODEX_BASE}${pathSuffix}`;
  const headers = pickForwardHeaders(req);
  const upstream = await fetch(url, {
    method: "POST", headers, body: rawBody,
    signal: AbortSignal.timeout(300000),
  });
  res.statusCode = upstream.status;
  for (const [k, v] of upstream.headers) {
    if (["transfer-encoding", "connection", "content-length"].includes(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally { res.end(); }
}
