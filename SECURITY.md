# Security Policy

## Scope

This project handles **live subscription credentials** — access tokens, refresh
tokens, and a local at-rest key used to decrypt the desktop client's credential
file. A defect that exposes, logs, persists, or transmits any of these is a
security issue, not an ordinary bug.

## Reporting

Please **do not open a public issue** for a credential-handling flaw.

Instead, open a [private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or contact the maintainer directly. Include:

- the affected file and function,
- a description of what is exposed and to whom (local process, log file, network),
- reproduction steps, with **all secrets redacted**.

Expect an acknowledgement within a week. Because this is an unofficial
interoperability project maintained on a best-effort basis, no timeline for a fix
is guaranteed.

## Design intent

These are deliberate properties. A pull request that weakens any of them will be
rejected:

| Property | Where it is enforced |
| --- | --- |
| Credentials never leave the machine except to the provider they belong to | The gateway only dials `copilot.tencent.com` / `www.workbuddy.ai` for `wb/` models and `chatgpt.com` for native models |
| The gateway binds to loopback by default | `DEFAULT_HOST = "127.0.0.1"` in `src/constants.js` |
| Optional bearer auth for any non-loopback binding | `authorized()` in `bin/wb-bridge.js`; set `apiKey` in `config.json` |
| `X-Refresh-Token` appears on the refresh endpoint only | `refreshHeaders()` vs `chatHeaders()` in `src/upstream.js` |
| Decryption never degrades to a partial token | `openEncryptedField()` verifies the AES-GCM auth tag and throws on mismatch |
| `~/.codex/auth.json` is never written | Neither `injectConfig()` nor `restoreConfig()` touches it |
| Restore only removes what the project owns | `stripInjected()` matches the project's own begin/end markers |
| Plaintext credential copies are `0600` where the platform honours it | `writeFileAtomic` calls in `src/credentials.js` |

## Hardening notes for users

- On Windows, POSIX permission bits are ignored. Put any directory holding a
  plaintext credential copy behind an explicit ACL, or rely on the encrypted
  desktop file and the OAuth path instead.
- Do not expose the gateway port to a LAN or tunnel without setting `apiKey`.
- Redact `Authorization`, `X-Refresh-Token`, `X-User-Id`, `X-Domain`, and any
  `accessToken` / `refreshToken` fields before sharing logs or bug reports.
- Treat `config.json` and any file under the credential vault as secrets. The
  repository's `.gitignore` covers the common cases but is not a substitute for
  checking before you commit.

## Out of scope

- Account restrictions, quota exhaustion, or plan termination caused by using the
  project against the upstream terms of service. That risk is documented in the
  README and is not a vulnerability.
- Upstream rate limiting, protocol drift, or content moderation changes.
- Vulnerabilities in OpenAI's, Tencent's, or any third party's software.
