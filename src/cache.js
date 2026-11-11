// Persistent model-list cache.
//
// Startup used to block on two upstream round trips (~1.4 s measured) before the
// gateway was ready at all, and Codex cannot reach a gateway that is not
// listening. So: serve the last known catalog immediately, then refresh it in the
// background and re-inject if anything actually changed.
//
// The freshness rule is "revalidate, don't trust": a cached entry is only used to
// make the process ready sooner, never to answer a model request. Every start
// still fetches; the cache merely decides what is published during the fetch.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CATALOG_CACHE_FILENAME } from "./constants.js";

export function cacheDir() {
  return process.env.WB_BRIDGE_STATE || path.join(os.homedir(), ".wb-bridge");
}
export function cachePath() {
  return path.join(cacheDir(), CATALOG_CACHE_FILENAME);
}

// A cached list older than this is still *served* (it gets Codex a working
// picker instantly) but is refreshed before the first request needs it.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function isValidEntry(entry) {
  return Boolean(entry)
    && Array.isArray(entry.models)
    && entry.models.length > 0
    && entry.models.every((m) => m && typeof m.id === "string")
    && typeof entry.region === "string";
}

export function readCachedModels() {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (!isValidEntry(j)) return null;
    return { ...j, ageMs: Date.now() - Number(j.savedAt || 0), stale: Date.now() - Number(j.savedAt || 0) > STALE_AFTER_MS };
  } catch {
    return null;
  }
}

export function writeCachedModels({ models, region, source }) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const payload = { savedAt: Date.now(), region, source, models };
    const tmp = `${cachePath()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, cachePath());
  } catch { /* the cache is an optimisation; never fail the start over it */ }
}

// Cheap identity for "did the list actually change". Compared on the fields the
// picker renders, so a flapping queue level does not trigger a rewrite.
export function modelsFingerprint(models) {
  return models
    .map((m) => [m.id, m.name, m.contextWindow, m.creditMultiplier, (m.badges || []).join("+"), m.supportsImages === false ? 0 : 1].join("\u0001"))
    .sort()
    .join("\u0002");
}
