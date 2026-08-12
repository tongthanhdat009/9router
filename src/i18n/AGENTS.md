<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-12 | Updated: 2026-08-12 -->

# i18n
## Purpose
Runtime internationalization for the dashboard: locale config, a runtime translation loader, and the React provider wrapping the app.

## Key Files
| File | Purpose |
|---|---|
| `config.js` | Locale configuration |
| `runtime.js` | Runtime translation loader/lookup |
| `RuntimeI18nProvider.js` | React provider that wraps the app |

## Subdirectories
(none)

## For AI Agents
### Working In This Directory
Locales are runtime-loaded — verify new strings appear in all configured locales, not just the default. Keep the provider thin; translation data comes from `config.js`/`constants/locales.js`.
### Testing Requirements
String changes are visible in the running dashboard; check both the default and a secondary locale. No dedicated suite.
### Common Patterns
App reads translations through the `RuntimeI18nProvider` context; new locale keys added to `config.js`.

## Dependencies
### Internal
`src/shared/constants/locales.js`
### External
React
<!-- MANUAL: -->
