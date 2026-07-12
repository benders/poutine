// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Hub backend ESLint config — enforces the Hub/Player directory boundary
 * mechanically (#221, parent #212).
 *
 * The audit in #212 identified five Player-owned files that historically
 * reached into Hub internals (better-sqlite3, the in-process Subsonic
 * adapter, preferred-source DB helpers). Phases #213–#220 removed those
 * imports; this config makes future regressions a lint failure.
 *
 * Boundary model:
 *   - Player-owned source files (the `playerFiles` glob below) may only
 *     touch Hub via the shared HTTP-shaped surface in
 *     `services/hub-subsonic-caller.ts`.
 *   - The only file allowed to import `better-sqlite3` from the Player
 *     side is `db/player-db.ts` (the player.db opener). Other Player
 *     code receives a Database handle via capability injection, using a
 *     type-only `import type Database from "better-sqlite3"` — which is
 *     erased at runtime and is therefore allowed (no-restricted-imports
 *     does not block type-only imports).
 *
 * If you must carve out an exception, add the file to `playerCarveOuts`
 * with a comment explaining why.
 */

// Glob patterns relative to the eslint root (= this directory).
const playerFiles = [
  "src/routes/sonos.ts",
  "src/routes/dlna.ts",
  "src/services/sonos-*.ts",
  "src/services/dlna-*.ts",
  "src/services/cast-tokens.ts",
  "src/services/didl.ts",
  "src/services/soap.ts",
  "src/services/ssdp-advertiser.ts",
  "src/services/player-settings.ts",
];

// Files allowed to import better-sqlite3 directly. Everything else on the
// Player side must take a Database handle by capability injection.
const playerDbOpenerFiles = ["src/db/player-db.ts"];

// `allowTypeImports: true` lets Player code keep
//   `import type Database from "better-sqlite3"`
// for capability-injection signatures. That import is erased at compile
// time so it doesn't create a runtime dependency on the Hub DB layer.
const forbiddenForPlayer = [
  {
    name: "better-sqlite3",
    message:
      "Player code must not import better-sqlite3 at runtime. Take a Database " +
      "handle by capability injection (see `db/player-db.ts`), or for shared " +
      "reads go through Hub Subsonic via `services/hub-subsonic-caller.ts`. " +
      "Type-only imports (`import type ...`) are fine.",
    allowTypeImports: true,
  },
  {
    name: "../adapters/subsonic.js",
    message:
      "Player code must not use the in-process Subsonic adapter " +
      "(`SubsonicClient`). Go through `services/hub-subsonic-caller.ts` " +
      "which speaks the HTTP-shaped /rest/* surface (#220).",
  },
  {
    name: "../adapters/subsonic",
    message:
      "Player code must not use the in-process Subsonic adapter " +
      "(`SubsonicClient`). Go through `services/hub-subsonic-caller.ts` (#220).",
  },
];

const forbiddenPatternsForPlayer = [
  {
    group: ["**/db/preferred-source*", "**/db/client*", "**/db/schema*"],
    message:
      "Player code must not reach into Hub DB modules. Use the Hub Subsonic " +
      "HTTP surface (`services/hub-subsonic-caller.ts`) instead.",
  },
  {
    group: ["**/adapters/subsonic*"],
    message:
      "Player code must not import the in-process Subsonic adapter. " +
      "Go through `services/hub-subsonic-caller.ts` (#220).",
  },
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "test/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Project doesn't enforce these globally yet; #221 is scoped to the
      // boundary rule, not a general lint cleanup. Disable noise so the
      // boundary rule failures stand out.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/triple-slash-reference": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-empty": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-misleading-character-class": "off",
      "no-cond-assign": "off",
      "no-self-assign": "off",
      "no-prototype-builtins": "off",
      "no-constant-condition": "off",
      "no-async-promise-executor": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-undef": "off",
      "prefer-const": "off",
    },
  },
  {
    // Player-side files: forbid Hub-internal imports.
    files: playerFiles,
    ignores: playerDbOpenerFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: forbiddenForPlayer,
          patterns: forbiddenPatternsForPlayer,
        },
      ],
    },
  },
);
