# Authentication

Poutine has three authentication mechanisms, each scoped to a different API surface. Federation auth is documented in [federation-api.md](federation-api.md); this file covers user-facing auth.

## Auth mechanisms by API surface

| Surface           | Prefix          | Mechanism                                                                             |
|-------------------|-----------------|---------------------------------------------------------------------------------------|
| Admin             | `/admin/*`      | JWT (cookie + `Authorization: Bearer` header)                                         |
| Subsonic (JSON)   | `/rest/*`       | Subsonic `u+p` (plaintext / `enc:<hex>`) **or** `u+t+s` (MD5 token+salt)              |
| Subsonic (binary) | `/rest/stream`, `/rest/getCoverArt` | Same as Subsonic JSON, but errors use HTTP status codes, not Subsonic envelopes |
| Proxy             | `/proxy/*`      | Unified: Ed25519 (peers) → JWT (SPA) → Subsonic `u+p` / `u+t+s`, tried in order     |
| Federation        | `/federation/*` | Ed25519-signed HTTP (see [federation-api.md](federation-api.md))                      |
| Health            | `/api/health`   | None                                                                                  |

## Passwords

Stored as AES-256-GCM ciphertext (`base64(iv ‖ ct ‖ tag)`) in `users.password_enc`. Reversible storage is required to answer Subsonic `u+t+s` (MD5 of plaintext+salt). Helpers: `setPassword` / `verifyPassword` / `getStoredPassword` in `hub/src/auth/passwords.ts`; AES primitives in `hub/src/auth/password-crypto.ts`.

The encryption key is generated on first boot, persisted at `$POUTINE_PASSWORD_KEY_PATH` (default `./data/poutine_password_key`, mode 0600), and never exposed via any API. **Lose this file and every stored password becomes unrecoverable.** Back it up alongside the SQLite database.

## JWT tokens

Used for `/admin/*` only. Signed with HS256. Secret: auto-generated on first boot (32 random bytes, hex-encoded) and persisted in the `settings` table under key `jwt_secret`. Resetting the DB regenerates the secret and invalidates all existing tokens. Two token types:

| Token         | Lifetime | Cookie              | Cookie path        | Claims                    |
|---------------|----------|---------------------|--------------------|---------------------------|
| Access token  | 15 min   | `access_token`      | `/`                | `{ userId, sub: userId }` |
| Refresh token | 7 days   | `refresh_token`     | `/admin/refresh`   | `{ userId, sub: userId, type: "refresh" }` |

Lifetimes configurable via `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` env vars. Both cookies are `httpOnly`, `sameSite: lax`.

### Token extraction order (admin)

1. `Authorization: Bearer <token>` header
2. `access_token` cookie
3. `token` query parameter

`verifyToken` accepts any valid JWT. `verifyRefreshToken` additionally requires the `type: "refresh"` claim — separate functions in `hub/src/auth/jwt.ts`.

## Admin auth flow

### Login

`POST /admin/login` with `{ username, password }`.

1. Looks up user, verifies password by AES-decrypting `password_enc` and constant-time comparing.
2. Creates access + refresh JWTs, sets both httpOnly cookies.
3. Returns `{ user, accessToken, subsonicCredentials: { username, password } | null }`.

The body's `accessToken` goes into `localStorage` for `Authorization` header use on `/admin/*`. The body's `subsonicCredentials` are stashed in `localStorage` as `subsonicUser` / `subsonicPass` and used to compute Subsonic `u+t+s` per request — the SPA never sends a JWT to `/rest/*`.

### Token refresh

`POST /admin/refresh` — no preHandler. Reads only the `refresh_token` cookie. Verifies → rotates both tokens → sets new cookies. On failure: clears the refresh cookie, returns 401.

### Logout

`POST /admin/logout` — clears both cookies, returns 204. The SPA also clears `accessToken`, `subsonicUser`, and `subsonicPass` from `localStorage`.

## Subsonic auth flow

`/rest/*` accepts only Subsonic-style query params; there is no JWT path.

1. `u`+`p` — username + plaintext password (also accepts `enc:<hex>`-encoded password — Subsonic client convention).
2. `u`+`t`+`s` — username + `md5(password + salt)` token + per-request salt. Server decrypts the stored password, recomputes the token, constant-time compares. Tokens are 32 hex chars.

Either form authenticates a user identically. Unknown user and bad credentials both surface as Subsonic error 40 (no enumeration hint).

### Binary vs JSON error handling

- **`requireSubsonicAuth`** — returns errors as Subsonic XML/JSON envelopes with HTTP 200 (Subsonic protocol convention).
- **`requireSubsonicAuthBinary`** — returns errors as real HTTP status codes (401). Used by `stream` and `getCoverArt` where a 200 body would be interpreted as corrupt audio/image data.

Routes register via `binaryRoute()` in `subsonic.ts` to get the binary variant.

## Frontend token management

`frontend/src/lib/api.ts` handles client-side auth:

- **`apiFetch()`** attaches `Authorization: Bearer` from `localStorage` to every `/admin/*` call.
- **`subsonicFetch()`** (`frontend/src/lib/subsonic.ts`) reads `subsonicUser` / `subsonicPass` from `localStorage`, generates a fresh 8-byte hex salt per call, computes `md5(password + salt)` via `js-md5`, and appends `u`/`t`/`s`/`v`/`c`/`f=json` to the request.
- **`streamUrl()` / `artUrl()`** embed `u+t+s` directly in the URL. Salt is fresh per render, so URLs cannot be replayed at scale.
- **Silent refresh:** still applies on `/admin/*` (JWT). On 401, `apiFetch` calls `attemptRefresh()` (deduped via module-level `refreshPromise`). On `/rest/*`, there is no refresh — `u+t+s` doesn't expire, so any 401 redirects to `/login`.
- **No authenticated fetches from `/login`.** The login route must not trigger any `apiFetch`/`subsonicFetch` calls — a 401 from the login route is the classic infinite-redirect loop. Hooks or components that fire authenticated requests on mount (e.g. `useDocumentTitle`) must live inside the authenticated tree (`AppLayout`), not in the top-level `App`. The 401 redirect in `apiFetch` is also guarded against self-redirect when already on `/login`.

## Owner seeding

`seedOwner()` runs in `buildApp()` and handles two cases:

- **First boot** (no real users yet): inserts the owner row using `POUTINE_OWNER_USERNAME` / `POUTINE_OWNER_PASSWORD`.
- **Post-migration recovery** (owner row exists with empty `password_enc`): repopulates the password from `POUTINE_OWNER_PASSWORD`. This is the recovery path after the #106 Argon2id → AES migration wipes all stored passwords.

Setting a different `POUTINE_OWNER_PASSWORD` in env never overwrites a non-empty `password_enc`.

## Proxy auth (`/proxy/*`)

`/proxy/*` is a transparent authenticated proxy to the local Navidrome. Three auth modes tried in order by `hub/src/proxy/auth.ts`:

1. **Ed25519** — all four `x-poutine-*` headers present → validated against `peers.yaml` registry. `request.proxyAuth.kind = "peer"`. Used by peer hubs during catalog sync and streaming.
2. **JWT** — `Authorization: Bearer`, `access_token` cookie, or `token` query param → verified with `verifyToken`. `request.proxyAuth.kind = "jwt"`. Used internally for any admin-tree proxy calls.
3. **Subsonic `u+p` or `u+t+s`** — same logic as `/rest/*`. `request.proxyAuth.kind = "subsonic"`.

Returns `401` if all three fail. The forwarded request always uses fresh Navidrome `u+t+s` credentials — the incoming auth is consumed at the proxy tier and never forwarded.

## Federation auth

Ed25519-signed HTTP requests between peers. Fully documented in [federation-api.md](federation-api.md). No JWT or password auth — peers authenticate by cryptographic signature over the request.
