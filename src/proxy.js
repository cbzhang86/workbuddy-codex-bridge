import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFile, execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Proxy-aware transport for the official OpenAI endpoint.
//
// Node's global fetch does NOT honour the Windows "Internet Settings" proxy
// registry value that every desktop app obeys, and NODE_USE_ENV_PROXY is read
// only once at process start. On a machine behind a local proxy the forwarded
// native-model requests therefore failed with 502 "fetch failed" while the
// Codex client itself reached the network fine -- silently breaking the
// zero-step rollback promise for the official subscription.
//
// So: detect the proxy the same way the OS does, tunnel with CONNECT, and
// stream the response back. No dependencies.
// ---------------------------------------------------------------------------

let probed = false;
let cached = null;

function normaliseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // "host:port" -> "http://host:port"
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!u.hostname) return null;
  // A proxy value with a path is a PAC script URL, not a proxy.
  if (u.pathname && u.pathname !== "/") return null;
  const proto = u.protocol === "https:" ? "https:" : "http:";
  return {
    protocol: proto,
    host: u.hostname,
    port: Number(u.port) || (proto === "https:" ? 443 : 80),
  };
}

function envProxy(env) {
  return (
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy ||
    ""
  );
}

function windowsRegistryProxy() {
  if (process.platform !== "win32") return "";
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const read = (name) => {
    try {
      const out = execFileSync("reg", ["query", key, "/v", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
        windowsHide: true,
      });
      const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i").exec(out);
      return m ? m[1].trim() : "";
    } catch { return ""; }
  };
  // REG_DWORD renders as 0x1, not "1".
  const enabled = read("ProxyEnable").toLowerCase();
  if (enabled !== "1" && enabled !== "0x1") return "";
  const server = read("ProxyServer");
  if (!server) return "";
  // "http=host:port;https=host:port" is the per-scheme form.
  if (server.includes("=")) {
    const parts = {};
    for (const chunk of server.split(";")) {
      const [k, v] = chunk.split("=");
      if (k && v) parts[k.trim()] = v.trim();
    }
    return parts.https || parts.http || "";
  }
  return server;
}

function windowsRegistryProxyExec() {
  if (process.platform !== "win32") return Promise.resolve("");
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  // Async on purpose: `reg query` costs ~55 ms of synchronous child-process time
  // per call, and doing that on the request path blocks every other connection
  // the gateway is streaming.
  const read = (name) => new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", name], { encoding: "utf8", timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve("");
      const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, "i").exec(String(stdout));
      resolve(m ? m[1].trim() : "");
    });
  });
  return (async () => {
    // Both values come from one key: read them together, because each spawn
    // costs tens of milliseconds of process setup.
    const [enabledRaw, server] = await Promise.all([read("ProxyEnable"), read("ProxyServer")]);
    // REG_DWORD renders as 0x1, not "1".
    const enabled = String(enabledRaw).toLowerCase();
    if (enabled !== "1" && enabled !== "0x1") return "";
    if (!server) return "";
    const parts = Object.fromEntries(
      server.split(";").map((s) => s.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim().toLowerCase(), v.trim()])
    );
    if (parts.http || parts.https) return parts.https || parts.http || "";
    return server;
  })();
}

export async function detectProxyAsync(env = process.env) {
  if (probed) return cached;
  const fromEnv = normaliseProxy(envProxy(env));
  const found = fromEnv || normaliseProxy(await windowsRegistryProxyExec());
  probed = true;
  cached = found;
  return cached;
}

export function detectProxy(env = process.env) {
  if (probed) return cached;
  probed = true;
  cached = normaliseProxy(envProxy(env)) || normaliseProxy(windowsRegistryProxy());
  return cached;
}

// Pay the registry cost once, off the request path, so the first forwarded
// native request never stumbles into a synchronous lookup.
export function primeProbe() {
  detectProxyAsync().catch(() => { /* best effort */ });
}

export function resetProxyCache() {
  probed = false;
  cached = null;
}

export function bypassProxy(hostname, env = process.env) {
  const list = (env.NO_PROXY || env.no_proxy || "").split(/[,\s]+/).filter(Boolean);
  const host = String(hostname).toLowerCase();
  return list.some((raw) => {
    const entry = raw.toLowerCase().replace(/^\./, "");
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry.startsWith("*.")) return host === entry.slice(2) || host.endsWith(entry.slice(1));
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function openTunnel({ proxy: px, host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const mod = px.protocol === "https:" ? https : http;
    const req = mod.request({
      host: px.host,
      port: px.port,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${host}:${port} returned ${res.statusCode}`));
        return;
      }
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.once("timeout", () => req.destroy(new Error("proxy CONNECT timed out")));
    req.once("error", reject);
    req.end();
  });
}

function pairHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

/**
 * POST `body` to `url`, tunnelling through the detected proxy when one applies.
 * Resolves to { status, headers: [[name, value], ...], stream } where `stream`
 * is the raw IncomingMessage.
 */
export async function requestThroughProxy(url, { method = "POST", headers = {}, body, timeoutMs = 300000, env = process.env } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === "https:";
  const port = Number(target.port) || (isHttps ? 443 : 80);

  const px = await detectProxyAsync(env);
  const tunnel = px && !bypassProxy(target.hostname, env)
    ? await openTunnel({ proxy: px, host: target.hostname, port, timeoutMs })
    : null;

  return await new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const options = {
      method,
      path: `${target.pathname}${target.search}`,
      // Cloudflare in front of chatgpt.com rejects requests without a UA.
      headers: { accept: "text/event-stream", "user-agent": "workbuddy-codex-bridge", ...headers },
      timeout: timeoutMs,
    };
    if (tunnel) {
      options.createConnection = () =>
        isHttps ? tls.connect({ socket: tunnel, servername: target.hostname, ALPNProtocols: ["http/1.1"] }) : tunnel;
      // With a custom createConnection Node has no host to derive the Host
      // header from, and Cloudflare rejects a request without one.
      options.headers = { host: target.host, ...options.headers };
    } else {
      options.host = target.hostname;
      options.port = port;
    }
    const req = mod.request(options);
    req.once("timeout", () => req.destroy(new Error("request timed out")));
    req.once("error", (err) => {
      if (tunnel) tunnel.destroy();
      reject(err);
    });
    req.once("response", (res) => {
      resolve({ status: res.statusCode || 0, headers: pairHeaders(res.rawHeaders), stream: res });
    });
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}
