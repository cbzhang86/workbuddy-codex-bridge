// Credential discovery + refresh for the local WorkBuddy desktop subscription.
// Priority (matches how dsh-connect-workbuddy actually persists tokens):
//   1. explicit credentialFile in config
//   2. DSH_HOME/workbuddy-vault/<region>/*.json   (PLAINTEXT, already decrypted)
//   3. DSH_HOME/.workbuddy-auth.<region>.json / legacy .workbuddy-auth.json
//   4. desktop *.info encrypted file + at-rest key from the WorkBuddy app
//   5. `wb-bridge login` device OAuth (writes its own plaintext file)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CN_CHAT_BASE, GLOBAL_BASE, GLOBAL_CODEBUDDY_BASE, REFRESH_PATH,
  CHAT_PATH, CLIENT_UA, CN_BILLING_BASE,
  OAUTH_STATE_PATH, OAUTH_TOKEN_PATH, OAUTH_ACCOUNT_PATH, CHECKIN_PATH,
  SESSION_DEAD_MARKERS, CREDIT_MARKERS,
} from "./constants.js";

const execFileAsync = promisify(execFile);
const isGlobalDomain = (d) => /\.(workbuddy|codebuddy)\.ai$/iu.test(d || "");
export const regionOf = (d) => (isGlobalDomain(d) ? "global" : "cn");

export function chatBase(domain, cnBaseOverride) {
  if (isGlobalDomain(domain)) {
    return /codebuddy\.ai/iu.test(domain) ? GLOBAL_CODEBUDDY_BASE : GLOBAL_BASE;
  }
  return cnBaseOverride || CN_CHAT_BASE;
}
export function billingBase(domain) {
  return isGlobalDomain(domain)
    ? (/codebuddy\.ai/iu.test(domain) ? GLOBAL_CODEBUDDY_BASE : GLOBAL_BASE)
    : CN_BILLING_BASE;
}
export function originReferer(domain) {
  return billingBase(domain);
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}
function ownAuthPath(region) {
  return path.join(dshHome(), `.workbuddy-auth.${region}.json`);
}
function legacyOwnAuthPath() {
  return path.join(dshHome(), ".workbuddy-auth.json");
}
function vaultDir(region) {
  return path.join(dshHome(), "workbuddy-vault", region);
}

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}
function expiryToMs(v) {
  if (!v || v <= 0) return 0;
  return v > 0xe8d4a51000 ? v : v * 1000;
}

// A credential is the normalised shape every other module consumes.
function normalize(raw, source, filePath) {
  if (!raw) return null;
  const auth = raw.auth || raw;
  const account = raw.account || raw;
  const accessToken = auth.accessToken || auth.access_token;
  if (!accessToken || typeof accessToken !== "string") return null;
  return {
    accessToken,
    refreshToken: auth.refreshToken || auth.refresh_token || "",
    expiresAtMs: expiryToMs(auth.expiresAt ?? auth.expires_at),
    domain: auth.domain || "",
    uid: String(account.uid || account.userId || account.uniqueUserId || ""),
    enterpriseId: String(account.enterpriseId || account.enterprise_id || ""),
    nickname: String(account.nickname || ""),
    uin: String(account.uin || ""),
    source,
    filePath,
  };
}

// ---- at-rest decryption of the desktop .info file (WorkBuddy 5.6+) --------
function deriveAtRestKey(payloadJson) {
  const payload = JSON.parse(payloadJson);
  const secret = payload.atRestSecretKey;
  if (typeof secret !== "string") throw new Error("at-rest key payload carries no atRestSecretKey");
  // NB: hash the base64 STRING itself, not decoded bytes (verified against plugin).
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}
function deriveAtRestKeyId(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}
function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; }
function lp(s) { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); }
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("envelope keyId is malformed");
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"), Buffer.from([1]),
    lp("WBEV1"), lp("sym-v1"), u32(suite), lp(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ]);
}
function openEncryptedField(wrapper, key) {
  const env = JSON.parse(Buffer.from(wrapper.envelope, "base64").toString("utf8"));
  const expect = deriveAtRestKeyId(key);
  if (env.keyId !== expect) {
    throw new Error(`encrypted field belongs to key ${env.keyId}, not ${expect}`);
  }
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.nonce, "base64"), { authTagLength: 16 });
  d.setAAD(fieldAad(env.keyId, env.suite));
  d.setAuthTag(Buffer.from(env.authTag, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(env.ciphertext, "base64")), d.final(),
  ]).toString("utf8");
}
function maybeDecrypt(value, key) {
  if (typeof value === "string") return value;
  if (value && value.$wbEncrypted === 1 && typeof value.envelope === "string") {
    if (!key) return undefined;
    try { return openEncryptedField(value, key); } catch { return undefined; }
  }
  return undefined;
}

function appExecutableCandidates(home, env) {
  const out = [];
  if (env.WORKBUDDY_APP_EXECUTABLE) out.push(env.WORKBUDDY_APP_EXECUTABLE);
  if (process.platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean);
    const subs = [["Programs", "WorkBuddy"], ["WorkBuddy"], ["Programs", "WorkBuddyAI"], ["WorkBuddyAI"]];
    for (const r of roots) for (const s of subs) for (const n of ["WorkBuddy.exe", "WorkBuddyAI.exe"])
      out.push(path.join(r, ...s, n));
  } else if (process.platform === "darwin") {
    for (const base of ["/Applications", path.join(home, "Applications")])
      for (const n of ["WorkBuddy.app", "WorkBuddy AI.app"])
        out.push(path.join(base, n, "Contents", "MacOS", n.replace(/\.app$/, "")));
  }
  return out.filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
async function fetchAtRestKeyPayload(executable) {
  const script = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
  const { stdout } = await execFileAsync(executable, ["-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 10000, windowsHide: true, maxBuffer: 1048576,
  });
  const t = stdout.trim();
  if (!t) throw new Error("desktop app returned an empty at-rest key payload");
  return t;
}
let keyCache;
async function readAtRestKey() {
  if (keyCache !== undefined) return keyCache;
  try {
    for (const exe of appExecutableCandidates(os.homedir(), process.env)) {
      try { keyCache = deriveAtRestKey(await fetchAtRestKeyPayload(exe)); return keyCache; }
      catch { /* try next candidate */ }
    }
  } catch { /* ignore */ }
  keyCache = null;
  return null;
}

function desktopAuthDirs() {
  const home = os.homedir();
  const env = process.env;
  if (process.platform === "win32") {
    return [
      path.join(env.LOCALAPPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth"),
      path.join(env.APPDATA || "", "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  return [
    path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "CodeBuddyExtension", "Data", "Public", "auth"),
    path.join(home, ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"),
  ];
}

async function parseDesktopInfo(file) {
  const raw = safeJson(file);
  if (!raw) return null;
  let key = null;
  const needsKey = [raw.auth?.accessToken, raw.auth?.refreshToken].some(
    (v) => v && typeof v === "object" && v.$wbEncrypted === 1);
  if (needsKey) key = await readAtRestKey();
  const auth = raw.auth || {};
  const account = raw.account || {};
  return normalize({
    auth: {
      accessToken: maybeDecrypt(auth.accessToken, key),
      refreshToken: maybeDecrypt(auth.refreshToken, key),
      expiresAt: auth.expiresAt, refreshExpiresAt: auth.refreshExpiresAt,
      lastRefreshTime: auth.lastRefreshTime, domain: auth.domain,
    },
    account,
  }, "desktop", file);
}

// ---- public discovery ------------------------------------------------------
export async function discoverCredential(config = {}) {
  const region = config.region || "cn";
  const tried = [];
  if (config.credentialFile) {
    const c = normalize(safeJson(path.resolve(config.credentialFile)), "credentialFile", config.credentialFile);
    if (c) return c;
    tried.push(`credentialFile ${config.credentialFile}`);
  }
  // vault: plaintext already-decrypted copies written by dsh-connect-workbuddy
  for (const dir of [vaultDir(region), ...(region === "cn" ? [vaultDir("global")] : [vaultDir("cn")])]) {
    try {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const p = path.join(dir, f);
        const c = normalize(safeJson(p), "vault", p);
        if (c && (regionOf(c.domain) === region || !c.domain)) return c;
      }
    } catch { /* dir absent */ }
  }
  for (const p of [ownAuthPath(region), legacyOwnAuthPath()]) {
    const c = normalize(safeJson(p), "own", p);
    if (c) return c;
  }
  for (const dir of desktopAuthDirs()) {
    for (const name of ["workbuddy-desktop.info", "workbuddy-desktop-ai.info"]) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const c = await parseDesktopInfo(p);
      if (c && (regionOf(c.domain) === region || !c.domain)) return c;
      tried.push(`desktop ${p}`);
    }
  }
  const err = new Error(
    `no WorkBuddy ${region} credential found (tried: ${tried.join(", ") || "vault/own/desktop"}); ` +
    `run: wb-bridge login --region ${region}`);
  err.code = "NO_CREDENTIAL";
  throw err;
}

// ---- refresh ---------------------------------------------------------------
function commonHeaders(cred) {
  const origin = originReferer(cred.domain);
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": CLIENT_UA,
  };
}
function refreshHeaders(cred) {
  return {
    ...commonHeaders(cred),
    "Content-Type": "application/json",
    "X-Refresh-Token": cred.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
    ...(cred.enterpriseId ? { "X-Enterprise-Id": cred.enterpriseId } : {}),
  };
}

export function needsRefresh(cred, withinMs = 120000) {
  return !cred.expiresAtMs || cred.expiresAtMs - Date.now() < withinMs;
}

export async function refreshCredential(cred, config = {}) {
  if (!cred.refreshToken) throw new Error("credential has no refreshToken; re-login required");
  const base = chatBase(cred.domain, config.cnBase);
  const res = await fetch(`${base}${REFRESH_PATH}`, {
    method: "POST", headers: refreshHeaders(cred), body: "{}",
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let env;
  try { env = JSON.parse(text); } catch { throw new Error(`refresh returned non-JSON (http ${res.status})`); }
  const data = env.data || {};
  if (!res.ok || (env.code && env.code !== 0 && env.code !== 200) || !data.accessToken) {
    throw new Error(`token refresh failed (http ${res.status}, code ${env.code}): ${env.msg || text.slice(0, 200)}`);
  }
  cred.accessToken = data.accessToken;
  if (data.refreshToken) cred.refreshToken = data.refreshToken;
  if (data.expiresIn > 0) cred.expiresAtMs = Date.now() + data.expiresIn * 1000;
  if (data.domain) cred.domain = data.domain;
  // Persist back to our own plaintext file so a restart reuses the fresh token.
  try {
    const p = ownAuthPath(regionOf(cred.domain));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      version: 1,
      auth: {
        accessToken: cred.accessToken, refreshToken: cred.refreshToken,
        expiresAt: Math.floor(cred.expiresAtMs / 1000), domain: cred.domain,
        lastRefreshTime: Date.now(),
      },
      account: { uid: cred.uid, enterpriseId: cred.enterpriseId, nickname: cred.nickname, uin: cred.uin },
    }, null, 2), { mode: 0o600 });
    cred.filePath = p;
  } catch { /* non-fatal */ }
  return cred;
}

export async function ensureFreshCredential(cred, config = {}) {
  if (needsRefresh(cred)) return await refreshCredential(cred, config);
  return cred;
}

// ---- device OAuth login ----------------------------------------------------
function firstString(obj, keys) {
  for (const k of keys) if (typeof obj?.[k] === "string" && obj[k]) return obj[k];
  return "";
}
function expiryMs(obj) {
  const v = obj.expiresAt ?? obj.expires_at ?? obj.ExpiresAt;
  if (v) return expiryToMs(Number(v) || 0);
  const i = obj.expiresIn ?? obj.expires_in ?? obj.ExpiresIn;
  return i ? Date.now() + Number(i) * 1000 : 0;
}

export async function oauthLogin({ region = "cn", onUri = () => {} } = {}) {
  const base = region === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
  const startRes = await fetch(`${base}${OAUTH_STATE_PATH}`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}", signal: AbortSignal.timeout(30000),
  });
  const startEnv = await startRes.json().catch(() => ({}));
  const d = startEnv.data || startEnv;
  const state = firstString(d, ["state", "State"]);
  if (!state) throw new Error(`oauth start failed: ${JSON.stringify(startEnv).slice(0, 300)}`);
  const authUrl = firstString(d, ["authUrl", "auth_url", "url", "Url"]) ||
    `${base}/login?state=${encodeURIComponent(state)}`;
  onUri(authUrl);

  const deadline = Date.now() + 600000;
  let tokenData = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await fetch(`${base}${OAUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000),
      });
      const env = await r.json().catch(() => ({}));
      const td = env.data || env;
      if ((env.code === 0 || env.code === 200 || env.code === undefined) && firstString(td, ["accessToken", "access_token", "AccessToken"])) {
        tokenData = td; break;
      }
    } catch { /* keep polling */ }
  }
  if (!tokenData) throw new Error("oauth login timed out (10 min)");
  const accessToken = firstString(tokenData, ["accessToken", "access_token", "AccessToken"]);
  let profile = {};
  try {
    const r = await fetch(`${base}${OAUTH_ACCOUNT_PATH}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`, Accept: "application/json",
        ...(tokenData.domain ? { "X-Domain": tokenData.domain } : {}),
      }, signal: AbortSignal.timeout(30000),
    });
    profile = (await r.json().catch(() => ({})))?.data || {};
  } catch { /* profile optional */ }

  const cred = {
    accessToken,
    refreshToken: firstString(tokenData, ["refreshToken", "refresh_token", "RefreshToken"]),
    expiresAtMs: expiryMs(tokenData),
    domain: firstString(tokenData, ["domain", "Domain"]) || (region === "global" ? "www.workbuddy.ai" : "www.workbuddy.cn"),
    uid: String(firstString(profile, ["uid", "userId", "Uid"]) || firstString(tokenData, ["uid", "userId"])),
    enterpriseId: String(firstString(profile, ["enterpriseId", "enterprise_id"]) || firstString(tokenData, ["enterpriseId", "enterprise_id"])),
    nickname: firstString(profile, ["nickname", "NickName", "ScreenName"]),
    uin: String(firstString(profile, ["uin", "Uin"])),
    source: "oauth",
  };
  // daily checkin + persist
  try {
    await fetch(`${base}${CHECKIN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        Authorization: `Bearer ${accessToken}`, "X-Requested-With": "XMLHttpRequest",
        Origin: base, Referer: `${base}/`, "User-Agent": CLIENT_UA,
      },
      body: "{}", signal: AbortSignal.timeout(15000),
    });
  } catch { /* non-fatal */ }
  const p = ownAuthPath(region);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    auth: {
      accessToken: cred.accessToken, refreshToken: cred.refreshToken,
      expiresAt: Math.floor((cred.expiresAtMs || Date.now() + 3600000) / 1000),
      domain: cred.domain, lastRefreshTime: Date.now(),
    },
    account: { uid: cred.uid, enterpriseId: cred.enterpriseId, nickname: cred.nickname, uin: cred.uin },
  }, null, 2), { mode: 0o600 });
  cred.filePath = p;
  return cred;
}

export function classifyUpstream(status, body) {
  const s = String(body || "");
  if (status === 402 || CREDIT_MARKERS.some((m) => s.toLowerCase().includes(m.toLowerCase()))) return "hard_credit";
  if (SESSION_DEAD_MARKERS.some((m) => s.includes(m))) return "session_dead";
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  if (/\b11128\b/.test(s)) return "channel_reject";
  if (/\b11133\b/.test(s)) return "invalid_params";
  if (/\b11140\b/.test(s)) return "account_restricted";
  if (/\b11101\b/.test(s)) return "non_stream_rejected";
  if (/\b11102\b/.test(s)) return "unknown_model";
  return "client";
}
