"""Subsonic 3rd-party client compatibility tests via py-sonic (libsonic).

Validates a running Poutine instance responds correctly to the Subsonic API
calls that real-world clients (DSub, Symfonium, Substreamer, etc.) issue.
"""
import io
import pytest


def test_ping(conn):
    r = conn.ping()
    assert r is True or (isinstance(r, dict) and r.get("status") == "ok")


def test_get_license(conn):
    r = conn.getLicense()
    lic = r["license"]
    assert lic.get("valid") is True


def test_get_music_folders(conn):
    r = conn.getMusicFolders()
    folders = r["musicFolders"].get("musicFolder", [])
    if isinstance(folders, dict):
        folders = [folders]
    assert len(folders) >= 1
    assert all("id" in f and "name" in f for f in folders)


def test_get_artists(conn):
    r = conn.getArtists()
    indexes = r["artists"].get("index", [])
    if isinstance(indexes, dict):
        indexes = [indexes]
    artists = []
    for idx in indexes:
        a = idx.get("artist", [])
        artists.extend(a if isinstance(a, list) else [a])
    assert len(artists) > 0, "expected at least one artist in library"
    sample = artists[0]
    assert "id" in sample and "name" in sample


def test_get_album_list2_recent(conn):
    r = conn.getAlbumList2(ltype="recent", size=10)
    albums = r["albumList2"].get("album", [])
    if isinstance(albums, dict):
        albums = [albums]
    assert len(albums) > 0


def test_search3(conn):
    r = conn.search3(query="a", artistCount=5, albumCount=5, songCount=5)
    res = r["searchResult3"]
    assert any(k in res for k in ("artist", "album", "song"))


def test_get_album_with_songs(conn):
    r = conn.getAlbumList2(ltype="recent", size=1)
    album_meta = r["albumList2"]["album"]
    if isinstance(album_meta, list):
        album_meta = album_meta[0]
    album_id = album_meta["id"]

    full = conn.getAlbum(id=album_id)["album"]
    songs = full.get("song", [])
    if isinstance(songs, dict):
        songs = [songs]
    assert len(songs) >= 1
    s = songs[0]
    for key in ("id", "title", "duration"):
        assert key in s, f"song missing {key}"


def test_stream_returns_audio_bytes(conn):
    r = conn.getAlbumList2(ltype="recent", size=1)
    album = r["albumList2"]["album"]
    if isinstance(album, list):
        album = album[0]
    full = conn.getAlbum(id=album["id"])["album"]
    songs = full.get("song")
    song = songs[0] if isinstance(songs, list) else songs

    resp = conn.stream(sid=song["id"])
    chunk = resp.read(4096)
    assert len(chunk) > 0, "stream returned no bytes"


def test_get_indexes(conn):
    r = conn.getIndexes()
    idx = r["indexes"]
    assert "lastModified" in idx
    indexes = idx.get("index", [])
    if isinstance(indexes, dict):
        indexes = [indexes]
    artists = []
    for i in indexes:
        a = i.get("artist", [])
        artists.extend(a if isinstance(a, list) else [a])
    assert len(artists) > 0


def test_get_genres(conn):
    r = conn.getGenres()
    genres = r["genres"].get("genre", [])
    if isinstance(genres, dict):
        genres = [genres]
    # Genres list may be empty for tiny test libraries — just verify shape.
    for g in genres:
        assert "value" in g or "name" in g or isinstance(g, str)


def test_get_artist_detail(conn):
    artists_resp = conn.getArtists()["artists"].get("index", [])
    if isinstance(artists_resp, dict):
        artists_resp = [artists_resp]
    flat = []
    for i in artists_resp:
        a = i.get("artist", [])
        flat.extend(a if isinstance(a, list) else [a])
    aid = flat[0]["id"]
    detail = conn.getArtist(id=aid)["artist"]
    assert detail["id"] == aid
    assert "name" in detail


def test_get_song(conn):
    album = conn.getAlbumList2(ltype="recent", size=1)["albumList2"]["album"]
    if isinstance(album, list):
        album = album[0]
    songs = conn.getAlbum(id=album["id"])["album"].get("song", [])
    if isinstance(songs, dict):
        songs = [songs]
    sid = songs[0]["id"]
    s = conn.getSong(id=sid)["song"]
    assert s["id"] == sid
    assert "title" in s


def test_get_artist_info2(conn):
    artists_resp = conn.getArtists()["artists"].get("index", [])
    if isinstance(artists_resp, dict):
        artists_resp = [artists_resp]
    flat = []
    for i in artists_resp:
        a = i.get("artist", [])
        flat.extend(a if isinstance(a, list) else [a])
    aid = flat[0]["id"]
    r = conn.getArtistInfo2(aid=aid)
    assert "artistInfo2" in r


def test_download_returns_audio_bytes(conn):
    album = conn.getAlbumList2(ltype="recent", size=1)["albumList2"]["album"]
    if isinstance(album, list):
        album = album[0]
    songs = conn.getAlbum(id=album["id"])["album"].get("song", [])
    if isinstance(songs, dict):
        songs = [songs]
    resp = conn.download(sid=songs[0]["id"])
    assert len(resp.read(4096)) > 0


def test_get_cover_art(conn):
    album = conn.getAlbumList2(ltype="recent", size=1)["albumList2"]["album"]
    if isinstance(album, list):
        album = album[0]
    cover = album.get("coverArt") or album["id"]
    resp = conn.getCoverArt(aid=cover)
    data = resp.read(16)
    # JPEG/PNG/WebP/GIF magic bytes — accept any image format.
    assert data[:2] == b"\xff\xd8" or data[:8].startswith(b"\x89PNG") \
        or data[:4] == b"RIFF" or data[:3] == b"GIF", f"unexpected cover bytes: {data!r}"


# ── Stub endpoints (return well-formed empty/no-op envelopes) ───────────────


def test_get_now_playing_stub(conn):
    r = conn.getNowPlaying()
    assert "nowPlaying" in r


def test_get_playlists_stub(conn):
    r = conn.getPlaylists()
    assert "playlists" in r


def test_scrobble_stub(conn):
    album = conn.getAlbumList2(ltype="recent", size=1)["albumList2"]["album"]
    if isinstance(album, list):
        album = album[0]
    songs = conn.getAlbum(id=album["id"])["album"].get("song", [])
    if isinstance(songs, dict):
        songs = [songs]
    # Should not raise — stub returns ok envelope.
    conn.scrobble(sid=songs[0]["id"])


def test_playlist_crud_stubs(conn):
    import libsonic.errors as le
    # Stubs may or may not raise; either way the request must reach the server
    # and produce a valid Subsonic envelope (no transport-level error).
    for call in [
        lambda: conn.createPlaylist(name="poutine-compat-test", songIds=[]),
        lambda: conn.getPlaylist(pid="nonexistent"),
        lambda: conn.updatePlaylist(lid="nonexistent", name="x"),
        lambda: conn.deletePlaylist(pid="nonexistent"),
    ]:
        try:
            call()
        except le.SonicError:
            pass  # accepted: stub returned a Subsonic-level error envelope


# ── OpenSubsonic envelope and protocol details ──────────────────────────────


def test_opensubsonic_envelope_fields(conn):
    # libsonic strips the wrapper — drop to urllib for the raw envelope.
    import json
    import urllib.request
    qs = (
        f"u={conn._username}&p={conn._rawPass}&v=1.16.1&c=poutine-compat&f=json"
    )
    url = f"{conn._baseUrl}:{conn._port}/rest/ping?{qs}"
    body = urllib.request.urlopen(url).read()
    env = json.loads(body)["subsonic-response"]
    assert env["status"] == "ok"
    assert env["openSubsonic"] is True
    assert env["type"] == "poutine"
    assert env["version"].startswith("1.16")
    assert "serverVersion" in env


def test_view_suffix_equivalence(conn):
    import json, urllib.request
    qs = f"u={conn._username}&p={conn._rawPass}&v=1.16.1&c=poutine-compat&f=json"
    a = json.loads(urllib.request.urlopen(f"{conn._baseUrl}:{conn._port}/rest/ping?{qs}").read())
    b = json.loads(urllib.request.urlopen(f"{conn._baseUrl}:{conn._port}/rest/ping.view?{qs}").read())
    assert a["subsonic-response"]["status"] == b["subsonic-response"]["status"] == "ok"


def test_xml_format_supported(conn):
    import urllib.request
    qs = f"u={conn._username}&p={conn._rawPass}&v=1.16.1&c=poutine-compat&f=xml"
    body = urllib.request.urlopen(f"{conn._baseUrl}:{conn._port}/rest/ping?{qs}").read()
    assert b"<subsonic-response" in body and b'status="ok"' in body


def test_invalid_password_returns_subsonic_error(conn):
    import libsonic
    bad = libsonic.Connection(
        baseUrl=conn._baseUrl,
        username=conn._username,
        password="not-the-password",
        port=conn._port,
        appName="poutine-compat",
        apiVersion="1.16.1",
        legacyAuth=True,
        useGET=True,
    )
    with pytest.raises(Exception):
        bad.ping()
        bad.getLicense()
