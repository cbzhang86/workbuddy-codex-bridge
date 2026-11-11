# Contributing to workbuddy-codex-bridge

Thanks for taking a look. This is a small, deliberately dependency-free project —
please keep it that way.

## Ground rules

1. **No runtime dependencies.** Node.js built-in modules only. If a change needs a
   library, it needs a design discussion first.
2. **No build step.** The repository is the artifact. `node bin/wb-bridge.js` must
   run directly from a fresh clone.
3. **Every behaviour change needs a test.** Add a case to `test/selftest.js`; the
   suite must be green before you open a pull request.
4. **Syntax-check what you touch.** Run `node --check <file>` on every modified
   JavaScript file — `npm test` alone will not catch a syntax error in a file that
   the test suite does not import.
5. **Never commit secrets.** No tokens, no credential files, no captured traffic
   containing `Authorization`, `X-Refresh-Token`, cookies, or personal identifiers.
   If you paste a log into a pull request, redact it first.

## Getting started

```bash
git clone https://github.com/<you>/workbuddy-codex-bridge.git
cd workbuddy-codex-bridge
npm test
```

There is nothing to install.

## Layout

```
bin/wb-bridge.js        CLI entry point + single-process HTTP gateway
src/constants.js        Literal constants: endpoints, user agents, markers
src/credentials.js      Credential discovery, at-rest decryption, refresh, OAuth
src/upstream.js         Header shaping, body rewriting, model catalogue, streaming
src/responses.js        Responses <-> Chat Completions translation, SSE, forwarding
src/codex-config.js     config.toml injection, catalogue generation, restore
test/selftest.js        Zero-dependency test suite
```

## Adding support for a new upstream model

Models are discovered live from the account's `/v3/config` catalogue, so most
additions require **no code change** at all. If a model is provisioned but missing
from the catalogue, add its id to `extraModelIds` in `config.json` — do not hardcode
model lists in `src/`.

## Adding a new error code

Error classification lives in `classifyUpstream()` in `src/credentials.js`. Add the
marker and its category, then add a case to the suite asserting a representative
upstream body maps to the expected category.

## Changing request shaping

Header and body construction live in `src/upstream.js`. These transforms are
load-bearing for interoperability, so:

- add a focused unit test asserting the exact before/after shape;
- do not weaken fingerprint neutralisation or the conversation-identity triple;
- never attach `X-Refresh-Token` to a chat request.

## Commit messages

Conventional Commits are appreciated but not enforced:

```
fix(responses): reset accumulator after closing a reasoning item
feat(credentials): support the -ai desktop credential filename
docs: document the WebSocket fallback noise
```

## Pull requests

- One logical change per pull request.
- Describe **what you observed** upstream (error code, response shape) when fixing
  a protocol issue — it is the only durable record of why a rewrite exists.
- Mention which of the two surfaces you exercised: the CLI, the desktop app, or
  both. The maintainers cannot verify GUI picker behaviour without an installation.

## Reporting bugs

Include the command you ran, the `wb-bridge status` output, and the relevant log
lines with credentials removed. For a protocol failure, the upstream `code` and
`msg` fields are the most useful thing you can provide.

## Security issues

See [SECURITY.md](SECURITY.md). Do not file a public issue for a defect that
exposes credentials.
