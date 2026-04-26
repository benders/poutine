import os
import urllib.request

import pytest
import libsonic
import libsonic.connection as _lc

# py-sonic bug: when useGET=True, _getRequest() references the Py2-only name
# `urllib2`. Alias it to urllib.request so GET-mode works on Python 3.
_lc.urllib2 = urllib.request


def _env(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise RuntimeError(f"Missing required env var: {name}")
    return val


def _parse_targets() -> list[tuple[str, str]]:
    """Returns list of (label, url). Multi-target via POUTINE_TARGETS:
        "a=http://localhost:3011,b=http://localhost:3012"
    Single-target via POUTINE_URL falls back to label "default".
    """
    raw = os.environ.get("POUTINE_TARGETS")
    if raw:
        out = []
        for chunk in raw.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            label, _, url = chunk.partition("=")
            out.append((label.strip(), url.strip()))
        return out
    return [("default", _env("POUTINE_URL", "http://localhost:3001"))]


def _make_conn(url: str) -> libsonic.Connection:
    user = _env("POUTINE_USER", "admin")
    pwd = _env("POUTINE_PASS", "local")
    if "://" in url:
        scheme, host = url.split("://", 1)
    else:
        scheme, host = "http", url
    if ":" in host:
        host_only, port_s = host.rsplit(":", 1)
        port = int(port_s)
    else:
        host_only, port = host, (443 if scheme == "https" else 80)
    return libsonic.Connection(
        baseUrl=f"{scheme}://{host_only}",
        username=user,
        password=pwd,
        port=port,
        appName="poutine-compat",
        apiVersion="1.16.1",
        legacyAuth=True,  # Poutine does NOT support u+t+s; force u+p
        useGET=True,  # Poutine's Subsonic routes only accept GET (POST → 415)
    )


_TARGETS = _parse_targets()


@pytest.fixture(scope="session", params=_TARGETS, ids=[t[0] for t in _TARGETS])
def conn(request) -> libsonic.Connection:
    _, url = request.param
    return _make_conn(url)
