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

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
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

function neutralClone(template, model, index) {
  const slug = `${MODEL_PREFIX}/${model.id}`;
  const row = JSON.parse(JSON.stringify(template));
  row.slug = slug;
  row.display_name = model.name && model.name !== model.id
    ? `WB · ${model.name}` : `WB · ${model.id}`;
  row.description = `WorkBuddy subscription model ${model.id} (${model.contextWindow} ctx)`;
  row.context_window = model.contextWindow || 200000;
  row.max_context_window = model.contextWindow || 200000;
  row.visibility = "list";
  row.supported_in_api = true;
  // Routed models must not inherit GPT identity instructions, which the
  // WorkBuddy gateway rejects (error 11128). Use a neutral system template.
  if (row.model_messages) {
    row.model_messages.instructions_template = "You are a helpful assistant.";
    if (row.model_messages.persistent_instructions) row.model_messages.persistent_instructions = "";
  }
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
  const wbRows = models.map((m, i) => neutralClone(template, m, i));
  return { models: [...rows, ...wbRows] };
}

export function writeCatalog(models) {
  const p = catalogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const catalog = buildCatalog(models);
  fs.writeFileSync(p, JSON.stringify(catalog, null, 2), "utf8");
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
    fs.writeFileSync(backupPath(), cleaned, "utf8");
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
  if (!dryRun) fs.writeFileSync(p, next, "utf8");
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
  let content = stripInjected(current);
  if (fs.existsSync(backupPath())) {
    content = fs.readFileSync(backupPath(), "utf8");
    fs.unlinkSync(backupPath());
  }
  fs.writeFileSync(p, content, "utf8");
  try { fs.unlinkSync(catalogPath()); } catch { /* ignore */ }
  // Expire Codex's model cache so it re-reads on next launch.
  try {
    const cache = path.join(codexHome(), "models_cache.json");
    if (fs.existsSync(cache)) {
      const j = JSON.parse(fs.readFileSync(cache, "utf8"));
      j.fetched_at = 0;
      fs.writeFileSync(cache, JSON.stringify(j, null, 2), "utf8");
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
