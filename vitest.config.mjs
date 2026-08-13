// Root-level config so `bunx vitest run` (config discovery from project root) picks up
// the alias/globals/excludes defined in tests/vitest.config.js. Paths inside that file
// are computed relative to tests/, so re-exporting keeps them correct.
export { default } from "./tests/vitest.config.js";
