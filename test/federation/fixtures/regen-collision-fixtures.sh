#!/usr/bin/env bash
# Regenerates the collision-regression fixture mp3s in music-a (issue #118).
#
# All names are fictional test data. Two scenarios are exercised:
#
#   1. Non-MBID release split: "Delta Artist / Split Album" tracks share
#      album+artist but carry differing year tags, so Navidrome buckets them
#      into multiple instance_albums with different track_counts. On `main`
#      these collide on unified_releases.id; the fix folds trackCount into
#      generateReleaseId. Mirrors the real-world Leonard Cohen / Old Ideas
#      failure without using copyrighted metadata.
#
#   2. MBID track on multiple releases: a fake recording MBID is applied to
#      "Echo Track" on both an Echo Single release and on track 5 of "Big
#      Album". On `main` they collide on unified_tracks.id; the fix scopes
#      generateTrackId by releaseId. Mirrors the real-world Chemical Brothers
#      / Setting Sun failure without using copyrighted metadata.
#
# Requires: ffmpeg
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/music-a"

mk() {
  local out="$1"; shift
  mkdir -p "$(dirname "$out")"
  ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=44100:cl=mono -t 2 \
    "$@" -id3v2_version 3 -c:a libmp3lame -b:a 64k -ac 1 "$out"
}

# Scenario 1: same album+artist, no MBID, differing year tags split it
# into two instance_albums (track_counts 2 and 1) on the same release group.
mk "$DIR/Delta Artist/Split Album/01 - Delta One.mp3" \
  -metadata title="Delta One" \
  -metadata artist="Delta Artist" \
  -metadata album_artist="Delta Artist" \
  -metadata album="Split Album" \
  -metadata track=1 -metadata date=2012

mk "$DIR/Delta Artist/Split Album/02 - Delta Two.mp3" \
  -metadata title="Delta Two" \
  -metadata artist="Delta Artist" \
  -metadata album_artist="Delta Artist" \
  -metadata album="Split Album" \
  -metadata track=2 -metadata date=2012

mk "$DIR/Delta Artist/Split Album/03 - Delta Three.mp3" \
  -metadata title="Delta Three" \
  -metadata artist="Delta Artist" \
  -metadata album_artist="Delta Artist" \
  -metadata album="Split Album" \
  -metadata track=3 -metadata date=2013

# Scenario 2: same fake recording MBID on two different releases. The MBID
# is a deterministic UUID4-shaped string with no MusicBrainz lookup behind it.
RECMBID="00000000-0000-4000-8000-000000000118"

mk "$DIR/Epsilon Artist/Echo Single/01 - Echo Track.mp3" \
  -metadata title="Echo Track" \
  -metadata artist="Epsilon Artist" \
  -metadata album_artist="Epsilon Artist" \
  -metadata album="Echo Single" \
  -metadata track=1 \
  -metadata MUSICBRAINZ_TRACKID="$RECMBID"

mk "$DIR/Epsilon Artist/Big Album/05 - Echo Track.mp3" \
  -metadata title="Echo Track" \
  -metadata artist="Epsilon Artist" \
  -metadata album_artist="Epsilon Artist" \
  -metadata album="Big Album" \
  -metadata track=5 \
  -metadata MUSICBRAINZ_TRACKID="$RECMBID"

echo "Regenerated collision fixtures under $DIR"
