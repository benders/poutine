# Poutine Security Assessment

**Date:** 2026-09-13
**Scope:** Code-level review of every attack surface — Subsonic API, admin API, SPA,
`/proxy/*` (Navidrome proxy), DLNA MediaServer, Sonos cast, federation, external
fetches, database access, dependency set — assessed against OWASP Top 10 (2021),
CIS Docker Benchmark, and common credential-handling guidance. Docs + source review;
no live attack. Issue #278.

## Verdict

**Not ready for unrestricted public-internet exposure as-is.** Poutine is built for a
small, socially trusted user base (owner + invited users + peer hubs) and assumes the
LAN is a safe zone. Several controls that make that model work on a LAN are absent or
weaker at the WAN edge:

- No TLS anywhere in the product, and no enforcement that the operator provides it
  (H1). Cookies lack `Secure`.
- CORS reflects **any** origin with credentials (H2).
- `/proxy/*` forwards **arbitrary paths** to the internal Navidrome, including
  `/auth/login`, which mints a Navidrome **admin** JWT for any Poutine user or peer (H3).
- No rate limiting or lockout on any credential surface (H5).
- 43 known dependency vulnerabilities, 22 high (H4).

With those five fixed, dependencies current, and the operator checklist below
followed, Poutine is reasonable for a **publicly reachable, small trusted-user
service** (a few family accounts + peer hubs) behind TLS termination. It is not
designed for open registration, many anonymous users, or adversarial users — that
assumption should stay documented.

## Attack surface

| Surface                  | Authn                          | Reachable from WAN by default |
|--------------------------|--------------------------------|-------------------------------|
| `/rest/*` (Subsonic)     | u+p or u+t+s (per-user)        | yes                           |
| `/admin/*` (owner API)   | JWT cookie / bearer / `?token=`| yes                           |
| SPA (`/`)                | JWT cookie (sub users: u+p)    | yes                           |
| `/proxy/*` (Navidrome)   | JWT or u+t+s, peer sig         | yes                           |
| `/federation/*`          | Ed25519 request signature      | yes (signed requests only)    |
| `/dlna/*` (UPnP MS)      | **none** — LAN-header gate     | LAN; see M2                   |
| `/sonos/*`               | owner JWT + LAN-header gate    | LAN                           |
| `/api/health`, `/api/version`, `/player/health`, `/api/capabilities` | none | yes (info disclosure, M9) |

## Findings

| ID  | Sev   | Area                | Finding                                                        |
|-----|-------|---------------------|----------------------------------------------------------------|
| H1  | High  | Transport           | No TLS support; cookies without `Secure`; no HSTS               |
| H2  | High  | CORS                | `origin: true, credentials: true` reflects any origin           |
| H3  | High  | Proxy               | `/proxy/*` has no path allowlist — leaks Navidrome admin JWT + native API |
| H4  | High  | Dependencies        | 43 advisories (3 low / 18 moderate / 22 high)                   |
| H5  | High  | Authn               | No rate limiting / lockout on any credential surface            |
| M1  | Medium| Logging             | Credentials in URLs logged unredacted                           |
| M2  | Medium| DLNA / Sonos        | "LAN-only" is a proxy-header heuristic, not a network boundary  |
| M3  | Medium| JWT                 | No token-type check; no revocation; secret in DB; `?token=`     |
| M4  | Medium| SPA credentials     | Password in login response + localStorage                       |
| M5  | Medium| Password storage    | Reversible (AES-GCM) with single on-disk key                    |
| M6  | Medium| Federation          | Any admitted hub can evict any other; 5-min replay window       |
| M7  | Medium| Container           | Runs as root; `:latest` tags; no resource limits                |
| M8  | Medium| HTTP headers        | No CSP / X-Content-Type-Options / Referrer-Policy / X-Frame-Options |
| M9  | Low-Med| Info disclosure    | Unauthenticated version/health endpoints                        |
| M10 | Medium| Credential policy   | No strength checks on owner password; 8-char floor only         |
| L1  | Low   | Error handling      | Owner-gated endpoints echo upstream errors                      |
| L2  | Low   | Cast tokens         | 1 h TTL, single-track, but public `lan_url` makes them WAN-reachable |
| L3  | Low   | Escape hatches      | `POUTINE_ALLOW_PRIVATE_PEER_URLS` and friends mis-set in prod   |

### H1 — No TLS, no `Secure` cookies, no HSTS

`server.ts` serves plain HTTP on `0.0.0.0:PORT`. TLS is documented as the operator's
responsibility (`example.env`: "Cloudflare Tunnel, Caddy, Traefic, nginx, Tailscale
Funnel"), but nothing enforces or detects it:

- `access_token` and `refresh_token` cookies are set without `Secure`
  (`auth/jwt.ts`). Over plain HTTP the session rides the wire unencrypted; there is
  no `HTTPS`/`TLS_PROXY` env flag to switch `Secure` on.
- No `Strict-Transport-Security` is ever emitted (reasonable to delegate to the
  proxy, but the product cannot signal it).
- Subsonic `u+p` is **plaintext password over the wire** (the `enc:` prefix is hex,
  not encryption — protocol-mandated, accepted for client compatibility). If the
  operator forgets TLS, every Subsonic request leaks the password.

**Fix:** add a config flag (e.g. `POUTINE_TLS_BEHIND_PROXY`) that sets `Secure` on
both cookies and adds HSTS with `includeSubDomains` stripped-out semantics delegated
to the edge; add a boot warning when the SPA is served without a forwarding header
indicating TLS termination.

### H2 — CORS reflects any origin with credentials

```ts
app.register(cors, { origin: true, credentials: true });
```

`origin: true` makes `@fastify/cors` echo back the request's `Origin`, and
`credentials: true` adds `Access-Control-Allow-Credentials: true`. Any site can make
cross-origin **credentialed** requests to the API. `SameSite=Lax` blocks most
cross-site cookie *sending*, so this is not a trivial session hijack today — but it
is the OWASP-recommended anti-pattern, and it fully breaks if cookies are ever
loosened to `SameSite=None` (the standard fix for cross-site *use* of the SPA).

The SPA is same-origin in production (served by the hub) and uses the Vite dev
proxy in development. **CORS is not needed at all.**

**Fix:** delete the CORS registration, or set `origin` to an explicit allowlist env.

### H3 — `/proxy/*` has no path allowlist

`routes/proxy.ts` mounts `app.all("/*")` under `/proxy` and forwards
`request.url` minus the prefix **verbatim** to the internal Navidrome base URL,
injecting the bundled Navidrome **admin** credentials (`u+t+s`) into the query.
Consequences:

- `GET /proxy/auth/login` (with injected admin creds) makes Navidrome mint a
  **Navidrome admin JWT**, returned to *any* authenticated Poutine caller —
  regular Subsonic user **or peer hub**.
- `/proxy/api/*` (Navidrome's native, fully-privileged REST API) is reachable
  through the proxy; calls return 401 today only because the proxy's header
  allowlist drops `Authorization` and the native API needs it. That is
  coincidental, not enforced.

This contradicts the project's own rule (`docs/pitfalls.md`): *"Never expose the
Navidrome native API (`/api/*`) to peers… Peer-visible data goes through Subsonic
(`/rest/*`) or Poutine's own `/federation/*` contract."* If the Navidrome container
is ever reachable directly (published port, host-network mode, shared host), a
leaked admin JWT is full control of the bundled instance.

**Fix:** allowlist the forwarded path (e.g. `/rest/*` only, plus whatever the SPA
actually needs); reject everything else with 404. Add a regression test asserting
`/proxy/auth/login` and `/proxy/api/*` are rejected.

### H4 — Dependency vulnerabilities (43)

`pnpm audit --prod` (2026-09-13): **3 low, 18 moderate, 22 high**. Notables:

| Package          | Installed | Fixed in | Issue                                                              |
|------------------|-----------|----------|--------------------------------------------------------------------|
| `undici`         | 7.24.5    | 7.29.0   | TLS cert validation bypass; cross-user info disclosure; queue poisoning (direct dep, used for external fetches) |
| `fast-uri`       | 3.1.2     | 3.1.6    | SSRF / host confusion — Fastify's URI parser (direct dep)           |
| `find-my-way`    | 9.5.0     | 9.7.0    | HTTP/2 DDoS (via fastify)                                          |
| `@fastify/static`| 9.1.0     | 10.1.1   | Route guard bypass — serves the SPA                                |
| `react-router`   | 7.13.1    | 7.18.2   | XSS in RSC, unbounded-path DoS, unauthenticated DoS, RSC CSRF (frontend) |
| `brace-expansion`| various   | 5.0.9    | Exponential-time DoS (transitive, glob via eslint)                 |

**Fix:** `pnpm up` (major bumps for `@fastify/static`, `undici`); re-run
`pnpm audit --prod` until clean; add `pnpm audit --prod` to CI as a gate.

### H5 — No rate limiting or lockout

No 429, no throttle, no lockout exists anywhere in the codebase (verified by grep).
On a public endpoint:

- `/admin/login` and `/admin/refresh` — unbounded owner-password brute force.
- `/rest/*` — unbounded `u+p` (plaintext) guessing per Subsonic user, and
  `u+t+s` MD5-token guessing (salt is random per request, but nothing throttles
  attempts).
- `/proxy/*` — same credential surface re-exposed.

Subsonic clients tolerate slow responses, so a per-IP + per-account limiter
(5–10 failures/min lockout, exponential backoff) is low-risk for real players
(single stream per user) and should be added before public exposure. Federation
gossip/announce are signature-gated and need no limiter; peer *gossip acceptance*
rate-limiting is tracked in #153/#244.

### M1 — Credentials in URLs are logged unredacted

Fastify's default pino logger records the full request URL, and there is no
`redact` config (`server.ts` logger block). That means, in every log line:

- `/rest/*?...&u=alice&p=<plaintext-password>` for `u+p` calls,
- `castToken=...` (1 h TTL, grants full track stream) in `/rest/stream.view`,
- `?token=<JWT>` on `/admin/*` and `/proxy/*` bearer-via-query calls.

Logs ship to the operator's console (New Relic when configured) and to
`docker compose logs`. **Fix:** pino `redact` paths for `req.url` query params
(`p`, `t`, `s`, `token`, `castToken`) — or rewrite the URL in the logger
`serializers` before logging.

### M2 — "LAN-only" is a header heuristic, not a boundary

`auth/lan-only.ts` (`requireLan`) rejects a request if it carries *any* of a list
of proxy/tunnel headers (`x-forwarded-for`, `cf-connecting-ip`, `forwarded`, …).
That is a proxy-detection heuristic:

- A tunnel that does **not** add those headers (raw TCP port forward, Tailscale
  without Funnel, some load balancers in passthrough mode) passes the gate. The
  entire **unauthenticated** DLNA surface (`/dlna/device.xml`, ContentDirectory
  browse of the full merged library, `/rest/stream.view?castToken=`) is then
  internet-reachable.
- Conversely, a misconfigured reverse proxy *adds* the headers for genuinely
  local clients, breaking legitimate LAN use (the `DLNA_TRUSTED_PROXY_HEADERS`
  escape hatch, #189, addresses half of this).

DLNA browses and streams as the owner, so a bypass
leaks the **whole merged library** to strangers.

**Fix:** for public exposure, DLNA must be off by default when a forwarding
header has ever been seen, or (better) the gate must key off source IP
classification (RFC 1918 / link-local vs public) rather than headers. Sonos
routes are JWT-gated so their exposure is bounded to authenticated users, but
they share the same heuristic.

### M3 — JWT weaknesses

`auth/jwt.ts` signs `{ sub, username, role }` with HS256. Verified gaps:

1. **No token type.** `verifyToken` checks signature/expiry only. A refresh
   token (7-day `exp`, httpOnly cookie) is accepted as a bearer access token on
   every `/admin/*` and `/proxy/*` route. A stolen refresh cookie grants a
   7-day access token, not just the ability to rotate. **Fix:** `type` claim;
   reject mismatch.
2. **No revocation.** Logout/refresh-rotation deletes cookie state, but a stolen
   JWT remains valid until `exp`. Acceptable for a 15-min access token; not for
   the 7-day refresh. A small `jti` denylist (or shorter refresh TTL + reuse
   detection, which rotation already half-does) would close it.
3. **Secret lives in SQLite** (`settings.jwt_secret`), same volume as the
   database. A stolen `hub.db` backup forges unlimited tokens. Documented
   trade-off; flag it in the backup docs.
4. **`?token=` query transport** for bearer on `/admin/*` and `/proxy/*` —
   leaks via logs (M1), referrer headers, and shell history. Keep for
   non-browser clients, but redact (M1) and document.

### M4 — Plaintext password in login response + localStorage

`/admin/login` returns `{ …, password }` — documented and deliberate, because the
Subsonic protocol authenticates by raw password and the SPA must compute `t+s`
client-side. The SPA persists it in `localStorage`
(`frontend/src/lib/{api,subsonic}.ts`). Any XSS therefore yields the full
plaintext credential, not just the session. Mitigations in place: httpOnly
session cookies, no `dangerouslySetInnerHTML`, React default escaping. The
residual risk is the inherent tension between browser-based Subsonic and
password-based client auth; a first-class "SPA token" Subsonic credential
(server-issued, per-client) would remove the password from the browser
entirely. (Related: #229 — DLNA needs its own identity, same tension.)

### M5 — Reversible password storage

User passwords are AES-256-GCM encrypted at rest with a single 32-byte key in
`data/poutine-keyfile` (0600). Reversible storage is a **documented trade-off**
(the merged catalog must call Navidrome with the original password). Consequences
to state plainly:

- Compromise of `hub.db` **and** the keyfile (same Docker volume; same backup)
  yields every user's plaintext password.
- One key wraps all passwords — no per-password key wrapping to limit blast
  radius.
- Backup/restore docs must treat the keyfile as at least as sensitive as the DB.

### M6 — Federation trust model

Solid: Ed25519 request signatures, timestamp window, signed invitations with
atomic single-use nonces, tombstone provenance for re-admission, SSRF checks on
peer URLs at handshake **and** use, binary error envelopes that don't echo
upstream failures. Residual, documented-accepted risks:

- **Any admitted hub can evict any other** (no quorum). One compromised hub can
  disrupt the whole mesh. Tracked in #153/#244 (gossip rate limiting,
  transitive trust).
- **No nonce** — a signed request is replayable within the 5-minute window.
  Moot for read-only endpoints; relevant if the contract grows mutations.
- **DNS rebinding** between the handshake's SSRF check and later fetches —
  documented in `url-safety.ts`; mitigated only by the peer having to re-resolve
  to a private IP *and* us refetching. Accept for a trusted hub; revisit if
  the mesh grows.
- Untrusted **catalog data** (artist/album names, genres) from peers flows into
  the merged catalog and the SPA. No injection vector found (parameterized SQL,
  React escaping), but peers can serve junk/offensive metadata.

### M7 — Container hardening (CIS Docker Benchmark)

- `hub/Dockerfile` has **no `USER` directive** — runtime is root
  (CIS 4.1/4.2). Same for the upstream `deluan/navidrome` image.
- Compose uses `:latest` for both images (CIS: pin immutable tags).
- No `deploy.limits` / mem+cpulimits (CIS 5.x resource isolation).
- Positives: hub+navidrome on `internal` network, music volume read-only,
  navidrome not port-published, secrets via env (never baked in).

**Fix:** add a non-root user to the runtime stage; pin image versions; add
limits. (Single-container milestone #246 may absorb this.)

### M8 — No security headers

No CSP, `X-Content-Type-Options`, `Referrer-Policy`, or `X-Frame-Options` on the
SPA or API responses; no CSP `<meta>` in `index.html`. With M4 (password in
localStorage) the absence of a CSP baseline widens the XSS blast radius.

**Fix:** `helmet`-equivalent set in `server.ts` (a narrow `Content-Security-Policy`
allowing self + `data:` for images is sufficient — no third-party script origins);
add `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.

### M9 — Unauthenticated info disclosure

`/api/health` (app version, Navidrome reachable flag), `/api/version`,
`/player/health`, `/api/capabilities` are open by design (synthetics, #277).
Collectively they fingerprint version and internal state for targeted attacks
especially relevant given H4). Consider a "public" health variant that omits
`appVersion`/`navidrome` fields, or gate the detailed one behind a
`POUTINE_HEALTH_TOKEN`.

### M10 — Credential policy

- `POUTINE_OWNER_PASSWORD` (boot-time seed) has **no strength validation**.
- User creation requires only 8 chars; no complexity or breach-list (k-anonymity)
  check.
- `example.env` ships `NAVIDROME_PASSWORD=foobarbaz` and
  `POUTINE_OWNER_PASSWORD=local` — fine as examples, but `docker compose up`
  against an unedited copy produces a 5-char owner password on an internet-
  reachable login form (pairs with H5).

**Fix:** minimum 12 chars for the seeded owner password (fail fast otherwise);
optional have-I-been-pwned k-anonymity check on user creation.

### L1 — Error text echoed on owner-gated endpoints

`/admin/instance/scan` (500/502), Sonos 502s, and the federation 502 return
`String(err)` to the caller. The project convention (federation binary error
envelope, `docs/pitfalls.md`) is "never echo upstream errors"; these owner-only
routes violate it. Low risk (owner JWT required) but inconsistent.

### L2 — Cast tokens over a public `lan_url`

Cast tokens are well-built (HMAC-SHA256, single-track, 1 h TTL, constant-time
verify). But if the operator sets `lan_url` to the **public** URL so Sonos works
over the internet, every DIDL document and `/rest/stream.view?castToken=` is
WAN-reachable with a working 1-hour stream credential. Low impact (one track,
one stream), but note it in the Sonos docs.

### L3 — Escape hatches

`POUTINE_ALLOW_PRIVATE_PEER_URLS` (defaults **true** outside production),
`POUTINE_DISABLE_VERSION_CHECK`, `POUTINE_DISABLE_STARTUP_AUTO_SYNC`. Each is
documented, but a prod `.env` carrying a dev-copied `ALLOW_PRIVATE_PEER_URLS=true`
defeats the SSRF guard silently. Consider a boot warning when
`allowPrivatePeerUrls` is true and the port is public-bound.

## Verified strengths

Controls that checked out under review (cite these in the PR thread):

- **No SQL injection.** All queries use prepared statements with bind params.
  The one dynamic query (`getAlbumList2`) assembles fixed WHERE fragments with
  `?` placeholders and picks `ORDER BY` from a hardcoded switch — no user string
  reaches SQL.
- **No XSS sinks.** No `dangerouslySetInnerHTML` in the frontend; React escaping
  throughout; UPnP SOAP XML parsed with `fast-xml-parser` (no external entity
  resolution — no XXE).
- **Constant-time comparison** for every secret check: Subsonic `u+t+s` (with
  length pre-check), stored MD5 passwords, internal secrets, cast tokens.
- **Cast tokens**: per-track, HMAC, 1 h TTL, single-use stream, constant-time.
- **Federation crypto**: Ed25519, provenance-checked invitations, atomic
  nonce consumption, tombstone provenance.
- **SSRF defenses**: peer URLs rejected if private/link-local at handshake and
  re-checked at use; external art fetches strictly allowlisted to fanart.tv and
  last.fm (`external-art.ts`).
- **Proxy auth hygiene**: fresh random salt per request; plaintext `p` explicitly
  rejected on `/proxy/*` (token auth only); Navidrome session cookies stripped
  from proxied responses.
- **Session cookies** httpOnly + SameSite=Lax; short-lived access token (15 min)
  with rotating 7-day refresh.
- **Auth namespaces separated**: hub-admin vs player-admin, unknown → 404;
  player namespace auth-only.
- **Secrets** auto-generated CSPRNG; keyfile 0600; `.gitignore` excludes
  `*.pem`, `.env`, `data/`, `*.data.json`.
- **Per-user isolation** for favorites/play counts; per-hub federation isolation.

## Standards mapping

| OWASP Top 10 (2021)         | Status                                                        |
|-----------------------------|---------------------------------------------------------------|
| A01 Broken Access Control   | Strong overall; gaps: H3 (proxy path), M2 (LAN gate)           |
| A02 Cryptographic Failures  | H1 (no TLS/Secure), M4/M5 (reversible storage, documented), M3 |
| A03 Injection               | **None found** (SQL, XSS, XXE all clean)                       |
| A04 Insecure Design         | M6 (federation trust), M4 (password in browser, inherent)      |
| A05 Security Misconfiguration | H2, M7, M8, M9, L3                                            |
| A06 Vulnerable Components   | H4 (43 advisories)                                            |
| A07 ID & Auth Failures      | H5 (no throttling), M10 (no strength policy), M3              |
| A08 Logging & Monitoring    | M1 (unredacted creds); activity tracking present, good         |
| A09 ICCB                    | n/a (no injection sinks)                                       |

CIS Docker Benchmark: fail 4.x (root), 5.6-style (mutable `:latest` tags);
pass network segmentation (internal), read-only music volume, no privileged
mode.

## Deployment checklist

### Code fixes required before public exposure

1. **H3:** path allowlist in `routes/proxy.ts` + regression test.
2. **H2:** remove or allowlist the CORS config in `server.ts`.
3. **H1:** TLS-behind-proxy flag → `Secure` cookies + HSTS + boot warning.
4. **H4:** bump `undici` ≥7.29, `fast-uri` ≥3.1.6, `@fastify/static` ≥10.1.1,
   `find-my-way` ≥9.7.0 (via fastify bump), `react-router` ≥7.18.2; add
   `pnpm audit --prod` to CI.
5. **H5:** rate-limit `/admin/login`, `/admin/refresh`, `/rest/*`
   (per-IP + per-account lockout).
6. **M1:** pino redaction for credential query params.
7. **M8:** security headers (CSP baseline + nosniff + referrer policy).

Recommended before/alongside: M3 token-type claim, M7 non-root + pinned images,
M2 source-IP-based LAN gate, M10 password strength floor.

### Operator hardening (document in README / `docs/hub-internals.md`)

1. Terminate TLS at the edge (Caddy/Traefik/Cloudflare/Tailscale Funnel); the
   app speaks plain HTTP.
2. Set a strong owner password at seed time (≥12 chars).
3. **Leave DLNA off** on any publicly exposed instance; it is all-or-nothing
   LAN exposure.
4. If using Sonos over the internet, know `lan_url` = public URL ⇒ cast-token
   stream URLs are public (L2).
5. Treat the Docker volume (DB **and** `data/poutine-keyfile`) as a single
   crown-jewel backup; both together = full password compromise (M5).
6. Prefer the bridge-network compose over the host-networking Sonos override on
   any box with a public interface.
7. Pin image tags in local compose overrides.

## References

`docs/authentication.md` (token lifecycle), `docs/federation-api.md` (§8 trust
model), `docs/pitfalls.md` (proxy error-echo rule, DNS rebinding note),
`docs/hub-internals.md` (keyfile, env), `hub/src/auth/*`,
`hub/src/routes/{proxy,dlna,sonos,admin,federation}.ts`,
`hub/src/federation/{signing,peer-auth,url-safety}.ts`,
`hub/src/services/cast-tokens.ts`.