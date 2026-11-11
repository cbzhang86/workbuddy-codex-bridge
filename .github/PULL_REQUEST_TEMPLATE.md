## What changed

<!-- One or two sentences. Link the commit or issue if relevant. -->

## Why

<!--
For protocol or header changes, state what you observed upstream — the error
code, the response shape, the rejected payload. This is the only durable record
of why the rewrite exists.
-->

## How it was verified

<!-- Tick what you actually exercised. Be honest about what you did not. -->

- [ ] `npm test` passes (24 checks)
- [ ] `node --check` clean on every modified file
- [ ] Exercised with the Codex CLI (`codex exec -m "wb/<model>"`)
- [ ] Exercised in the ChatGPT desktop app picker
- [ ] `wb-bridge restore` verified against a throwaway `CODEX_HOME`

## Checklist

- [ ] No runtime dependencies added
- [ ] New behaviour covered by a case in `test/selftest.js`
- [ ] No credentials, tokens, or personal identifiers in the diff or logs
- [ ] `.gitignore` still covers every secret file this change introduces

## Notes for reviewers

<!-- Anything a reviewer should look at twice: header shape, marker matching, reversibility. -->
