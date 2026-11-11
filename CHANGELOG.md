# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-11

### Added

- **Responses WebSocket transport.** The gateway now completes the RFC 6455
  handshake on `ws://127.0.0.1:<port>/v1/responses`, decodes each
  `response.create` frame, runs the same pipeline as the HTTP route, and re-frames
  the SSE events as text frames. Codex used to spend ~16 s per turn retrying this
  probe before falling back to HTTPS; it now succeeds on the first attempt.
  `sec-websocket-extensions` is deliberately not negotiated, so frames stay
  uncompressed.
- **Proxy-aware forwarding.** Node's built-in `fetch` ignores the Windows
  "Internet Settings" proxy and reads `NODE_USE_ENV_PROXY` only at process start,
  so forwarded native-model turns failed with `502 fetch failed` behind a local
  proxy. The gateway now detects the proxy itself (env vars, then the registry),
  honours `NO_PROXY`, and tunnels with `CONNECT`.
- **Picker metadata.** Every WorkBuddy model now carries its credit multiplier and
  promo badge in `display_name` (e.g. `WB · Hy3 · x0.00 · 限时免费`) plus context,
  cost, promo and live queue state in `description`, matching the
  `dsh-connect-workbuddy` presentation. Costs come from
  `GET /v2/enterprises/personal/models`; queue state from `POST /v2/chat/busy`.

### Fixed

- **`11148 tool calls and tool results do not match`.** Two causes. Codex sends
  its tool declarations inside an `additional_tools` input item rather than the
  top-level `tools` field, and that item was dropped — leaving history with
  `tool_calls` but no declarations. Independently, upstream rejects any assistant
  tool call without a matching result, and any result without a matching call.
  Declarations are now collected from `additional_tools` (flattening `namespace`
  trees, exposing `custom` tools as a single-string `input` schema) and
  unmatched halves are dropped.
- **Free vs. paid tiers were being renamed.** `hy4free`/`hy4std` and `hy3`/`hy3-x`
  are two price tiers of the same product, not duplicates. Collision handling now
  keys on the full display name, so the tiers stay distinguishable by cost badge
  while keeping their own slugs.

---

## [1.0.0] - 2026-11-11

Initial release.

### Added

- **Single-process gateway** speaking the OpenAI Responses API (`POST /v1/responses`,
  plus `/v1/responses/compact`) and Chat Completions (`POST /v1/chat/completions`),
  with `GET /v1/models`, `GET /v1/catalog`, and `GET /healthz` for inspection.
- **Zero-step rollback.** Requests whose model lacks the `wb/` prefix are forwarded
  verbatim to `https://chatgpt.com/backend-api/codex` with the original
  `Authorization` header, so native GPT models keep working while the bridge runs.
- **One-command rollback.** `wb-bridge restore` strips only the marked injection
  block, restores `config.toml` from the pristine backup, deletes the generated
  catalogue, and invalidates `models_cache.json` so Codex re-reads on next launch.
- **Live model discovery** from the account's `/v3/config` catalogue; the author's
  CN subscription yielded 16 models with contexts from 192 K to 1 M.
- **Credential resolution** across five sources, including plaintext vault reuse,
  AES-256-GCM at-rest decryption with AuthTag verification, and browser device OAuth.
- **Automatic token refresh** ahead of expiry, written back atomically with mode
  `0600`, never sending `X-Refresh-Token` on chat requests.
- **Full upstream header shaping** — identity set, derived device pair, and a freshly
  generated conversation-identity triple per request.
- **Request-body normalisation** — forced streaming, role folding, `tool_choice`
  collapsing, `max_completion_tokens` mapping, `reasoning_effort: "off"` removal,
  and zero-width-space fingerprint neutralisation.
- **Catalogue cloning** from `models_cache.json` with a neutral `instructions_template`
  per injected model, keeping native rows intact.
- **Test suite** — 24 zero-dependency checks covering protocol translation, header
  construction, SSE framing, credential parsing, and byte-level config reversibility.

### Fixed during development

- `urlPath.replace(/^\\/v1/u, "")` was parsed as a division expression, throwing
  `ReferenceError: v1 is not defined` on every native-model request. Replaced with a
  `startsWith`/`slice` pair. `node --check` does not catch this class of error.
- Reasoning accumulators were not reset when an output item closed, causing the next
  item to inherit the previous item's text.
- An upstream `tool_calls: []` on every chunk was treated as tool activity, closing
  and reopening the reasoning item repeatedly. Now guarded by `.length > 0`.
- `uuidv7()` used a bitwise mask that coerced the timestamp to int32 and produced
  negative values, raising `value out of range` in `writeUIntBE`.
- `neutralClone()` crashed when a native template omitted `input_modalities`;
  the field now defaults to `["text", "image"]`.
- The injection block was missing `disable_response_storage = true`, which the
  stateless subscription backend needs in order to receive full input each turn.

### Known limitations

- Only the Codex mode picker can surface injected models; the regular Chat and Work
  surfaces have no public injection path.
- Desktop builds may apply a second remote allowlist that drops locally catalogued
  models (openai/codex#19694, #29156); the CLI and TUI are unaffected.
- The upstream protocol drifts: rate limits, header requirements and moderation
  change without notice, so the adapter may need updating.

[1.1.0]: https://github.com/<owner>/workbuddy-codex-bridge/releases/tag/v1.1.0
[1.0.0]: https://github.com/<owner>/workbuddy-codex-bridge/releases/tag/v1.0.0
