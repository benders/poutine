# Migrating an instance to another machine

How to relocate a running Poutine instance (hub + bundled Navidrome) to a new
host with zero identity loss. Applies to any instance; multiple instances share
one `docker-compose.yml` and are distinguished only by **project name** +
**env file**.

## What defines an instance

Two instances run on this machine from the same compose file:

| Field              | `poutine`                    | `the-scene`                       |
|--------------------|------------------------------|-----------------------------------|
| Launch             | `-p poutine` (default `.env`)| `-p the-scene --env-file the-scene.env` |
| Host port          | `3000`                       | `26505`                           |
| `POUTINE_INSTANCE_ID` | `music-west.slackworks.com` | `the-scene.slackworks.com`      |
| Music (host, ro)   | `/Volumes/BigWolf/Music`     | `/Volumes/BigWolf/The Scene`      |
| Sonos/DLNA         | on (LAN `mini-m`)            | off                               |
| Volumes            | `poutine_hub-data`, `poutine_navidrome-data` | `the-scene_hub-data`, `the-scene_navidrome-data` |

The project name (`-p`) prefixes the volume names. **Keep it identical on the
destination or the restored volumes won't be found.**

## What has to move

All durable state is in **two named Docker volumes** plus the **music files** and
the **env file**. Nothing lives in the git checkout.

### `<project>_hub-data` → `/app/data` (critical)

| File                    | Contents                          | If lost                                    |
|-------------------------|-----------------------------------|--------------------------------------------|
| `poutine.db` (+wal/shm) | Users, catalog, activity, invites, peer list | Everything hub-side gone           |
| `player.db`             | Sonos/DLNA player settings        | Player config reset                        |
| `poutine_ed25519.pem`   | **Federation identity private key** | Peers no longer trust this instance      |
| `poutine_password_key`  | **Key encrypting stored credentials** | Every stored user + Subsonic password unrecoverable |
| `cache/`                | Album/artist art cache            | Regenerated on demand (safe to drop)       |

### `<project>_navidrome-data` → `/data`

`navidrome.db` (scan state, playlists, annotations) + artwork cache.
Regenerable via a full library rescan, but copying it skips that.

### Music library

Lives on the host external drive, mounted read-only at `/music`. Must be present
at the destination — move the drive, or copy the files and update
`NAVIDROME_MUSIC_PATH` in the env file.

### Config files

`docker-compose.yml`, the instance's env file (`.env` or `the-scene.env`), and
`docker-compose.sonos.yml` **only if** using host-network Sonos.

## Procedure

Worked example uses `the-scene`; substitute the project name and env file for the
other instance.

### 1. Source machine — snapshot

```bash
cd /path/to/poutine

# Stop containers, keep volumes.
docker compose -p the-scene --env-file the-scene.env down

# Tar both volumes. WAL is flushed cleanly because containers are stopped.
docker run --rm -v the-scene_hub-data:/d -v "$PWD":/out alpine \
  tar czf /out/the-scene_hub-data.tgz -C /d .
docker run --rm -v the-scene_navidrome-data:/d -v "$PWD":/out alpine \
  tar czf /out/the-scene_navidrome-data.tgz -C /d .
```

Copy to the destination: both `.tgz`, `docker-compose.yml`, the env file (and
`docker-compose.sonos.yml` if used), plus the music files/drive.

### 2. Destination machine — restore

Docker + compose installed; music available at a known path.

```bash
cd /path/to/poutine   # compose file + env file placed here

# Volume names MUST match "<project>_<volume>".
docker volume create the-scene_hub-data
docker volume create the-scene_navidrome-data

docker run --rm -v the-scene_hub-data:/d -v "$PWD":/in alpine \
  tar xzf /in/the-scene_hub-data.tgz -C /d
docker run --rm -v the-scene_navidrome-data:/d -v "$PWD":/in alpine \
  tar xzf /in/the-scene_navidrome-data.tgz -C /d
```

Edit the env file if paths changed:
- `NAVIDROME_MUSIC_PATH` — point at the music location on this host.
- **Do not** change `POUTINE_INSTANCE_ID` — it is the federation identity.

```bash
docker compose -p the-scene --env-file the-scene.env up -d
```

The `ghcr.io/benders/poutine:latest` image pulls fresh — no image export needed,
assuming the host can reach ghcr.io.

### 3. Re-point external access

TLS / public exposure is outside compose (reverse proxy, Cloudflare Tunnel,
Tailscale, etc.). **Keep the same public URL** — point the existing hostname at
the new host. Federation trust survives the move via the ed25519 key, but peers
store this instance's URL in their own `instances` table (admitted via signed
handshake — there is no peer config file to edit; see `docs/federation-api.md`).
If the URL must change, peers will keep addressing the old one until it is
propagated, which in practice means re-admitting via the invitation flow.

## Gotchas

- **One authoritative host.** Never run the same instance ID + key on two
  machines at once. Stop the source before starting the destination.
- **Keep `poutine_password_key`.** It travels inside `hub-data`, so a volume copy
  carries it — but a hand-rebuilt volume that omits it makes every stored password
  unrecoverable. See README → *Upgrading to 0.4.0*.
- **Keep `poutine_ed25519.pem`.** Regenerating orphans all peer trust.
- **Volume name = `<project>_<volume>`.** Renaming the project without renaming
  the volumes breaks the restore.
- **Music path is read-only and host-specific.** A missing `/music` mount lets the
  hub boot but Navidrome finds an empty library.

## Related

- `README.md` → *Operations* — update/restart/reset a live instance.
- `docs/federation-api.md` — peer identity and the signed-request contract.
- `docs/authentication.md` — stored-credential encryption and the password key.
