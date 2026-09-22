<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-09-22 -->

# docs

Design and decision documentation for the 9router codebase.

## Purpose

`ARCHITECTURE.md` is the authoritative system description — request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model, env matrix. Read it before working in request-flow areas rather than re-deriving from code.

## Key Files

| File | Description |
|------|-------------|
| `ARCHITECTURE.md` | Full system architecture. NOTE: persistence section is stale — state is now SQLite (`src/lib/db/`), not `db.json` |
| `provider-cache-audit.md` | Provider cache-token coverage audit (58 KB research doc) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `plans/` | Implementation notes: 2× 2026-09-22 freebuff investigation + 2× 2026-08-27 cache design |
| `images/` | Screenshots, incl. SAML login/admin-dashboard captures used by `tests/auth/saml.test.js` docs |
| `superpowers/` | Design docs (no AGENTS.md here — do not link one) |

## For AI Agents

### Working In This Directory
- Prefer updating code + CLAUDE.md + `open-sse/AGENTS.md` over docs for behavior that changed; `ARCHITECTURE.md` lags reality in places.
- Dates in `plans/` filenames are YYYY-MM-DD design sessions.

### Testing Requirements
- Markdown only — no automated tests. Verify links to repo paths still resolve.

### Common Patterns
- One design doc per decision, dated filename, `specs/` for design + `plans/` for implementation notes.

## Dependencies

### Internal
- Whole codebase (documents it)

### External
- None

<!-- MANUAL: -->
