# Frontend testing

Vitest + React Testing Library + jsdom. Lives in the `frontend` pnpm workspace.

## Commands

| Command                          | What it does                                           |
|----------------------------------|--------------------------------------------------------|
| `pnpm test`                      | Runs hub tests, then frontend tests (root script)      |
| `pnpm --filter frontend test`    | Frontend suite only, one-shot (`vitest run`)           |
| `pnpm --filter frontend test:watch` | Watch mode (`vitest`)                               |
| `pnpm --filter frontend typecheck` | `tsc --noEmit` — run alongside tests before commit   |

## Layout

- Tests live next to source: `*.test.ts` / `*.test.tsx`.
- Shared setup: `frontend/src/test/setup.ts` — loads `@testing-library/jest-dom` matchers and installs an in-memory `localStorage`/`sessionStorage` polyfill. Some Node/jsdom combos expose `localStorage` as a non-function stub, which breaks module-load code in `src/lib/api.ts`.
- Config: `frontend/vitest.config.ts` (`environment: "jsdom"`, `globals: true`, `@` alias mirrors `vite.config.ts`).

## Patterns

### Testing a page that uses `useQuery`

Wrap in a fresh `QueryClient` (`retry: false`) and `MemoryRouter`. Mock the Subsonic client with `vi.mock("@/lib/subsonic", ...)`; preserve the real `SubsonicError` export via `vi.importActual` so production error types round-trip through tests. See `src/pages/ArtistsPage.test.tsx`.

### Testing error surfacing

Reject the mocked API with a `SubsonicError(message, code)` and assert on `getByRole("alert")` plus the rendered code/message. The shared `<ErrorMessage>` component is the single renderer for query errors.

### Testing stores

Zustand stores expose `setState` / `getState` directly — reset in `beforeEach` (`useToasts.setState({ toasts: [] })`). Use `vi.useFakeTimers()` for time-based behavior like toast auto-dismiss.

## Adding a new test

1. Co-locate the file with the module under test.
2. Reuse existing mocks where possible; prefer `vi.importActual` over hand-stubbing shared types.
3. Assert on accessible roles (`getByRole("alert")`, `getByRole("button")`) over class names or text fragments when practical.
4. Run `pnpm --filter frontend test` and `pnpm --filter frontend typecheck` before committing.

## Gotchas

- `vi.mock` is hoisted — no top-level variables inside the factory.
- jsdom does not implement `HTMLMediaElement` playback; test the surrounding logic (state, toast dispatch) rather than `<audio>` behavior itself.
- If a test imports from `@/lib/api` or `@/lib/subsonic`, the `localStorage` polyfill in `setup.ts` must be in place — do not remove it.
