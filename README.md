# poutine

A federated music player that merges multiple personal music libraries into a single unified collection. Each participant runs a [Navidrome](https://www.navidrome.org/) instance on their own hardware, and a central hub aggregates them into one browsable, searchable, and playable library through a web interface.

Built for small groups (4–12 people) who want to share and listen to each other's music without giving up ownership of their collections.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Web Frontend (React / Vite / Tailwind)       │
├──────────────────────────────────────────────┤
│  Poutine Hub (Fastify / SQLite)               │
│  ┌──────────┬────────┬────────┬───────────┐  │
│  │Federation│Metadata│ Stream │   Auth     │  │
│  │ Manager  │ Merger │ Proxy  │  Service   │  │
│  └──────────┴────────┴────────┴───────────┘  │
├──────────────────────────────────────────────┤
│  Navidrome Instances (Subsonic API)           │
│  ┌──────┐ ┌──────┐ ┌──────┐     ┌──────┐   │
│  │ NAS  │ │ RPi  │ │ Mini │ ... │ NAS  │   │
│  └──────┘ └──────┘ └──────┘     └──────┘   │
└──────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the hub (port 3000)
pnpm dev

# Start the frontend (port 5173, proxies API to hub)
cd frontend && pnpm dev
```

1. Open `http://localhost:5173` and register an account (all users have admin access)
2. Go to **Instances** in the sidebar and add a Navidrome server (URL, username, password)
3. Click **Sync** to pull the library
4. Browse, search, and play music from the **Library** page

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Hub API | TypeScript, Fastify, better-sqlite3 |
| Frontend | React 19, Vite, Tailwind CSS, Zustand, TanStack Query |
| Auth | Argon2id password hashing, JWT (jose) |
| Instance protocol | Subsonic/OpenSubsonic API |
| Audio | Server-side transcoding via Navidrome/FFmpeg, proxied through hub |

## Project Structure

```
poutine/
├── hub/                      # API server
│   ├── src/
│   │   ├── adapters/         # Subsonic API client
│   │   ├── auth/             # Passwords, JWT, encryption, middleware
│   │   ├── db/               # SQLite schema and client
│   │   ├── federation/       # Instance registry, health checks
│   │   ├── library/          # Sync engine, merge algorithm, normalization
│   │   ├── routes/           # Auth, instances, library, stream, queue
│   │   ├── config.ts
│   │   └── server.ts
│   └── test/                 # Unit and integration tests
├── frontend/                 # React SPA
│   └── src/
│       ├── components/       # Layout, player bar
│       ├── pages/            # Library, artists, albums, search, admin
│       ├── stores/           # Auth and player state (Zustand)
│       └── lib/              # API client, utilities
└── docs/                     # Architecture decisions and implementation plan
```

## How It Works

- **Sync**: The hub fetches each instance's full library via the Subsonic API (`getArtists` → `getArtist` → `getAlbum`) and stores raw metadata in SQLite.
- **Merge**: A merge algorithm deduplicates across instances using MusicBrainz IDs (preferred) or fuzzy matching on normalized names + duration.
- **Stream**: When you play a track, the hub selects the best source (online, matching format, highest quality) and proxies the audio stream from the originating Navidrome instance.
- **Transcode**: Transcoding (FLAC → MP3/Opus/AAC) happens on the Navidrome instance, not the hub.
