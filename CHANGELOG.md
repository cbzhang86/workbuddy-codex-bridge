# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Some desktop builds apply a second remote allowlist that drops locally catalogued
  models (openai/codex#19694, #29156); the CLI and TUI are unaffected.
- Codex probes the Responses WebSocket transport first and retries five times before
  falling back to HTTPS — cosmetic noise plus a few seconds per request. The
  `responses_websockets` feature flags are marked `removed` upstream, so it cannot
  be disabled.

[1.0.0]: https://github.com/<owner>/workbuddy-codex-bridge/releases/tag/v1.0.0
