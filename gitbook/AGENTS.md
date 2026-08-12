<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# gitbook

GitBook documentation site source. Multi-language docs (en, es, ja, vi, zh-CN) rendered as a Next.js app.

## Purpose

The public product documentation: getting-started, features, deployment, integration, and per-provider guides in five languages.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | GitBook site manifest (separate from root) |
| `next.config.mjs` | Site build config |
| `jsconfig.json` | Alias config for the site |
| `postcss.config.mjs` | CSS pipeline |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `app/` | Next.js pages: `[lang]/[...slug]/` catch-all renderer, layout, globals.css |
| `components/` | Docs UI: DocsContent, DocsHeader, DocsLayout, DocsSidebar, DocsToc, LanguageSwitcher |
| `constants/` | `docsConfig.js` (nav/sidebar), `languages.js` |
| `content/` | Markdown docs in `en/ es/ ja/ vi/ zh-CN/`, each with `deployment/ features/ getting-started/ integration/ providers/` |
| `lib/` | `content.js` — content loading |
| `utils/` | `markdown.js` — markdown processing |

## For AI Agents

### Working In This Directory
- Doc content lives in `content/<lang>/`; structure mirrors across languages — keep translations in sync.
- Site is an independent Next app; root tooling does not apply.

### Testing Requirements
- No test suite. Verify a language's pages render by running the site locally.

### Common Patterns
- Sidebar/nav driven by `constants/docsConfig.js`.

## Dependencies

### Internal
- None (self-contained site)

### External
- Next.js, GitBook conventions

<!-- MANUAL: -->
