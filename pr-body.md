## Summary
Implements issue #10 - Display per-track metadata on the Album detail page including:
- Source instance (local vs which peer)
- Audio format (flac/mp3/opus/etc)
- Bitrate

## Changes
- **Backend** (`hub/src/routes/subsonic.ts`): Added `instance_name` to track queries in `/getAlbum`, `/getSong`, and `/search3` routes. Updated `buildSong` to include `sourceInstance`.
- **Frontend types** (`frontend/src/lib/subsonic.ts`): Added `suffix` and `sourceInstance` to `SubsonicSong` and `RawSong` interfaces.
- **Frontend UI** (`frontend/src/pages/ReleaseGroupPage.tsx`): Added Format, Bitrate, and Source columns to the track list table.

## Implementation Details
- Format displayed in uppercase (e.g., FLAC, MP3)
- Bitrate shown with 'kbps' suffix (e.g., 320 kbps)
- Source instance name displayed as-is (e.g., 'Local Navidrome', 'poutine-b')
- Best source shown when multiple sources exist (highest bitrate)
- Consistent with the PlayerBar implementation from #2

Closes #10
