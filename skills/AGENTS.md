<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# skills

SKILL.md definitions exposed to AI agents (Claude-style skills) for 9router capabilities.

## Purpose

Lets an agent use 9router's routing surface through the local server: chat, embeddings, image/video/tts/stt generation, web fetch, web search. Each skill documents the endpoint + request shape for one capability.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Index of the skill set |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `9router/` | Core chat/API skill (see `9router/AGENTS.md`) |
| `9router-chat/` | Chat completions usage |
| `9router-embeddings/` | Embeddings endpoint usage |
| `9router-image/` | Image generation |
| `9router-stt/` | Speech-to-text |
| `9router-tts/` | Text-to-speech |
| `9router-video/` | Video generation |
| `9router-web-fetch/` | Web fetch tool |
| `9router-web-search/` | Web search tool |

## For AI Agents

### Working In This Directory
- Each subdir is a single `SKILL.md`. Skills describe the local `/v1/*` endpoint contract — keep them in sync with `src/app/api/v1/*`.
- Skills are surfaced through the agent toolchain; keep instructions copy/format exact.

### Testing Requirements
- No automated tests. Verify a skill's curl example against a running server (`PORT=20128`).

### Common Patterns
- One capability per directory, YAML frontmatter + prose body in `SKILL.md`.

## Dependencies

### Internal
- `src/app/api/v1/*` endpoint contracts

### External
- None

<!-- MANUAL: -->
