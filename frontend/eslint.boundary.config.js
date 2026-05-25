/**
 * Boundary-only ESLint config. Loaded by `pnpm lint:boundary`, which is
 * what `pnpm verify` (and CI) runs. The full `eslint.config.js` enables
 * the React + typescript-eslint recommended rulesets and currently
 * surfaces pre-existing issues unrelated to #221; isolating the boundary
 * check keeps the failure signal sharp and lets the broader lint cleanup
 * land as a separate issue.
 *
 * See `eslint.config.js` for the canonical feature-directory rule set
 * and the rationale.
 */
import tseslint from 'typescript-eslint'
import boundaryConfig from './eslint.config.js'

// Keep only the cross-feature `no-restricted-imports` blocks (those
// targeting a `src/features/<name>/**` glob).
const featureBlocks = boundaryConfig.filter((b) => {
  if (!b || !b.files) return false
  return b.files.some(
    (f) => typeof f === 'string' && f.startsWith('src/features/'),
  )
})

// Re-use typescript-eslint's parser so .ts/.tsx files parse cleanly. We
// only want the parser, not the recommended ruleset.
export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
  },
  ...featureBlocks,
]
