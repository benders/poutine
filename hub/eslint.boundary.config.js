// @ts-check
/**
 * Boundary-only ESLint config. Loaded by `pnpm lint:boundary`, which is
 * what `pnpm verify` (and CI) runs. The full `eslint.config.js` enables
 * the typescript-eslint recommended ruleset and currently surfaces
 * pre-existing issues unrelated to #221; isolating the boundary check
 * keeps the failure signal sharp.
 *
 * See `eslint.config.js` for the canonical Player-file list and the
 * rationale; this file re-exports the same rule under a stripped-down
 * config so unrelated rules can't drown out a boundary regression.
 */
import tseslint from "typescript-eslint";
import boundaryConfig from "./eslint.config.js";

const ignoresBlock = boundaryConfig.find((b) => b && b.ignores && !b.files);
const playerBlock = boundaryConfig.find(
  (b) => b && b.rules && b.rules["no-restricted-imports"],
);

// Re-use typescript-eslint's parser so .ts syntax (interfaces, type
// annotations, etc.) parses cleanly. We only want the parser, not the
// recommended ruleset.
export default [
  ignoresBlock,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  playerBlock,
].filter(Boolean);
