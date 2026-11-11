// Codex config injection + shared model catalog management.
// Mirrors opencodex's loopback mode (verified against its official docs):
//   - keep the built-in `openai` provider id
//   - inject two ROOT keys before the first [table]:
//       model_catalog_json = "<abs path>/workbuddy-catalog.json"
//       openai_base_url    = "http://127.0.0.1:<port>/v1"
//   - every edit is wrapped in markers and fully reversible via `wb-bridge restore`
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { INJECT_BEGIN, INJECT_END, BACKUP_SUFFIX, CATALOG_FILENAME, MODEL_PREFIX } from "./constants.js";
import { busyLabel } from "./upstream.js";

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// Write beside the target, then rename. A half-written config.toml makes Codex
// refuse to load its config at all ("failed to load configuration"), which takes
// the official GPT models down with it -- so the file must never be observable
// in a partial state, however the process dies mid-write.
function writeAtomic(file, text) {
  const tmp = `${file}.wb-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    // Windows can refuse the rename while another process holds a handle on the
    // target (a running Codex reading config.toml). Fall back to a direct write
    // so the operation still lands, and never leave the .tmp behind.
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if (process.platform !== "win32") throw error;
    fs.writeFileSync(file, text, "utf8");
  }
}
export function configPath() { return path.join(codexHome(), "config.toml"); }
export function catalogPath() { return path.join(codexHome(), CATALOG_FILENAME); }
export function backupPath() { return configPath() + BACKUP_SUFFIX; }

// ---------------------------------------------------------------------------
// Native catalog rows: clone from Codex's own models_cache.json so the strict
// deserialiser accepts every field (reasoning levels, shell_type, messages…).
// ---------------------------------------------------------------------------
function loadNativeModels() {
  const p = path.join(codexHome(), "models_cache.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(j?.models) && j.models.length) return j.models;
  } catch { /* absent / malformed */ }
  return null;
}

function neutralTemplate() {
  // Minimal-but-complete native-shaped template used when models_cache.json is
  // unavailable. Kept deliberately conservative.
  return {
    slug: "gpt-5.1", display_name: "GPT-5.1", description: "OpenAI model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast" },
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Thorough" },
    ],
    shell_type: "default", visibility: "list", supported_in_api: true,
    priority: 100, context_window: 272000, max_context_window: 272000,
    truncation_policy: { mode: "tokens", limit: 10000 },
    input_modalities: ["text", "image"],
    apply_patch_tool_type: "freeform", web_search_tool_type: "text",
    tool_mode: "default", supports_parallel_tool_calls: true,
    support_verbosity: true, default_verbosity: "medium",
    model_messages: { instructions_template: "You are a helpful assistant." },
    supports_image_detail_original: true,
  };
}

// The native template carries ~63 KB of `model_messages`, most of it rebuilt for
// every routed row. Only a handful of those keys mean anything for a model that
// is reached through a foreign provider:
//   approvals / permissions -- how Codex gates local tool use, which still runs
//     on the user's machine and must keep working
// The rest (confirmation_policies 24 KB, guardian_v2, token_budget, multi_agent,
// collaboration_modes, auto_review) describes OpenAI's own review/quotas and is
// dead weight for a routed row. Keeping it cost ~604 KB of catalog and 4 ms of
// cloning per build; dropping it takes the catalog to roughly a tenth.
//
// instructions_template / persistent_instructions are replaced, not copied: a
// routed model must not inherit the GPT identity text, which the WorkBuddy
// gateway rejects (error 11128).
const ROUTED_MESSAGE_KEYS = ["approvals", "permissions"];
const NEUTRAL_INSTRUCTIONS = "You are a helpful assistant.";

function slimModelMessages(template) {
  const source = template && typeof template === "object" ? template : {};
  const out = {};
  for (const key of ROUTED_MESSAGE_KEYS) {
    if (Object.hasOwn(source, key)) out[key] = source[key];
  }
  // A template must exist: a routed row without one falls back to the heavy
  // native default and re-introduces exactly the weight this drops.
  out.instructions_template = NEUTRAL_INSTRUCTIONS;
  out.persistent_instructions = "";
  return out;
}

function neutralClone(template, model, index) {
  const slug = `${MODEL_PREFIX}/${model.id}`;
  const row = JSON.parse(JSON.stringify(template));
  row.slug = slug;
  // The picker renders display_name only, so the pricing badge and any promo
  // must live there. Format mirrors dsh-connect-workbuddy:
  //   "<name> · x0.11"  with promo badges appended as "<name> · x0.11 · 限时免费".
  const displayName = model.name && model.name !== model.id ? model.name : model.id;
  const parts = [`WB · ${displayName}`];
  if (typeof model.creditMultiplier === "number") parts.push(`x${model.creditMultiplier.toFixed(2)}`);
  for (const badge of model.badges || []) parts.push(badge);
  row.display_name = parts.join(" · ");
  const detail = [`WorkBuddy subscription model ${model.id}`, `${model.contextWindow} ctx`];
  if (typeof model.creditMultiplier === "number") detail.push(`cost x${model.creditMultiplier.toFixed(2)} credits`);
  if (model.badges?.length) detail.push(`promo: ${model.badges.join(", ")}`);
  if (model.busyLevel) detail.push(`queue: ${busyLabel(model.busyLevel)}`);
  row.description = detail.join(" · ");
  row.context_window = model.contextWindow || 200000;
  row.max_context_window = model.contextWindow || 200000;
  row.visibility = "list";
  row.supported_in_api = true;
  // The template already carries the neutral identity (see buildCatalog), so
  // only the per-model overrides are needed here.
  row.model_messages = { ...row.model_messages };
  // code_mode_only mirrors what opencodex publishes for routed entries; keep
  // the native tool_mode when present so local exec/MCP tools stay available.
  if (row.tool_mode === "default") row.tool_mode = "default";
  row.priority = 200 + index;
  if (model.supportsImages === false) {
    row.input_modalities = (Array.isArray(row.input_modalities) ? row.input_modalities : ["text", "image"])
      .filter((m) => m !== "image");
    if (!row.input_modalities.includes("text")) row.input_modalities.push("text");
  }
  if (model.supportsToolCall === false) {
    row.tool_mode = "none";
    row.supports_parallel_tool_calls = false;
  }
  return row;
}

export function buildCatalog(models) {
  const native = loadNativeModels();
  const template = native ? native[0] : neutralTemplate();
  const rows = native ? native.map((r) => JSON.parse(JSON.stringify(r))) : [JSON.parse(JSON.stringify(template))];
  // Clone the already-slimmed messages, not the 63 KB native blob, so each row
  // copies a few hundred bytes instead of sixty kilobytes.
  const slim = slimModelMessages(template);
  const wbRows = models.map((m, i) => neutralClone({ ...template, model_messages: slim }, m, i));
  // Several ids share a product name on purpose: hy4free/hy4std are the free and
  // the credit-billed tier of Hy4; hy3/hy3-x likewise. They are distinct
  // offerings, NOT duplicates, so the name must stay. The price and promo are
  // already part of display_name, which keeps the rows distinguishable
  // ("WB · Hy4 · x0.00 · 限时免费" vs "WB · Hy4 · x0.29"). Only fall back to the
  // raw id if two rows would still be byte-identical.
  const seen = new Set();
  for (const r of wbRows) {
    if (!seen.has(r.display_name)) { seen.add(r.display_name); continue; }
    const id = r.slug.slice(r.slug.indexOf("/") + 1);
    r.display_name = `${r.display_name} · ${id}`;
    seen.add(r.display_name);
  }
  return { models: [...rows, ...wbRows] };
}

export function writeCatalog(models) {
  const p = catalogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const catalog = buildCatalog(models);
  const text = JSON.stringify(catalog, null, 2);
  // Rewriting an identical 512 KB file costs ~30 ms and churns the disk on every
  // start, which matters now that a cached list makes the rest of the boot fast.
  let current = null;
  try { current = fs.readFileSync(p, "utf8"); } catch { /* first run */ }
  if (current !== text) writeAtomic(p, text);
  return { path: p, native: catalog.models.length - models.length, injected: models.length };
}

// ---------------------------------------------------------------------------
// TOML injection
// ---------------------------------------------------------------------------
function stripInjected(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === INJECT_BEGIN) { skipping = true; continue; }
    if (line.trim() === INJECT_END) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function findFirstTableLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]) && !/^\s*\[\[/.test(lines[i])) return i;
  }
  return lines.length;
}

export function injectConfig({ port, catalogFile, dryRun = false }) {
  const p = configPath();
  if (!fs.existsSync(p)) throw new Error(`Codex config not found: ${p}`);
  const original = fs.readFileSync(p, "utf8");
  const cleaned = stripInjected(original);
  const lines = cleaned.split(/\r?\n/);

  // Save a pristine backup exactly once (so restore always returns to the
  // user's own config, never to a half-injected state).
  if (!fs.existsSync(backupPath())) {
    writeAtomic(backupPath(), cleaned);
  }

  const insertAt = findFirstTableLine(lines);
  const block = [
    INJECT_BEGIN,
    `model_catalog_json = "${catalogFile.replace(/\\/g, "/")}"`,
    `openai_base_url = "http://127.0.0.1:${port}/v1"`,
    // The subscription backend is stateless: force Codex to send the FULL
    // input array on every turn instead of relying on previous_response_id.
    `disable_response_storage = true`,
    INJECT_END,
  ];
  const next = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)].join("\n");
  if (!dryRun) writeAtomic(p, next);
  return { configPath: p, insertAt, wrote: !dryRun, preview: next.split("\n").slice(Math.max(0, insertAt - 2), insertAt + 6).join("\n") };
}

export function restoreConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    // Nothing to restore; still clean up the catalog if present.
    try { fs.unlinkSync(catalogPath()); } catch { /* ignore */ }
    return { restored: false, reason: "config.toml missing" };
  }
  const current = fs.readFileSync(p, "utf8");
  const hadBlock = current.includes(INJECT_BEGIN);
  const hadBackup = fs.existsSync(backupPath());
  // Nothing of ours is in there: say so instead of rewriting the file and
  // reporting a restore that did not happen.
  if (!hadBlock && !hadBackup) {
    try { fs.unlinkSync(catalogPath()); } catch { /* ignore */ }
    return { restored: false, reason: "not injected", configPath: p };
  }
  let content = stripInjected(current);
  if (hadBackup) {
    content = fs.readFileSync(backupPath(), "utf8");
    fs.unlinkSync(backupPath());
  }
  writeAtomic(p, content);
  // Only delete the catalog if nothing points at it any more. Deleting a file
  // that the restored config still references makes Codex fail to load its
  // config at all ("failed to load configuration") -- every model, including
  // the official ones, stops working. Cheap to check, catastrophic to skip.
  if (!content.includes(CATALOG_FILENAME)) {
    try { fs.unlinkSync(catalogPath()); } catch { /* ignore */ }
  }
  // Expire Codex's model cache so it re-reads on next launch.
  try {
    const cache = path.join(codexHome(), "models_cache.json");
    if (fs.existsSync(cache)) {
      const j = JSON.parse(fs.readFileSync(cache, "utf8"));
      j.fetched_at = 0;
      writeAtomic(cache, JSON.stringify(j, null, 2));
    }
  } catch { /* non-fatal */ }
  return { restored: true, configPath: p };
}

export function injectionStatus() {
  const p = configPath();
  const exists = fs.existsSync(p);
  const text = exists ? fs.readFileSync(p, "utf8") : "";
  return {
    configPath: p,
    injected: text.includes(INJECT_BEGIN),
    backupExists: fs.existsSync(backupPath()),
    catalogExists: fs.existsSync(catalogPath()),
  };
}
