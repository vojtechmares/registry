# CLAUDE.md

## Agent skills

### Issue tracker

Issues and PRDs live in this repo's GitHub Issues (`vojtechmares/registry`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage labels, unmodified: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context - one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Dependencies

Keep dependencies minimal. Prefer writing the code yourself over adding yet another NPM package. If a really well-known package would be a good fit, ask the user before installing it.

## Coding

Use TDD in a red-green flow: first write the failing test, run it to confirm it fails for the right reason, then implement the feature to make it pass.

## Review

Review every change twice before considering it done: once for correctness, once for security.
