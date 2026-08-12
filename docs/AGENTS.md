<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# docs

Design and decision documentation for the 9router codebase.

## Purpose

`ARCHITECTURE.md` is the authoritative system description — request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model, env matrix. Read it before working in request-flow areas rather than re-deriving from code.

## Key Files

| File | Description |
|------|-------------|
| `ARCHITECTURE.md` | Full system architecture. NOTE: persistence section is stale — state is now SQLite (`src/lib/db/`), not `db.json` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `superpowers/` | Design docs (see `superpowers/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Prefer updating code + CLAUDE.md + `open-sse/AGENTS.md` over docs for behavior that changed; `ARCHITECTURE.md` lags reality in places.
- Dates in `superpowers/` filenames are YYYY-MM-DD design sessions.

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
