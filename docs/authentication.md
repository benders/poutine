# Authentication

Poutine has three authentication mechanisms, each scoped to a different API surface. Federation auth is documented in [federation-api.md](federation-api.md); this file covers user-facing auth.

## Auth mechanisms by API surface

| Surface           | Prefix          | Mechanism                                                                             |
|-------------------|-----------------|---------------------------------------------------------------------------------------|
| Admin             | `/admin/*`      | JWT (cookie + `Authorization: Bearer` header)                                         |
| Subsonic (JSON)   | `/rest/*`       | JWT **or** legacy Subsonic `u`+`p` query params                                       |
| Subsonic (binary) | `/rest/stream`, `/rest/getCoverArt` | Same as Subsonic JSON, but errors use HTTP status codes, not Subsonic envelopes |
| Proxy             | `/proxy/*`      | Unified: Ed25519 (peers) → JWT (SPA) → Subsonic `u`+`p` (3rd-party), tried in order |
| Federation        | `/federation/*` | Ed25519-signed HTTP (see [federation-api.md](federation-api.md))                      |
| Health            | `/api/health`   | None                                                                                  |

## Passwords

Argon2id via the `argon2` npm package. Config: 64 MB memory, time cost 3, parallelism 4. Hashing is async. Utility functions: `hashPassword` / `verifyPassword` in `hub/src/auth/passwords.ts`.

## JWT tokens

Signed with HS256. Secret: `JWT_SECRET` env var (required in prod). Two token types:

| Token         | Lifetime | Cookie              | Cookie path        | Claims                    |
|---------------|----------|---------------------|--------------------|---------------------------|
| Access token  | 15 min   | `access_token`      | `/`                | `{ userId, sub: userId }` |
| Refresh token | 7 days   | `refresh_token`     | `/admin/refresh`   | `{ userId, sub: userId, type: "refresh" }` |

Lifetimes configurable via `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` env vars.

Both cookies are `httpOnly`, `sameSite: lax`.

### Token extraction order

JWT extraction follows the same order in both admin middleware (`requireAuth`) and Subsonic middleware (`requireSubsonicAuth`):

1. `Authorization: Bearer <token>` header
2. `access_token` cookie
3. `token` query parameter

The query param exists for `<audio>` and `<img>` elements that cannot set headers or cookies programmatically.

### Access vs refresh token verification

`verifyToken` accepts any valid JWT. `verifyRefreshToken` additionally requires the `type: "refresh"` claim — this prevents an access token from being used at the refresh endpoint. Separate functions in `hub/src/auth/jwt.ts`.

## Admin auth flow

### Login

`POST /admin/login` with `{ username, password }`.

1. Looks up user by username, verifies password with Argon2id.
2. Creates access + refresh JWTs.
3. Sets both httpOnly cookies on the response.
4. Returns `{ user, accessToken }` in the body.

The body token goes into `localStorage` for `Authorization` header use. The cookie enables requests from browser elements that can't set headers (art, streams).

### Token refresh

`POST /admin/refresh` — no preHandler (no auth middleware). Reads only the `refresh_token` cookie.

1. Verifies refresh token via `verifyRefreshToken` (checks `type: "refresh"` claim).
2. Creates new access + refresh tokens (rotation).
3. Sets new cookies, returns `{ accessToken }`.
4. On failure: clears the refresh cookie, returns 401.

### Logout

`POST /admin/logout` — clears both cookies, returns 204.

## Subsonic auth flow

Subsonic endpoints accept two auth methods, tried in order:

1. **JWT** — same extraction as admin (header → cookie → query param). If a valid JWT is found, the user is authenticated. If the JWT is invalid/expired, falls through to method 2.
2. **Legacy Subsonic params** — `u` (username) + `p` (password) query parameters. Supports `enc:<hex>` prefix for hex-encoded passwords (Subsonic client convention). Verifies against the stored Argon2id hash.

This dual auth lets the Poutine SPA use its JWT seamlessly while third-party Subsonic clients (DSub, Symfonium, etc.) work with username + password.

### Binary vs JSON error handling

Two middleware variants exist:

- **`requireSubsonicAuth`** — returns errors as Subsonic XML/JSON envelopes with HTTP 200 (Subsonic protocol convention).
- **`requireSubsonicAuthBinary`** — returns errors as real HTTP status codes (401). Used by `stream` and `getCoverArt` where a 200 body would be interpreted as corrupt audio/image data.

Routes register via `binaryRoute()` in `subsonic.ts` to get the binary variant.

## Frontend token management

`frontend/src/lib/api.ts` handles client-side auth:

- **`apiFetch()`** attaches `Authorization: Bearer` from `localStorage` to every admin API call.
- **`subsonicFetch()`** (`frontend/src/lib/subsonic.ts`) does the same for Subsonic calls.
- **`artUrl()` / `streamUrl()`** rely on the `access_token` cookie (browser sends it automatically for `<img>` / `<audio>` src). **Do NOT embed the JWT in art/stream URLs** — it gets baked in at render time and goes stale on refresh, causing 401s.
- **Silent refresh:** on 401, both `apiFetch` and `subsonicFetch` call `attemptRefresh()`, which is deduped by a module-level `refreshPromise` to prevent concurrent refresh races. On success, retries the original request. On failure, clears tokens and redirects to `/login`.

## Owner seeding

`seedOwner()` runs in `buildApp()` only when the `users` table is empty. Reads `POUTINE_OWNER_USERNAME` / `POUTINE_OWNER_PASSWORD` from env vars.

Argon2 hashing is async, so seeding cannot live in the synchronous `createDatabase()`. If env credentials change after first boot, reset the password directly in the DB using `hashPassword` from `hub/dist/auth/passwords.js`.

## Proxy auth (`/proxy/*`)

`/proxy/*` is a transparent authenticated proxy to the local Navidrome. Three auth modes tried in order by `hub/src/proxy/auth.ts`:

1. **Ed25519** — all four `x-poutine-*` headers present → validated against `peers.yaml` registry. `request.proxyAuth.kind = "peer"`. Used by peer hubs during catalog sync and streaming.
2. **JWT** — `Authorization: Bearer`, `access_token` cookie, or `token` query param → verified with `verifyToken`. `request.proxyAuth.kind = "jwt"`. Used by the SPA.
3. **Subsonic u+p** — `u` + `p` query params (plaintext or `enc:<hex>`), verified via Argon2id. `request.proxyAuth.kind = "subsonic"`. Note: `u+t+s` (MD5 token auth) is not supported — Poutine stores Argon2id hashes, not plaintext.

Returns `401` if all three fail. Implementation detail: the forwarded request always uses fresh Navidrome `u+t+s` credentials — the incoming auth is consumed at the proxy tier and never forwarded.

## Federation auth

Ed25519-signed HTTP requests between peers. Fully documented in [federation-api.md](federation-api.md). No JWT or password auth — peers authenticate by cryptographic signature over the request.
