<div align="center">

# workbuddy-codex-bridge

**Pick WorkBuddy's models right inside the official ChatGPT desktop app — then get back to your official subscription whenever you want.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#for-developers)
[![Tests](https://img.shields.io/badge/tests-36%20passing-success.svg)](#self-check)
[![Rollback](https://img.shields.io/badge/rollback-0%20steps%20%7C%201%20command-blue.svg)](#going-back)
[![Status](https://img.shields.io/badge/status-experimental-orange.svg)](#troubleshooting)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

> [!WARNING]
> **This is an unofficial tool and it breaks the upstream rules.**
>
> Your WorkBuddy subscription is licensed *for interactive coding tools only*. Tencent forbids automation, custom backends, and batch use — and this project is exactly that pattern. **Your account or plan can be rate-limited or terminated.** If that is not acceptable to you, stop reading and [use the official TokenHub API](https://cloud.tencent.com/document/product/1823/133532) instead: it is a supported, documented way to reach the same models from Codex.

---

## What you get

You pay for WorkBuddy. It unlocks about 16 models — GLM-5.3, Kimi-K3.1, DeepSeek-V4.1, MiniMax-M3.1, and so on. The catch: you can only talk to them **inside the WorkBuddy app**.

This project puts all of them into the **official ChatGPT desktop app**'s model dropdown, next to GPT. Pick one, chat normally. Tools, streaming, reasoning all work.

And the part most tools get wrong — **going back is trivial**:

| You want to… | What you do |
| --- | --- |
| Use an official GPT model again | **Nothing.** Pick it in the dropdown. |
| Remove this project entirely | **One command:** `wb-bridge restore`. Then reopen the app. |

No uninstalling, no editing config files by hand, no "did I put that line back?" anxiety.

---

## Quick start

**You need:** Node.js 22+ and a ChatGPT desktop app that has Codex mode. WorkBuddy does not have to be running.

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
node bin/wb-bridge.js start
```

That single command finds your subscription, reads the model list, registers everything, and starts a local gateway on `127.0.0.1:10100`. Leave it running.

> [!IMPORTANT]
> **Now fully quit the ChatGPT app — closing the window is not enough.**
>
> Use the tray / menu-bar *Quit*, or end every `ChatGPT.exe` in Task Manager. The app reads its model list only at startup, so a window close changes nothing.

Reopen it, switch to **Codex mode**, and open the model dropdown. You will see entries like `WB · GLM-5.3 · x0.69` alongside your usual GPT models. Pick one and type.

That's it — three steps, no config editing.

---

## The model list

Every row shows its **credit multiplier** so you can see the cost before you click. This is the author's CN subscription; your list is read live from your own account, so it may differ.

| In the dropdown | Context | Cost |
| --- | --- | --- |
| `WB · Hy4 · x0.00 · 限时免费` | 960 K | free tier |
| `WB · Hy4 · x0.29` | 960 K | 0.29× |
| `WB · Hy3 · x0.00 · 限时免费` | 192 K | free tier |
| `WB · Hy3 · x0.05` | 192 K | 0.05× |
| `WB · GLM-5.3` | 1 M | 0.69× |
| `WB · GLM-5.3-Flash` | 1 M | 0.08× |
| `WB · GLM-5.2 · 夜间折扣` | 1 M | 0.79× |
| `WB · DeepSeek-V4.1-Flash` | 1 M | 0.11× |
| `WB · DeepSeek-V4-Pro` | 1 M | 0.51× |
| `WB · Kimi-K3.1-Pro` | 1 M | 0.97× |
| `WB · Kimi-K3` | 1 M | 1.62× |
| `WB · Kimi-K2.8-Preview` | 1 M | 0.77× |
| `WB · MiniMax-M3.1-Flash` | 1 M | 0.08× |
| `WB · Space-Bunny` | 1 M | 0.08× |
| `WB · Step-5-Preview` | 1 M | 0.33× |
| `WB · Xiaomi MiMo-V2.6-Pro` | 1 M | 0.13× |

`Hy4` and `Hy3` each appear twice on purpose: once as a **free tier** and once as a **paid tier**. Same model, different billing. The price tag is what tells them apart.

Run `node bin/wb-bridge.js models` any time to print your own list with live queue status.

---

## Going back

Two different things people mean by "going back", two different answers:

**"I just want to use GPT-4/Jupiter/Terra for a minute."**
Do nothing special. Pick it from the dropdown. The bridge sees a request without the `WB/` prefix and passes it straight through to OpenAI with your normal login. Your official subscription keeps working the entire time — the gateway is only involved for WorkBuddy models.

**"I want this off my machine."**

```bash
node bin/wb-bridge.js restore
```

Then quit and reopen the ChatGPT app. Done.

`restore` removes only what it added. It restores your original `config.toml` from a backup taken before the first run, deletes the generated model list, and never touches unrelated settings or your login.

> Hand-editing config files yourself would take 2–3 steps and one mistake. This is 0 or 1.

---

## Network and proxy

This trips people up, so plainly:

- **WorkBuddy runs on domestic servers.** It does **not** need a proxy. Works with your proxy on or off.
- **Official GPT models need your proxy**, obviously — that is not something this project can change.
- **Both at once is fine.** The bridge decides per request: WorkBuddy models go direct, GPT models go out through your proxy.

Verified on a real machine: proxy on → both model types work; proxy fully off → WorkBuddy models still work, GPT models fail as expected.

If your proxy settings live in Windows' Internet Settings, the bridge reads them automatically. Environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) take priority if you prefer those.

---

## Troubleshooting

**The dropdown only shows GPT models.**
You probably did not *fully* quit the app. A window close is not a quit. Check with `node bin/wb-bridge.js status`, then quit the helper processes too.

**A model name shows as "Custom" instead of `WB · …`.**
Some desktop builds apply a second, server-side allowlist that filters the dropdown. Routing still works — the request reaches the right model. If you need to be sure, set `model = "wb/glm-5.3"` in `~/.codex/config.toml` and restart.

**It worked yesterday, now it does not.**
Your token probably expired. Restart the gateway; it renews automatically. If you have not opened WorkBuddy in months, log in once there so a fresh credential lands on disk.

**I hit my ChatGPT quota and every WorkBuddy model greyed out.**
An OpenAI-side rule, not ours: when your native quota runs out the app disables other rows for the rest of the window. Wait for the reset, or use `codex` from the terminal.

**Switching models mid-conversation errors out.**
Start a new conversation. Codex keeps per-turn tool records, and switching provider mid-thread can leave them mismatched.

**"正在重新连接 5/5" in the status bar.**
Fixed in v1.1.0. Update and restart. If you still see it, check that the version you are running matches the repo.

Anything else: open an issue with your OS, Node version, and the error text.

---

## For developers

Everything below is implementation detail. Skip it if you just want to use the thing.

<details>
<summary><b>Why this exists (and why a new gateway)</b></summary>

Three obstacles make the naive approach fail:

1. **Protocol mismatch.** Codex speaks only the Responses API. WorkBuddy's backend speaks Chat Completions with proprietary identity headers. No wire compatibility.
2. **Encrypted desktop login.** Since WorkBuddy 5.6 the local credential file is sealed with AES-256-GCM; only the app can open it.
3. **No first-class provider.** [opencodex](https://opencodex.me/) exposes `workbuddy-ai` (the *international* subscription) only. The domestic subscription has no OAuth provider there, and opencodex's `headers` field explicitly rejects `Authorization` / cookie / API-key headers.

This project absorbs the useful parts of two prior efforts but ships as one self-contained process:

| Source | Absorbed |
| --- | --- |
| [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | The wire protocol: credential discovery and refresh, the identity-header set, conversation-identity triple, body rewriting, fingerprint neutralisation, catalog discovery, streaming, error classification. |
| [opencodex](https://opencodex.me/) | The loopback injection strategy: keep the built-in provider, inject two root-level keys, publish a shared catalogue — fully reversible, never touching `auth.json`. |

</details>

<details>
<summary><b>Architecture</b></summary>

```
ChatGPT desktop app · Codex mode
  │  model = wb/glm-5.3
  ▼
~/.codex/config.toml   →  openai_base_url = http://127.0.0.1:10100/v1
  ▼
workbuddy-codex-bridge   127.0.0.1:10100   (one Node process, no dependencies)
  │  Responses ⇄ Chat Completions translation
  │  + credential refresh / identity headers / body rewriting
  ├─ wb/*     → https://copilot.tencent.com/v2/chat/completions
  └─ anything → https://chatgpt.com/backend-api/codex   (0-step rollback)
```

The bridge also speaks the Responses **WebSocket** transport. Codex dials `ws://127.0.0.1:<port>/v1/responses` first and used to pay ~16 s of retries before falling back; completing the RFC 6455 handshake removes that entirely. `sec-websocket-extensions` is deliberately not negotiated.

</details>

<details>
<summary><b>Commands</b></summary>

| Command | What it does |
| --- | --- |
| `wb-bridge start` | Discover, register, inject, and serve. The normal one. |
| `wb-bridge setup` | Register and inject, but do not start serving. |
| `wb-bridge models` | Print your account's models with cost and queue status. |
| `wb-bridge status` | Is it injected? Is it listening? |
| `wb-bridge login` | Browser sign-in, when no local credential exists. |
| `wb-bridge restore` | Remove everything it added. |

Flags: `--port <n>` (default `10100`), `--region cn|global`.

</details>

<details>
<summary><b>Configuration</b></summary>

```jsonc
{
  "region": "cn",              // "global" for the workbuddy.ai subscription
  "host": "127.0.0.1",
  "port": 10100,
  "credentialFile": "",        // explicit credential path, highest priority
  "cnBase": "",                // optional CN gateway subdomain override
  "apiKey": "",                // require Authorization: Bearer <apiKey>
  "deviceToken": "",           // optional real device token
  "timeoutMs": 120000,
  "emitReasoning": true,
  "keepModelIds": [],          // force-keep ids missing from the live list
  "extraModelIds": []          // append ids you know are provisioned
}
```

Bind address is loopback by default. Set `apiKey` if you expose the port.

</details>

<details>
<summary><b>Credential discovery</b></summary>

Resolved in order, stopping at the first hit:

1. `config.credentialFile` — explicit path.
2. `$DSH_HOME/workbuddy-vault/<region>/*.json` — plaintext, already decrypted. Easiest path.
3. `$DSH_HOME/.workbuddy-auth.<region>.json`, or the legacy file.
4. `workbuddy-desktop.info` + AES-256-GCM decryption, using the at-rest key extracted from the app's Electron binding.
5. `wb-bridge login` — browser device OAuth.

Tokens refresh before expiry and are written back atomically with mode `0600`. Enterprise accounts work via `X-Enterprise-Id` / `X-Tenant-Id`.

Note the ordering: the desktop client is a **last resort**, not a requirement.

</details>

<details>
<summary><b>Wire details</b></summary>

**Headers.** Every upstream call carries the full identity set (`X-Product`, `X-IDE-Type`, `X-Agent-Purpose`, `X-Domain`, a derived device pair, and a fresh conversation-identity triple). Missing any part of the triple trips the channel gate (`11128`), so identifiers are generated per request and never reused.

**Body.** Forced `stream: true`; `developer` → `system`; guaranteed system head; `tool_choice` objects collapsed to strings; `max_completion_tokens` → `max_tokens`; `reasoning_effort: "off"` dropped. Known product-name fingerprints are neutralised with U+200B zero-width spaces, which breaks byte-exact matching without changing what the model reads.

**Tools.** Codex sends declarations inside an `additional_tools` input item, not the top-level `tools` field. The bridge walks that tree, flattens `namespace` wrappers, exposes `custom` tools as a single-string `input` schema, and drops unmatched tool-call halves — upstream rejects both a call without a result and a result without a call (`11148`).

**Injection.** Exactly two root-level keys, before the first `[table]` header:

```toml
# >>> workbuddy-codex-bridge (undo: wb-bridge restore) >>>
model_catalog_json = "/abs/path/.codex/workbuddy-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
# <<< workbuddy-codex-bridge <<<
```

The catalogue clones every native row (so official models keep working) and appends one row per WorkBuddy model. Injection is idempotent.

</details>

<details>
<summary><b>Verified behaviour</b></summary>

Everything below ran against a real CN subscription with real upstream calls, under a throwaway `CODEX_HOME` — the author's own `config.toml` was never modified.

| Check | Result |
| --- | --- |
| Live discovery | 16 models from `/v3/config` + `/v2/enterprises/personal/models`, contexts 192 K–1 M |
| Model picker contents | `codex debug models` reports 26 rows: 16 `wb/` + 10 native, all `visibility=list` |
| End-to-end | `codex exec -m wb/glm-5.3-flash` → correct output, exit 0 |
| WebSocket transport | handshake accepted, 21 frames, no retries |
| Latency after WS fix | 37,969 ms → 15,887 ms |
| Tool calling | `function_call` with reassembled argument deltas |
| Proxy on, both model types | WorkBuddy 200, GPT 200 |
| Proxy off | WorkBuddy 200, GPT fails (expected) |
| GUI picker | Confirmed by the user on a real Windows install |

</details>

<details>
<summary><b>Self-check</b></summary>

```bash
npm test     # 36 checks — protocol, rewriting, headers, SSE, WS frames, proxy, config reversibility
```

Half the suite is pure functions; the other half runs inject → re-inject (idempotent) → restore in a throwaway `CODEX_HOME` and asserts byte-level reversibility.

</details>

<details>
<summary><b>Known limitations</b></summary>

- **Codex mode only.** There is no public way to inject third-party models into the regular Chat / Work UI. Even Ollama's official integration documents itself as Codex-mode-only.
- **Picker allowlists.** Some builds apply a second remote allowlist that drops local catalogue rows ([#19694](https://github.com/openai/codex/issues/19694), [#29156](https://github.com/openai/codex/issues/29156)). CLI and TUI are unaffected.
- **Official 5-hour quota.** When the native quota is exhausted the app greys out other rows ([#2813](https://github.com/openai/codex/issues/2813)).
- **`model_catalog_json` is load-once and replaces the built-in catalogue.** The project clones native rows to compensate, but every change needs a full app restart.
- **Upstream is streaming-only.** Non-streaming requests are rejected with `11101`; the bridge aggregates locally when a caller wants a buffered response.
- **Protocol drift.** Upstream limits, headers and moderation change without notice.

</details>

---

## Security

- Credentials live in memory only. Plaintext copies are written `0600`; on Windows place the vault somewhere ACL-restricted.
- Loopback binding by default; set `apiKey` if you bind wider.
- `X-Refresh-Token` goes only to the refresh endpoint, never on chat requests.
- `~/.codex/auth.json` is never read or written by this project.
- Proxy traffic carries a `CONNECT` tunnel — the proxy sees a hostname, never your token or message text.
- Never commit `config.json`, credentials, or logs; `.gitignore` covers them.

## Compliance

Provided for **research and interoperability study only**. Not affiliated with OpenAI, Tencent, WorkBuddy, or CodeBuddy. Observed risk-control codes: `11128` identity rejection, `11133` invalid parameters, `11140` unusual activity, `11101` non-streaming, `12153` session invalid, `402` insufficient credit, `429` / `14018` quota exhausted. The bridge mitigates these; mitigation is not immunity.

If those terms are unacceptable, use the [official TokenHub API](https://cloud.tencent.com/document/product/1823/133532) — a supported path for Codex with none of this risk.

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short: no dependencies, a test for every behaviour change, `node --check` before opening a PR, never commit credentials.

Security issues: see [SECURITY.md](SECURITY.md) — please do not open a public issue.

## License

[MIT](LICENSE) © contributors

## Acknowledgements

- [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) — the reference wire protocol.
- [opencodex](https://opencodex.me/) — the loopback injection strategy and SSE event contract.
- [workbuddy2api](https://github.com/240xu/workbuddy2api), [workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy), [hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy) — prior art.
- [Ollama × ChatGPT](https://docs.ollama.com/integrations/chatgpt) — the picker mechanism and the rollback pattern.
- Tencent Cloud docs for the [Codex integration](https://cloud.tencent.com/document/product/1823/133532) and the [protocol matrix](https://cloud.tencent.com/document/product/1823/130079).
