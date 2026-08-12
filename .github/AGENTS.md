<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# .github

CI/CD and dependency automation.

## Purpose
GitHub workflows: Docker image publishing and GitBook site deployment.

## Key Files

| File | Description |
|------|-------------|
| `dependabot.yml` | Dependency update automation |
| `workflows/docker-publish.yml` | Builds + pushes Docker image to GHCR (`ghcr.io/…`) and Docker Hub (`decolua/9router`) on `v*` tags / manual dispatch |
| `workflows/gitbook-pages.yml` | Deploys `gitbook/` to 9router.github.io on push to main/master touching `gitbook/**` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `workflows/` | GitHub Actions definitions |

## For AI Agents

### Working In This Directory
- Docker build depends on root `Dockerfile` — changes to server deps or standalone assets may need workflow updates.
- GitBook deploy is scoped to `gitbook/**` paths.

### Testing Requirements
- No local tests. Validate YAML syntax and only trigger workflow_dispatch to smoke.

### Common Patterns
- Trigger on version tags / path filters.

## Dependencies

### Internal
- `Dockerfile`, `gitbook/`

### External
- GitHub Actions, GHCR, Docker Hub, GitHub Pages

<!-- MANUAL: -->
