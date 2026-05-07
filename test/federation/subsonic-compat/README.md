# Subsonic client compatibility harness

Automated 3rd-party Subsonic client compatibility tests against a live Poutine
instance. Uses [py-sonic](https://github.com/crustymonkey/py-sonic) (`libsonic`)
— a Python wrapper that maps every Subsonic endpoint to a method and returns
parsed dicts, so the agent can assert on response shape without parsing XML/JSON
by hand.

## Run

```sh
./run.sh                 # uses defaults: http://localhost:3001 / nic / local
POUTINE_URL=http://localhost:3000 POUTINE_USER=alice POUTINE_PASS=hunter2 ./run.sh
./run.sh -k stream       # pass-through to pytest
```

First run creates `.venv/` and installs deps. Subsequent runs reuse it.

## What it covers

`ping`, `getLicense`, `getMusicFolders`, `getArtists`, `getAlbumList2`,
`search3`, `getAlbum` (with song detail), `stream` (verifies audio bytes
returned), and an invalid-password negative test.

## Notes

- Forces `legacyAuth=True` (u+p). Poutine does not support `u+t+s` MD5 token
  auth — see `docs/opensubsonic.md`.
- Targets the running instance directly. Does not reset the DB.
- Test library must be non-empty (at least one artist/album/song).
