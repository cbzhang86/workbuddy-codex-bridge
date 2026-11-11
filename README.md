<div align="center">

# workbuddy-codex-bridge

**Bring your WorkBuddy subscription models into the official ChatGPT desktop app's Codex model picker — and get back to the official subscription in a single click.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](#requirements)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#why-a-new-gateway)
[![Tests](https://img.shields.io/badge/tests-24%20passing-success.svg)](#self-check)
[![Status](https://img.shields.io/badge/status-experimental-orange.svg)](#known-limitations)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

> [!WARNING]
> **This is an unofficial integration and it violates the upstream terms of service.**
> Tencent Cloud states that the subscription is licensed **for interactive coding tools only**, and explicitly prohibits generic API automation, custom application backends, and non-interactive batch invocation. Routing your subscription through a third-party proxy into ChatGPT is exactly that pattern — **your account or plan may be rate-limited, restricted, or terminated.** Read [Compliance & Legal](#compliance--legal) before you run anything.

---

## Table of Contents

- [The problem](#the-problem)
- [What this does](#what-this-does)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Rolling back](#rolling-back)
- [Verified behaviour](#verified-behaviour)
- [Known limitations](#known-limitations)
- [Security](#security)
- [Compliance & Legal](#compliance--legal)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## The problem

WorkBuddy ships a desktop client with a subscription that unlocks a whole roster of models — Hy4, GLM-5.3, Kimi-K3, DeepSeek-V4, MiniMax-M3.1 and more. You can talk to them inside WorkBuddy, but you cannot select them from the ChatGPT desktop app, because:

1. **Codex only speaks the OpenAI Responses API.** WorkBuddy's backend speaks Chat Completions with a fleet of proprietary identity headers. There is no direct wire compatibility.
2. **The desktop sign-in is encrypted.** Since WorkBuddy 5.6 the local credential file is sealed with AES-256-GCM and only the app can open it.
3. **There is no first-class provider.** Community gateways such as [opencodex](https://opencodex.me/) expose `workbuddy-ai` (the *international* subscription) only; the domestic subscription has no equivalent OAuth provider, and opencodex's `headers` field explicitly rejects `Authorization` / cookie / API-key headers, so the WorkBuddy identity headers cannot be injected through it.

The usual workaround — hand-editing `~/.codex/config.toml` to point at a third-party proxy — works, but getting *back* to the official subscription means manually restoring the file, undoing a catalogue override, and restarting. That is 2–3 steps and easy to get wrong.

This project closes both gaps: the models appear in the picker, and the rollback costs **zero clicks** (pick a native GPT again) or **one command**.

---

## What this does

```
ChatGPT desktop app · Codex mode
  │  POST /v1/responses      model = wb/glm-5.2
  ▼
~/.codex/config.toml          openai_base_url = http://127.0.0.1:10100/v1
  ▼
workbuddy-codex-bridge        127.0.0.1:10100   (single Node process)
  │  Responses → Chat Completions translation
  │  + OAuth token / identity headers / body rewriting
  ▼
https://copilot.tencent.com/v2/chat/completions   →  your subscription quota
```

**Zero-step rollback.** Selecting any native GPT model sends a request without the `wb/` prefix, and the bridge transparently forwards it to `https://chatgpt.com/backend-api/codex` with your original `Authorization` header intact. Official subscription keeps working; the bridge does not need to be stopped.

On the author's machine the bridge discovered **16 built-in CN models** from the live `/v3/config` catalogue — `hy4free`, `hy4std`, `hy3`, `hy3-x`, `deepseek-v4.1-flash`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `space-bunny`, `minimax-m3.1-flash`, `kimi-k3.1-pro`, `kimi-k3-1`, `kimi-k2.8-preview`, `deepseek-v4-pro`, `step-5-preview`, `mimo-v2.6-pro` — contexts from 192 K to 1 M, each surfaced in the picker as `WB · <Name>`.

### Why a new gateway?

This project absorbs the useful parts of two existing efforts but ships as a single self-contained process:

| Source | What was absorbed |
| --- | --- |
| [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | The subscription wire protocol: credential discovery and refresh, the full identity-header set, the conversation-identity triple, request-body rewriting, channel-fingerprint neutralisation, live `/v3/config` model discovery, `/v2/chat/completions` streaming, and error classification. |
| [opencodex](https://opencodex.me/) | The loopback injection strategy: keep the built-in `openai` provider, inject exactly two root-level keys (`openai_base_url`, `model_catalog_json`), and publish a shared model catalogue — fully reversible, never touching `~/.codex/auth.json`. |

Installing opencodex directly is not viable here: it disables automatic local-plugin loading on Windows (`"On Windows automatic plugin loading is disabled until an ACL trust check is available."`), its `headers` field rejects credential headers, and it has no first-class provider for the domestic subscription. Speaking the Responses API directly removes the extra process entirely.

---

## Requirements

- **Node.js ≥ 22** (uses native `fetch`, `AbortSignal.timeout`, `node:crypto`). Verified on v25.8.1.
- **WorkBuddy desktop client**, installed and signed in — or a browser available for device OAuth.
- **ChatGPT desktop app with Codex mode** (macOS / Windows). Codex CLI alone is enough to verify, but not to see the GUI picker.
- A user-level `~/.codex/config.toml` (launch Codex once to create it). `~/.codex/auth.json` is never modified.

No npm dependencies. No build step.

---

## Quick start

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge

cp config.example.json config.json     # optional — edit port / region / credentials
node bin/wb-bridge.js start            # discover models → write catalogue → inject → serve
```

Expected output:

```
  credential : vault (.../.dsh/workbuddy-vault/cn/c4957....json)  region=www.workbuddy.cn
  models     : 16 WorkBuddy + 1 native
  catalog    : .../.codex/workbuddy-catalog.json
  config.toml: injected at line 2

  workbuddy-codex-bridge listening on http://127.0.0.1:10100/v1
  Native GPT       : forwarded to https://chatgpt.com/backend-api/codex (0-step rollback)
  Rollback         : wb-bridge restore
```

> [!IMPORTANT]
> **Fully quit the ChatGPT desktop app — not just close the window.** Use the tray/menu-bar *Quit*, or `Cmd+Q` / right-click → Quit. `model_catalog_json` is read only at startup.

Reopen the app and switch to **Codex mode**. The model picker now lists `WB · Hy4`, `WB · GLM-5.3`, and the rest. Pick one and start chatting.

---

## Commands

| Command | Description |
| --- | --- |
| `wb-bridge start` | Discover models → write catalogue → inject `config.toml` → run the gateway in the foreground. **Start here.** |
| `wb-bridge setup` | Inject only; do not start the server. |
| `wb-bridge models` | Print the WorkBuddy models available on this account. |
| `wb-bridge status` | Show injection state and whether the gateway is listening. |
| `wb-bridge login` | Device OAuth via browser, when no desktop credential is available. |
| `wb-bridge restore` | **One-command rollback** to the official subscription. |

Flags: `--port <n>` (default `10100`), `--region cn|global` (default `cn`). Environment variable `WB_BRIDGE_CONFIG` points at an alternative config file.

---

## Configuration

```jsonc
{
  "region": "cn",              // or "global" for the workbuddy.ai subscription
  "host": "127.0.0.1",
  "port": 10100,
  "credentialFile": "",        // explicit credential path (highest priority)
  "cnBase": "",                // optional CN gateway subdomain override
  "apiKey": "",                // when set, the gateway requires Authorization: Bearer <apiKey>
  "deviceToken": "",           // optional real X-Device-Token
  "deviceFile": "",            // optional path to the device-salt file
  "timeoutMs": 120000,
  "emitReasoning": true,
  "keepModelIds": [],          // force-keep model ids missing from the live catalogue
  "extraModelIds": []          // append ids you know are provisioned but unlisted
}
```

The default bind address is loopback. Set `apiKey` if you expose the port beyond `127.0.0.1`.

---

## How it works

### Credential discovery

Since WorkBuddy 5.6 the desktop sign-in is encrypted, so the bridge resolves credentials in this order and stops at the first hit:

1. `config.credentialFile` — explicit path.
2. `$DSH_HOME/workbuddy-vault/<region>/*.json` — **plaintext, already decrypted** by dsh-connect-workbuddy. Easiest path; avoids decryption entirely.
3. `$DSH_HOME/.workbuddy-auth.<region>.json`, or the legacy `.workbuddy-auth.json`.
4. `workbuddy-desktop.info` / `workbuddy-desktop-ai.info` + **AES-256-GCM** field decryption, using `atRestSecretKey` extracted from the app executable via its Electron linked binding. The AAD layout (`fieldAad`), key derivation (`sha256` over the base64 string, **not** the decoded bytes), and GCM tag verification mirror the reference implementation exactly — a tag mismatch is never downgraded to a truncated token.
5. `wb-bridge login` — browser device OAuth (`/v2/plugin/auth/state` → authorize → poll `/v2/plugin/auth/token` → `/v2/plugin/login/account` → daily check-in).

Tokens refresh automatically before expiry (`POST /v2/plugin/auth/token/refresh` with `X-Refresh-Token` and `X-Auth-Refresh-Source: workbuddy`, deliberately **without** `Authorization`) and are written back atomically with `mode 0600`. Enterprise accounts are supported via `X-Enterprise-Id` / `X-Tenant-Id`.

### Header shaping

Every upstream request carries the full WorkBuddy identity set: `X-Product`, `X-IDE-Name`, `X-IDE-Type`, `X-IDE-Version`, `X-Agent-Purpose`, `X-Domain`, `X-User-Id`, `X-Enterprise-Id`, `X-CodeBuddy-Request`, `Accept-Language`, a derived device pair (`X-Machine-ID` / `X-Session-ID`, HMAC-style derivation from a local salt), and a fresh conversation-identity triple (`X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`). Missing any part of the triple trips the upstream channel gate (`11128`), so identifiers are generated per request and never reused.

### Body rewriting

Before dispatch the payload is normalised: `stream: true` is forced, `developer` roles become `system`, a system head is guaranteed, `tool_choice` objects collapse to the string form the backend accepts, `max_completion_tokens` becomes `max_tokens`, and `reasoning_effort: "off"` is dropped (it triggers `11133`). Channel fingerprints — product-name opening lines the backend has been observed to reject — are neutralised by inserting U+200B zero-width spaces inside existing whitespace, which breaks byte-exact matching while leaving the text the model reads unchanged.

### Catalogue injection

`~/.codex/config.toml` receives exactly two root-level keys, placed **before the first `[table]` header** (a TOML structural requirement — inserted later and they would be parsed into the previous table):

```toml
# >>> workbuddy-codex-bridge (undo: wb-bridge restore) >>>
model_catalog_json = "/abs/path/.codex/workbuddy-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
disable_response_storage = true
# <<< workbuddy-codex-bridge <<<
```

The catalogue clones every native row from `~/.codex/models_cache.json` (so the official models keep working) and appends one row per WorkBuddy model, each stamped with its real context window, `visibility: "list"`, and a neutral `instructions_template` so that native GPT identity text is never sent to the WorkBuddy gateway. Injection is idempotent — repeated `start` runs never duplicate the block.

---

## Rolling back

| Scenario | Steps |
| --- | --- |
| Temporarily use an official model | **0** — pick any native GPT in the picker; the bridge forwards it to the official backend |
| Remove the integration entirely | **1** — `wb-bridge restore`, then fully quit and reopen the app |

`restore` strips only the block it owns (identified by its own markers), restores `config.toml` from the pristine backup taken before the first injection, deletes the generated catalogue, and resets `fetched_at` in `models_cache.json` to force a re-read on next launch. It **never** deletes unrelated Codex configuration and never touches `auth.json`.

For comparison, hand-editing `config.toml` to talk to a third-party provider directly requires backing up, editing back, and restarting — 2–3 steps. This project brings that down to 0–1.

---

## Verified behaviour

Everything below was exercised against a **real WorkBuddy CN subscription** with real upstream calls. The whole suite ran under a temporary `CODEX_HOME`, so the author's real `~/.codex/config.toml` was never modified (byte size stayed at 4989 throughout).

| # | Check | Result |
| --- | --- | --- |
| 1 | Live model discovery | **16** CN models parsed from `/v3/config`, contexts 192 K–1 M |
| 2 | Direct `/v1/responses` | `wb/glm-5.2`, `wb/hy3`, `wb/deepseek-v4.1-flash`, `wb/minimax-m3.1-flash` all HTTP 200, `status=completed` |
| 3 | Streaming SSE sequence | 10 frames, `response.created` → `in_progress` → `output_item.added` → `content_part.added` → `output_text.delta` → `output_text.done` → `content_part.done` → `output_item.done` → `response.completed` → `[DONE]` |
| 4 | Tool calling | `tools` + `tool_choice: auto` returns a `function_call`; streamed argument deltas reassemble to `{"city": "北京"}` with a complete `call_id` |
| 5 | OpenAI Chat Completions | `POST /v1/chat/completions` returns `object: chat.completion`, `finish_reason: stop` |
| 6 | **Codex loads the catalogue** | `codex debug models` reports **26 models: 16 `wb/` + 10 native**, every `wb/` row `visibility=list` |
| 7 | **Official Codex CLI, end to end** | `codex exec -m "wb/glm-5.2"` → prints `桥接成功`, `tokens used 1,539` |
| 8 | Error classification | Exhausted `hy4free` returned `code 6004 / 429` → correctly classified `soft_rate` |
| 9 | Self-check | `npm test` → 24 checks passed |

**What was not verified.** The author's machine has no ChatGPT desktop app installed, so there is **no screenshot of the GUI picker**. Checks 6 and 7 are the closest available evidence: the same Codex binary reports that it loaded 16 `wb/` models with `visibility=list`, and that same binary completed a real conversation using `wb/glm-5.2`. The desktop app and the CLI share the same `config.toml` + catalogue reading path, but the renderer's second-layer allowlist ([openai/codex#19694](https://github.com/openai/codex/issues/19694)) can only be confirmed on a machine with the app installed.

### Self-check

```bash
npm test     # 24 passed — credentials, protocol, rewriting, headers, SSE, config reversibility
```

Half of the suite is pure functions; the other half runs the full inject → re-inject (idempotent) → restore cycle inside a throwaway `CODEX_HOME` and asserts byte-level reversibility.

---

## Known limitations

- **Codex mode only.** There is no public way to inject third-party models into the regular Chat / Work UI — even Ollama's official integration documents itself as "only available in Codex mode", and opencodex's desktop shim is macOS-only, off by default, filters JSON-RPC quota frames rather than routing model calls, and is defeated by the renderer's separate transport (#6196).
- **Picker allowlists.** Some desktop builds apply a second, remote allowlist that drops locally catalogued models ([#19694](https://github.com/openai/codex/issues/19694), [#29156](https://github.com/openai/codex/issues/29156)). The CLI and TUI are unaffected. Workaround: set `model = "wb/glm-5.2"` directly in `config.toml` — the UI will show *Custom*, but routing is correct.
- **Official 5-hour quota.** When the native Codex quota is exhausted the desktop app greys out other rows and forces `gpt-reserve` ([#2813](https://github.com/openai/codex/issues/2813)); wait for the window to reset, or use the CLI.
- **`model_catalog_json` is load-once and replaces (never merges) the built-in catalogue.** This project clones all native rows to compensate, but every configuration change requires fully quitting and reopening the app.
- **The upstream is streaming-only.** Non-streaming requests are rejected with `code 11101`; the bridge always streams upstream and aggregates locally when a caller asks for a buffered response.
- **Codex probes WebSocket first.** It dials `ws://127.0.0.1:<port>/v1/responses`, retries five times, then falls back to HTTPS — roughly five seconds and a burst of `failed to connect to Responses WebSocket` log lines per request. This is cosmetic and does not affect results. The bridge now answers the upgrade handshake with an immediate 405 so the fallback happens as early as possible, but the retry count is internal to Codex: `codex features list` shows both `responses_websockets` and `responses_websockets_v2` marked `removed`, so the flag no longer exists.
- **Protocol drift.** Upstream rate limiting, header requirements and content moderation change frequently. Adaptations in this repository may stop working without notice.

---

## Security

- Credentials are read from disk and held in memory only. Plaintext copies are written with mode `0600`; on Windows, where POSIX modes are ignored, place the vault under an ACL-restricted directory.
- The gateway binds to `127.0.0.1` by default. If you bind elsewhere, set `apiKey` — requests are then rejected with `401` unless they carry `Authorization: Bearer <apiKey>`.
- The `X-Refresh-Token` header is sent **only** to the refresh endpoint, never on chat requests.
- `~/.codex/auth.json` is read-only for this project: neither injection nor restore touches it.
- Do not commit `config.json`, credential files, or logs — the bundled `.gitignore` covers them.
- Injecting a custom catalogue means **you** are responsible for the model entries it exposes. Drop this repository's generated catalogue on any machine you do not control.

---

## Compliance & Legal

> [!CAUTION]
> This project is provided for **research and interoperability study only**. You assume all risk.

- **Upstream terms.** Tencent Cloud licenses the subscription **for interactive coding tools** and prohibits generic API automation, custom application backends, and non-interactive batch invocation; violations may cause the plan key to be suspended. Routing the subscription into ChatGPT is a textbook third-party-proxy pattern and carries a real risk of account restriction or plan termination. Comparable projects ([workbuddy2api](https://github.com/240xu/workbuddy2api), [workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy), [hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy)) all carry "for study and research only, use at your own risk" disclaimers.
- **Not affiliated.** This project has no relationship with OpenAI, Tencent Cloud, WorkBuddy, or CodeBuddy. All trademarks belong to their respective owners.
- **Observed risk-control codes.** `11128` channel/identity rejection, `11133` invalid parameters, `11140` unusual activity (requires filing feedback upstream; re-login and model switching do not help), `11101` non-streaming rejected, `11102` model id not rewritten, `12153` session invalid, `402` insufficient credit, `429` / `14018` quota exhausted with a ~30 min `Retry-After`. The bridge mitigates these, but mitigation is not immunity.
- **No warranty.** If your account is limited, your quota is drained, or your plan is terminated, that outcome is yours to bear.

If those terms are unacceptable to you, use the official [TokenHub pay-as-you-go API](https://cloud.tencent.com/document/product/1823/133532) instead — it is a supported, documented, first-class integration path for Codex and carries none of this risk. This project exists because the subscription itself has no supported programmatic interface.

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
npm test
```

- Keep the runtime **dependency-free** — Node built-ins only.
- Add a case to `test/selftest.js` for every behavioural change; the suite must stay green.
- Run `node --check` on every touched file before opening a pull request.
- Never commit credentials, tokens, personal identifiers, or captured traffic containing them.

Security issues: see [SECURITY.md](SECURITY.md). Please do not open a public issue for a credential-handling flaw.

---

## License

[MIT](LICENSE) © contributors

---

## Acknowledgements

- [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) — the reference implementation of the subscription wire protocol, and the origin of the credential-vault and fingerprint-neutralisation techniques.
- [opencodex](https://opencodex.me/) — the loopback injection strategy, the Responses SSE event contract, and the model-catalogue cloning approach.
- [workbuddy2api](https://github.com/240xu/workbuddy2api), [workbuddy-cli-proxy](https://github.com/p2109220548-ctrl/workbuddy-cli-proxy), [hy3-proxy](https://github.com/zhangjianqiang123/hy3-proxy) — prior art in exposing the subscription as an OpenAI-compatible endpoint.
- [Ollama × ChatGPT integration](https://docs.ollama.com/integrations/chatgpt) — the model-picker mechanism and the "restore the user's connection settings" rollback pattern.
- Tencent Cloud TokenHub documentation for the [Codex integration](https://cloud.tencent.com/document/product/1823/133532) and the [model/protocol matrix](https://cloud.tencent.com/document/product/1823/130079).
