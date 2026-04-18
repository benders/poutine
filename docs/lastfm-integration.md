# Last.fm Artist Image Integration

## Overview

This feature enables automatic fetching of artist images from Last.fm during library sync and on-demand via the `/rest/getArtistInfo2` endpoint.

## Setup

### 1. Get a Last.fm API Key

1. Go to https://www.last.fm/api/account/create
2. Fill in the form:
   - **Application name**: `poutine` (or any name you prefer)
   - **Application description**: `Music library management with artist images`
   - **Callback URL**: `http://localhost:3000` (or your actual domain)
3. Click **Submit**
4. Copy your **API key** and **Shared secret**

### 2. Configure poutine

Set the `LASTFM_API_KEY` environment variable when starting the hub:

```bash
# Option 1: Environment variable
export LASTFM_API_KEY="***"
cd ~/poutine/hub
npm run dev

# Option 2: .env file
# Create a .env file in ~/poutine/hub/ with:
# LASTFM_API_KEY=***
```

### 3. Verify Integration

After starting the server, check the logs:

```
Last.fm integration enabled — artist images will be fetched from Last.fm
```

If disabled:

```
Last.fm integration disabled — set LASTFM_API_KEY env var to enable
```

## How It Works

### During Sync

When you trigger a sync via `/admin/sync`:

1. For each artist, poutine first tries to get the image from Navidrome's `getArtist()` response
2. If no image is found and Last.fm is enabled:
   - Fetches artist info from Last.fm using the artist name
   - Falls back to MusicBrainz ID if available (more accurate)
   - Caches the best available image URL in `unified_artists.image_url`

### On-Demand via API

When a client calls `/rest/getArtistInfo2`:

1. Checks if the artist already has a cached image URL
2. If not and Last.fm is enabled:
   - Fetches from Last.fm
   - Caches the result
   - Returns the image URL

### Image Priority

Last.fm returns images in multiple sizes. poutine prefers:

1. `extralarge` (500x500)
2. `large` (300x300)
3. `medium` (100x100)
4. `small` (64x64)

## Backfilling Existing Artists

To fetch images for artists that were already synced before enabling Last.fm:

1. Enable Last.fm by setting `LASTFM_API_KEY`
2. Restart the hub server
3. Trigger a full sync:

```bash
curl -X POST http://localhost:3000/admin/sync \
  -H "Authorization: Bearer ***
```

Or access artists via the frontend - the first time an artist page is viewed, it will trigger a Last.fm lookup if no image is cached.

## Rate Limiting

Last.fm has generous rate limits for API key usage. The integration includes basic error handling:

- Failed Last.fm requests are logged but don't break sync
- Artists without images will have `null` image URLs (graceful degradation)
- If Last.fm is unreachable, sync continues with available data

## Data Storage

Artist images are stored in:

- `unified_artists.image_url` - The unified artist table
- `instance_artists.image_url` - Per-instance artist data

Images are cached after the first fetch, so subsequent syncs don't re-fetch from Last.fm.

## Troubleshooting

### No Images Being Fetched

1. Verify `LASTFM_API_KEY` is set:
   ```bash
   echo $LASTFM_API_KEY
   ```

2. Check server logs for:
   ```
   Last.fm integration enabled
   ```

3. Test Last.fm API directly:
   ```bash
   curl "https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&api_key=YOUR_KEY&artist=Radiohead&format=json"
   ```

### "Artist Not Found" Errors

Last.fm may not have data for all artists. The integration handles this gracefully - artists without Last.fm entries will simply have no images.

### Images Not Showing in Frontend

1. Verify images are in the database:
   ```bash
   sqlite3 ~/poutine/hub/data/poutine.db \
     "SELECT name, image_url FROM unified_artists WHERE image_url IS NOT NULL LIMIT 5;"
   ```

2. Check that the frontend is correctly requesting artist info via `/rest/getArtistInfo2`

## API Reference

### `LastFmClient` Class

Located in `hub/src/services/lastfm.ts`

#### Methods

- `isEnabled(): boolean` - Check if Last.fm is configured
- `getArtistInfo(artistName, musicBrainzId?): Promise<LastFmArtistResponse | null>` - Fetch artist info
- `extractImages(artistInfo): Object` - Extract image URLs from response
- `getBestImage(artistInfo): string | null` - Get the largest available image

## Future Enhancements

Potential improvements:

- Artist biography caching
- Similar artists from Last.fm
- Album art from Last.fm (currently uses Navidrome's cover art)
- Configurable image size preference
- Image proxy/caching to avoid hotlinking
