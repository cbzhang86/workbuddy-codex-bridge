// WorkBuddy subscription wire protocol: headers, body rewriting, model catalog,
// and the streaming SSE chat call. Transcribed from dsh-connect-workbuddy v5.21.3.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import {
  CN_BILLING_BASE, GLOBAL_CONFIG_PATH, LEGACY_CATALOG_PATH,
  CHAT_PATH, CLIENT_UA, PRODUCT_UA, APP_CHANNEL_UA, CATALOG_CLI_UA,
  APP_VERSION, ATTRIBUTION_CLIENT_NAME, NEUTRAL_SYSTEM, ZERO_WIDTH_SPACE,
  DEVICE_ID_NAMESPACE, ROUTER_MODEL_IDS, UNAPPROVED_CHANNEL_OPENINGS, IDENTITY_CLAUSE,
  MODEL_BUSY_PATH,
} from "./constants.js";
import { chatBase, billingBase, originReferer, regionOf } from "./credentials.js";

// ---------------------------------------------------------------------------
// identity / headers
// ---------------------------------------------------------------------------
function uuidv4() { return crypto.randomUUID(); }
function uuidv7(nowMs = Date.now()) {
  const b = crypto.randomBytes(16);
  // NB: do NOT use `& 0xffffffffffff` here — JS bitwise ops coerce to signed
  // int32 and would yield a negative value that writeUIntBE rejects. Epoch ms
  // (~1.8e12) is well below 2^48, so a plain 6-byte write is safe.
  b.writeUIntBE(Math.floor(nowMs), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b.toString("hex");
}
function deviceSalt(config) {
  try {
    const home = process.env.DSH_HOME || `${os.homedir()}/.dsh`;
    const p = config.deviceFile || `${home}/.workbuddy-device.json`;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j.salt || "";
  } catch { return ""; }
}
function deriveDeviceId(uid, purpose, salt) {
  return crypto.createHash("sha256")
    .update(`${DEVICE_ID_NAMESPACE}\0${salt}\0${purpose}\0${uid}`, "utf8")
    .digest("hex").slice(0, 36);
}

function legacyCommon(cred) {
  const origin = originReferer(cred.domain);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": CLIENT_UA,
  };
}
function commonHeaders(cred) {
  return {
    ...legacyCommon(cred),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": regionOf(cred.domain) === "global" ? "en-US" : "zh-CN",
  };
}
function attributionHeaders() {
  return {
    "X-Agent-Purpose": "conversation",
    "X-IDE-Name": ATTRIBUTION_CLIENT_NAME,
    "X-IDE-Type": ATTRIBUTION_CLIENT_NAME,
    "X-IDE-Version": APP_VERSION,
    "X-Product": ATTRIBUTION_CLIENT_NAME,
  };
}
function deviceHeaders(cred, config) {
  const salt = deviceSalt(config);
  if (!salt) return {};
  const out = {};
  if (config.deviceToken) out["X-Device-Token"] = config.deviceToken;
  else {
    out["X-Machine-ID"] = deriveDeviceId(cred.uid, "machine", salt);
    out["X-Session-ID"] = deriveDeviceId(cred.uid, "session", salt);
  }
  return out;
}
function conversationHeaders() {
  const cid = uuidv4();
  const crid = uuidv4();
  const mid = uuidv7();
  return {
    "X-Conversation-ID": cid,
    "X-Conversation-Request-ID": crid,
    "X-Root-Request-ID": crid,
    "X-Conversation-Message-ID": mid,
    "X-Request-ID": mid,
  };
}
export function chatHeaders(cred, config = {}) {
  return {
    ...commonHeaders(cred),
    "Content-Type": "application/json",
    ...(cred.uid ? { "X-User-Id": cred.uid } : { "X-No-User-Id": "1" }),
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : { "X-No-Enterprise-Id": "1" }),
    ...(cred.domain ? { "X-Domain": cred.domain } : { "X-No-Department-Info": "1" }),
    ...attributionHeaders(),
    ...deviceHeaders(cred, config),
    ...conversationHeaders(),
    Authorization: `Bearer ${cred.accessToken}`,
  };
}

// ---------------------------------------------------------------------------
// body rewriting (channel-fingerprint neutralisation + shape normalisation)
// ---------------------------------------------------------------------------
function isUnapprovedChannelOpening(text) {
  const t = text.trimStart().toLowerCase();
  return UNAPPROVED_CHANNEL_OPENINGS.some((p) => t.startsWith(p));
}
function breakIdentityClauses(text) {
  return text.replace(IDENTITY_CLAUSE, (clause) => clause.replace(/(\s+)/gu, `$1${ZERO_WIDTH_SPACE}`));
}
function neutralizeScannedText(text) {
  const prefixed = isUnapprovedChannelOpening(text) ? `${NEUTRAL_SYSTEM}\n\n${text}` : text;
  const out = breakIdentityClauses(prefixed);
  return out === text ? undefined : out;
}
function scansOpening(role) { return role === "system" || role === "developer" || role === "assistant"; }
function rewriteTextParts(obj, fn) {
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  for (const m of msgs) {
    if (!m || !scansOpening(m.role)) continue;
    if (typeof m.content === "string") {
      const r = fn(m.content);
      if (r !== undefined) m.content = r;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          const r = fn(part.text);
          if (r !== undefined) part.text = r;
        }
      }
    }
  }
}
function ensureSystemHead(obj) {
  if (!Array.isArray(obj.messages) || obj.messages.length === 0) return;
  if (obj.messages[0].role !== "system") {
    obj.messages.unshift({ role: "system", content: NEUTRAL_SYSTEM });
  }
}
function suppressTools(obj) { delete obj.tools; delete obj.functions; }
function normalizeToolChoice(obj) {
  const tc = obj.tool_choice;
  if (tc === "none") { delete obj.tool_choice; suppressTools(obj); return; }
  if (tc && typeof tc === "object") {
    if (tc.type === "auto" || tc.type === "required") obj.tool_choice = tc.type;
    else if (tc.type === "function") obj.tool_choice = tc.function?.name || "auto";
    else { delete obj.tool_choice; suppressTools(obj); }
  }
}
function dropRefusedReasoning(obj) {
  if (obj.reasoning_effort === "off") delete obj.reasoning_effort;
}
export function prepareChatBody(source, modelId) {
  let obj;
  try { obj = typeof source === "string" ? JSON.parse(source) : JSON.parse(JSON.stringify(source)); }
  catch { throw new Error("prepareChatBody: invalid JSON body"); }
  if (modelId) obj.model = modelId;
  obj.stream = true;
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) if (m && m.role === "developer") m.role = "system";
  }
  ensureSystemHead(obj);
  rewriteTextParts(obj, neutralizeScannedText);
  normalizeToolChoice(obj);
  dropRefusedReasoning(obj);
  // max_completion_tokens -> max_tokens (WorkBuddy upstream only knows max_tokens)
  if (obj.max_completion_tokens !== undefined && obj.max_output_tokens === undefined) {
    obj.max_tokens = obj.max_completion_tokens;
  }
  delete obj.max_completion_tokens;
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// model catalog discovery
// ---------------------------------------------------------------------------
function parseUpstreamModel(v) {
  if (!v || typeof v !== "object") return null;
  const id = String(v.id || v.modelId || v.name || "");
  if (!id || v.disabled === true) return null;
  const ctx = Number(v.maxInputTokens ?? v.contextWindow ?? 200000) || 200000;
  const maxOut = Number(v.maxOutputTokens ?? v.maxTokens ?? 32000) || 32000;
  return {
    id,
    name: String(v.name || v.displayName || id),
    contextWindow: ctx,
    maxTokens: maxOut,
    supportsImages: v.disabledMultimodal !== true,
    supportsToolCall: v.supportsToolCall !== false,
    reasoning: v.reasoning || undefined,
    creditMultiplier: v.creditMultiplier ?? v.credit ?? undefined,
  };
}
function selectCliModels(data, keepIds = []) {
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const cli = agents.find((a) => a && a.name === "cli");
  let roster = Array.isArray(cli?.models) ? cli.models : [];
  if (roster.length === 0 && Array.isArray(data?.models)) {
    roster = data.models.map((m) => m?.id || m).filter(Boolean);
  }
  const all = new Map();
  if (Array.isArray(data?.models)) for (const m of data.models) {
    const p = parseUpstreamModel(m);
    if (p) all.set(p.id, p);
  }
  const out = [];
  for (const rid of roster) {
    const id = typeof rid === "string" ? rid : rid?.id;
    if (!id || ROUTER_MODEL_IDS.has(id)) continue;
    out.push(all.get(id) || { id, name: id, contextWindow: 200000, maxTokens: 32000, supportsImages: true, supportsToolCall: true });
  }
  for (const k of keepIds) if (all.has(k) && !out.some((m) => m.id === k)) out.push(all.get(k));
  return out;
}
function mergeRosters(primary, secondary) {
  const ids = new Set(primary.map((m) => m.id));
  return [...primary, ...secondary.filter((m) => !ids.has(m.id))];
}

export async function fetchModels(cred, config = {}, keepIds = []) {
  const base = chatBase(cred.domain, config.cnBase);
  const global = regionOf(cred.domain) === "global";
  const headersFor = (ua, withOrigin) => ({
    Authorization: `Bearer ${cred.accessToken}`,
    Accept: "application/json, text/plain, */*",
    ...(cred.uid ? { "X-User-Id": cred.uid } : {}),
    ...(cred.domain ? { "X-Domain": cred.domain } : {}),
    "X-Product": "SaaS",
    "X-Requested-With": "XMLHttpRequest",
    "Connection": "close",
    "User-Agent": ua,
    ...(withOrigin ? { Origin: originReferer(cred.domain), Referer: `${originReferer(cred.domain)}/` } : {}),
  });
  const getDoc = async (url, headers) => {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    if (!r.ok) throw new Error(`catalog http ${r.status}: ${t.slice(0, 200)}`);
    const env = JSON.parse(t);
    return env.data || env;
  };

  if (global) {
    const docs = [];
    for (const ua of [CATALOG_CLI_UA, APP_CHANNEL_UA]) {
      try { docs.push(await getDoc(`${base}${GLOBAL_CONFIG_PATH}`, headersFor(ua, false))); }
      catch { /* tolerate one channel failing */ }
    }
    if (docs.length === 0) throw new Error("global /v3/config unreachable in both channels");
    let models = [];
    for (const d of docs) models = mergeRosters(models, selectCliModels(d, keepIds));
    return models;
  }
  // CN: PRODUCT_UA app channel is richest; fall back to legacy CLI catalog.
  try {
    const d = await getDoc(`${base}${GLOBAL_CONFIG_PATH}`, headersFor(PRODUCT_UA, true));
    return selectCliModels(d, keepIds);
  } catch {
    const d = await getDoc(`${base}${LEGACY_CATALOG_PATH}`, headersFor(CLIENT_UA, true));
    return selectCliModels(d, keepIds);
  }
}

export async function fetchBusy(cred, modelIds, config = {}) {
  const base = chatBase(cred.domain, config.cnBase);
  try {
    const r = await fetch(`${base}${MODEL_BUSY_PATH}`, {
      method: "POST",
      headers: chatHeaders(cred, config),
      body: JSON.stringify({ models: modelIds.slice(0, 50) }),
      signal: AbortSignal.timeout(5000),
    });
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}

// ---------------------------------------------------------------------------
// streaming call
// ---------------------------------------------------------------------------
export async function chatStream(cred, bodyJson, config = {}, signal) {
  const base = chatBase(cred.domain, config.cnBase);
  const res = await fetch(`${base}${CHAT_PATH}`, {
    method: "POST",
    headers: chatHeaders(cred, config),
    body: bodyJson,
    signal: signal || AbortSignal.timeout(config.timeoutMs || 120000),
  });
  return res;
}

export const billingBaseUrl = billingBase;
