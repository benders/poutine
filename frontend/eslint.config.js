import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * Frontend ESLint config.
 *
 * Boundary enforcement (#221, parent #212): the three feature directories
 * may not cross-import. `features/shared/` is intentionally importable
 * from any side. This supersedes the tactical
 * `feature-boundaries.test.ts` (kept as a belt-and-braces safety net).
 *
 *   - features/hub-admin/**    must not import features/player-admin/** or features/player/**
 *   - features/player-admin/** must not import features/hub-admin/**     or features/player/**
 *   - features/player/**       must not import features/hub-admin/**     or features/player-admin/**
 *
 * Player UI calls Subsonic + `/api/sonos/*` only — this is enforced by
 * convention today (no Hub-admin endpoints in `apiClient` for the player
 * surface) and by these directory rules.
 */
const noCrossFeatureImports = (here, forbidden) => ({
  files: [`src/features/${here}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: forbidden.flatMap((other) => [
          {
            group: [
              `**/features/${other}/**`,
              `../${other}/**`,
              `../../${other}/**`,
              `../../../${other}/**`,
            ],
            message: `features/${here}/** must not import from features/${other}/**. Use features/shared/ for cross-cutting helpers.`,
          },
        ]),
      },
    ],
  },
})

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  noCrossFeatureImports('hub-admin', ['player-admin', 'player']),
  noCrossFeatureImports('player-admin', ['hub-admin', 'player']),
  noCrossFeatureImports('player', ['hub-admin', 'player-admin']),
])
