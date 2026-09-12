# Authentication

Poutine has three authentication mechanisms, each scoped to a different API surface. Federation auth is documented in [federation-api.md](federation-api.md); this file covers user-facing auth.

## Auth mechanisms by API surface

| Surface           | Prefix          | Mechanism                                                                             |
|-------------------|-----------------|---------------------------------------------------------------------------------------|
| Admin             | `/admin/*`      | JWT (cookie + `Authorization: Bearer` header)                                         |
| Subsonic (JSON)   | `/rest/*`       | Subsonic `u+p` (plaintext / `enc:<hex>`) **or** `u+t+s` (MD5 token+salt)              |
| Subsonic (binary) | `/rest/stream`, `/rest/getCoverArt` | Same as Subsonic JSON, but errors use HTTP status codes, not Subsonic envelopes. `/rest/stream(.view)` also accepts a `castToken=` query param (#218) as an alternate auth for non-Subsonic clients (Sonos devices, DLNA renderers) — see "Cast tokens" below |
| Proxy             | `/proxy/*`      | Unified: Ed25519 (peers) → JWT (SPA) → Subsonic `u+p` / `u+t+s`, tried in order     |
| Federation        | `/federation/*` | Ed25519-signed HTTP (see [federation-api.md](federation-api.md))                      |
| Invites           | `/api/invites/*`| None — the token in the POST body is the credential (see "User invitations")           |
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

Both admin and non-admin users can log in (#232). The returned `user.isAdmin` lets the SPA hide admin-only nav; admin-only routes (`requireOwner` preHandler) still 403 non-admin sessions. `GET /admin/me` and `POST /admin/refresh` accept any logged-in user.

The body's `accessToken` goes into `localStorage` for `Authorization` header use on `/admin/*`. The body's `subsonicCredentials` are stashed in `localStorage` as `subsonicUser` / `subsonicPass` and used to compute Subsonic `u+t+s` per request — the SPA never sends a JWT to `/rest/*`.

### Token refresh

`POST /admin/refresh` — no preHandler. Reads only the `refresh_token` cookie. Verifies → rotates both tokens → sets new cookies. On failure: clears the refresh cookie, returns 401.

### Logout

`POST /admin/logout` — clears both cookies, returns 204. The SPA also clears `accessToken`, `subsonicUser`, and `subsonicPass` from `localStorage`.

### Password update

`PUT /api/admin/hub/users/:id/password` (admin-only) with `{ password }`. Re-encrypts via `setPassword` and updates `users.password_enc`. Returns 204. Validates `password.length >= 8`. An admin can target their own id; when they do, the `subsonicCredentials` cached in `localStorage` are now stale — the admin must log out and back in to refresh them. JWTs remain valid until expiry (no forced revocation).

## User invitations (#272)

Signed, expiring, single-use grants that let an invitee create their own account — the user-facing mirror of the federation invitation flow ([federation-api.md](federation-api.md#invitations--handshake-v5)). Code: `hub/src/services/user-invites.ts` (mint/verify/consume), `hub/src/routes/invites.ts` (public), the `/user-invites` handlers in `hub/src/routes/admin.ts`, and `frontend/src/pages/InvitePage.tsx`.

**Signed with a dedicated key, not the federation key.** `settings.user_invite_key` — 32 random bytes, generated on first use, decorated as `app.userInviteKey`. A peer invitation is Ed25519-signed because a *different* hub verifies it with no prior trust; a user invite is issued and redeemed by the same hub, so HMAC-SHA-256 suffices. The Ed25519 key is cluster trust (admission and eviction) and must not be spent on account creation — the same blast-radius argument that keeps `castSecret` separate from `internalAuthSecret`. Deleting the settings row invalidates every outstanding invite; that is the rotation escape hatch.

**Canonical signing payload** (newline-joined, order fixed — reordering requires bumping `USER_INVITE_VERSION`):

```
poutine-user-invite/v1
<nonce>
<issued_at>
<expires_at>
<suggested_username-or-empty>
<is_admin: 0|1>
```

Wire format: `base64url(JSON({ payload, signature }))`. Default TTL 48 h (peers get 7 d; user invites travel over chat), capped at 30 d.

**The DB row is authoritative.** The signature only proves the token was minted here and untampered, which lets the public route reject junk before a DB hit. Single-use, expiry, and revocation live in `user_invitations`, and admission happens only through the atomic consume:

```sql
UPDATE user_invitations SET consumed_at = …, consumed_by_id = ?
 WHERE token_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL
       AND expires_at > … RETURNING *
```

Only `sha256(token)` is stored, never the token — a stolen DB copy yields no redeemable invites, which matters here precisely because `users.password_enc` is reversible.

| Method   | Path                                    | Auth           | Notes                                                                               |
|----------|-----------------------------------------|----------------|--------------------------------------------------------------------------------------|
| `POST`   | `/api/admin/hub/user-invites`           | `requireOwner` | Returns `{ id, url, token, expiresAt, … }`. The URL is shown once — only its hash is kept |
| `GET`    | `/api/admin/hub/user-invites`           | `requireOwner` | State per row: `pending` / `consumed` / `expired` / `revoked`. Never returns a token  |
| `DELETE` | `/api/admin/hub/user-invites/:id`       | `requireOwner` | Sets `revoked_at`; `409` if already consumed or revoked                              |
| `POST`   | `/api/invites/preview`                  | none           | `{ token }` → hub name, expiry, suggested username                                   |
| `POST`   | `/api/invites/redeem`                   | none           | `{ token, username, password }` → the `POST /admin/login` body shape, cookies set     |

Redeem creates the account and signs the invitee straight in, so the SPA reuses one code path. The admin grant comes from the consumed **row**, not the payload.

**Order inside the redeem transaction:** insert the user, *then* claim the invite. `consumed_by_id` is a FK onto `users`, so claiming for an account that doesn't exist yet fails the constraint; an empty claim (someone else redeemed first) throws to roll back the account along with it. The username is checked *before* the claim so a typo doesn't burn the invite.

**Hardening:**

- Both public routes are POST, so the token never appears in a URL, an access log, or a Referer header. The SPA carries it in the URL **fragment** (`/invite#<token>`) and clears the hash after reading it.
- One uniform `400 {error:"Invitation is not valid"}` for forged, expired, consumed, revoked, and unknown tokens alike — no enumeration, same posture as Subsonic error 40. Username-taken (`409`) is the one distinguishable case, and has to be.
- Per-IP fixed-window rate limit (20 / 10 min) in the plugin closure. This is the only unauthenticated write surface on the hub.
- `/invite` fires no authenticated fetch on mount — see the `/login` self-redirect trap in [pitfalls.md](pitfalls.md#auth).

## Subsonic auth flow

`/rest/*` accepts only Subsonic-style query params; there is no JWT path.

1. `u`+`p` — username + plaintext password (also accepts `enc:<hex>`-encoded password — Subsonic client convention).
2. `u`+`t`+`s` — username + `md5(password + salt)` token + per-request salt. Server decrypts the stored password, recomputes the token, constant-time compares. Tokens are 32 hex chars.

Either form authenticates a user identically. Unknown user and bad credentials both surface as Subsonic error 40 (no enumeration hint).

### Binary vs JSON error handling

- **`requireSubsonicAuth`** — returns errors as Subsonic XML/JSON envelopes with HTTP 200 (Subsonic protocol convention).
- **`requireSubsonicAuthBinary`** — returns errors as real HTTP status codes (401). Used by `stream` and `getCoverArt` where a 200 body would be interpreted as corrupt audio/image data.

Routes register via `binaryRoute()` in `routes/subsonic/index.ts` to get the binary variant.

## Trusted in-process auth (`x-poutine-internal`)

In-process Subsonic auth path used by `HubSubsonicCaller` (`hub/src/services/hub-subsonic-caller.ts`) when invoked with `{ asUser: <username> }`. Introduced #224 to remove Sonos cast's dependency on the `POUTINE_OWNER_*` credentials.

**Headers (both required, both checked):**

| Header                | Value                                          |
|-----------------------|------------------------------------------------|
| `x-poutine-internal`  | `app.internalAuthSecret` — per-boot 32-byte random, base64url-encoded |
| `x-poutine-as-user`   | Hub username to authenticate as                |

**Middleware behavior** (both `requireSubsonicAuth` and `requireSubsonicAuthBinary`):

1. If neither header is present, fall through to standard `u+p` / `u+t+s` auth.
2. If exactly one header is present, return Subsonic error 40 / HTTP 401. (No silent acceptance of half-complete trusted requests.)
3. If both are present, `crypto.timingSafeEqual` the secret against `app.internalAuthSecret`. Mismatch → error 40 / 401.
4. Look up the user by username. Missing → error 40 / 401. Password is not consulted.

**Producer contract:**

- The secret is in-process only — it must never appear in logs, in `app.config`, in env, on the wire to an external client, or in a JWT/cookie. `HubSubsonicCaller` is the only legitimate producer; new internal callers must go through it.
- Routes calling `HubSubsonicCaller.call(endpoint, params, { asUser })` are responsible for verifying the user identity up front (e.g. Sonos routes run under `requireAuth` and pass `req.username`).
- Paths without a user context (DLNA browse — LAN-gated, unauthenticated) omit `asUser` and fall through to the owner `u+p` path.

**Why a separate secret (not `castSecret`):** cast tokens are presented by untrusted LAN clients; the internal secret is presented only by code inside the hub process. Conflating the two would let a leaked cast-token-signing key escalate into impersonation of any user. They have different blast radii — keep them separate.

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

1. **Ed25519** — all four `x-poutine-*` headers present → validated against the in-memory peer registry (DB-backed, sourced from the `instances` table since federation v5; see [federation-api.md](federation-api.md)). `request.proxyAuth.kind = "peer"`. Used by peer hubs during catalog sync and streaming.
2. **JWT** — `Authorization: Bearer`, `access_token` cookie, or `token` query param → verified with `verifyToken`. `request.proxyAuth.kind = "jwt"`. Used internally for any admin-tree proxy calls.
3. **Subsonic `u+p` or `u+t+s`** — same logic as `/rest/*`. `request.proxyAuth.kind = "subsonic"`.

Returns `401` if all three fail. The forwarded request always uses fresh Navidrome `u+t+s` credentials — the incoming auth is consumed at the proxy tier and never forwarded.

## Cast tokens (`/rest/stream.view?castToken=…`)

Short-lived HMAC tokens for non-Subsonic clients that can't compute `u+t+s` — Sonos devices on the LAN, DLNA renderers. Introduced #108 (`/cast/stream/:trackId`), promoted #218 to a first-class auth mode on the Subsonic stream endpoint itself; the old relay routes (`/cast/stream`, `/dlna/stream`) are deleted.

- **Secret:** HMAC-SHA-256 key persisted in `player.db.player_settings.cast_signing_key`; first boot under #215 derives from the Ed25519 private key to preserve continuity. Decorated on the Fastify app as `app.castSecret`.
- **Format:** `<base64url(hmac)>.<exp>.<base64url(username)>`. Signed message is `trackId|exp|username`. Default TTL 1 h.
- **Binding:** token is valid only for the *exact* trackId it was issued against. The Subsonic stream handler decodes the `id` query param (strip `t` prefix), then `verifyCastToken` compares.
- **Endpoint scope:** the verifier in `requireSubsonicAuthBinary` accepts `castToken=` ONLY on URLs ending in `/stream` or `/stream.view`. `/rest/getCoverArt` and every Subsonic JSON route still require `u+p` or `u+t+s` — no auth surface widening from #218.
- **Attribution:** the carried username travels into `request.subsonicUser` after a `users` table lookup. Stream-tracking activity is tagged `kind="cast"` (Sonos) or `kind="dlna"` (DLNA — detected via the `dlna=1` URL flag).
- **Mint sites:** `routes/sonos.ts` (`/api/sonos/devices/:id/play`, `/next`) and `services/dlna-objects.ts` (DIDL `res@uri` in `Browse` responses). Both go through `buildStreamUrl()` in `services/cast-tokens.ts` — single helper, single token shape.

A cast token compromise is bounded — it grants single-track stream access for at most the TTL window, against the originating user's source-selection (no library traversal, no other Subsonic operations).

## Federation auth

Ed25519-signed HTTP requests between peers. Fully documented in [federation-api.md](federation-api.md). No JWT or password auth — peers authenticate by cryptographic signature over the request.
