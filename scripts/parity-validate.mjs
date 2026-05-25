#!/usr/bin/env node
// Parity validator: compares Hub + Player web-user behavior between two Poutine instances.
// Usage: scripts/parity-validate.mjs [--config path/to/config.json]
//        defaults to scripts/parity-validate.config.json (gitignored).
//
// Config schema (see parity-validate.config.example.json):
//   {
//     "instances": {
//       "OLD": { "base": "https://...", "username": "...", "password": "..." },
//       "NEW": { "base": "https://...", "username": "...", "password": "..." }
//     },
//     "searchQuery": "love"     // optional, default "love"
//   }
//
// Out of scope by design: DLNA, Sonos. Tests Hub admin + Subsonic browse + streaming.
// Exit code 0 = all parity tests pass. Non-zero = at least one FAIL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  let config = resolve(__dirname, "parity-validate.config.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" || args[i] === "-c") config = resolve(args[++i]);
    else if (args[i] === "-h" || args[i] === "--help") {
      console.log("Usage: parity-validate.mjs [--config path]");
      process.exit(0);
    }
  }
  return { config };
}

const { config: configPath } = parseArgs();
let CFG;
try {
  CFG = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  console.error(`Failed to read config at ${configPath}: ${e.message}`);
  console.error(`Copy parity-validate.config.example.json to parity-validate.config.json and fill in creds.`);
  process.exit(2);
}

const INSTANCES = [];
for (const name of ["OLD", "NEW"]) {
  const i = CFG.instances?.[name];
  if (!i?.base || !i?.username || !i?.password) {
    console.error(`Config missing instances.${name}.{base,username,password}`);
    process.exit(2);
  }
  INSTANCES.push({ name, base: i.base.replace(/\/$/, ""), u: i.username, p: i.password });
}
const SEARCH_QUERY = CFG.searchQuery || "love";

const results = [];
const sessions = {};

async function jreq(inst, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (sessions[inst.name] && !opts.noAuth) headers.authorization = "Bearer " + sessions[inst.name];
  const r = await fetch(inst.base + path, { ...opts, headers, redirect: "manual" });
  const ctype = r.headers.get("content-type") || "";
  let body;
  try {
    body = ctype.includes("json") ? await r.json() : await r.text();
  } catch { body = null; }
  return { status: r.status, ctype, body };
}

const rec = (id, label, oldRes, newRes) => results.push({ id, label, OLD: oldRes, NEW: newRes });
const pass = (cond, msg = "ok") => cond ? "PASS " + msg : "FAIL " + msg;
const isJson = (r) => r.ctype.includes("json");
const isApiMissing = (r) =>
  (r.status === 404) || (r.status === 200 && r.ctype.includes("html"));

// A. AUTH
for (const inst of INSTANCES) {
  const r = await fetch(inst.base + "/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: inst.u, password: inst.p }),
  });
  let j;
  try { j = await r.json(); } catch { j = {}; }
  sessions[inst.name] = j.accessToken;
  inst.subsonic = j.subsonicCredentials;
  inst.username = j.user?.username;
  inst.loginOk = r.status === 200 && !!j.accessToken && j.user?.isAdmin === true && !!j.subsonicCredentials?.username;
}
rec("A1", "POST /admin/login",
  pass(INSTANCES[0].loginOk, `user=${INSTANCES[0].username} subsonic=${INSTANCES[0].subsonic?.username}`),
  pass(INSTANCES[1].loginOk, `user=${INSTANCES[1].username} subsonic=${INSTANCES[1].subsonic?.username}`));

{
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, "/admin/me")));
  rec("A2", "GET /admin/me",
    pass(o.status === 200 && o.body?.username === INSTANCES[0].username, `${o.status}`),
    pass(n.status === 200 && n.body?.username === INSTANCES[1].username, `${n.status}`));
}

// B. HUB ADMIN
{
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, "/admin/instance")));
  const oKeys = isJson(o) ? Object.keys(o.body).sort().join(",") : "";
  const nKeys = isJson(n) ? Object.keys(n.body).sort().join(",") : "";
  rec("B1", "GET /admin/instance",
    pass(o.status === 200 && isJson(o), `${o.status} keys=${oKeys.split(",").length}`),
    pass(n.status === 200 && isJson(n), `${n.status} keys=${nKeys.split(",").length}`));
  rec("B1b", "  shape parity (admin/instance)",
    oKeys === nKeys ? "PASS identical" : `DIFF`,
    oKeys === nKeys ? "PASS identical" : `DIFF`);
}

{
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, "/api/admin/hub/instance")));
  rec("B2", "GET /api/admin/hub/instance (additive)",
    isApiMissing(o) ? "NEW-ONLY (missing on OLD, expected)" : pass(false, `unexpected OLD ${o.status}`),
    pass(n.status === 200 && isJson(n), `${n.status}`));
}

for (const [id, label, path] of [
  ["B3", "GET /admin/users", "/admin/users"],
  ["B4", "GET /admin/peers", "/admin/peers"],
  ["B5", "GET /admin/activity/history?limit=5", "/admin/activity/history?limit=5"],
]) {
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, path)));
  rec(id, label,
    pass(o.status === 200 && isJson(o), `${o.status}${Array.isArray(o.body) ? ` n=${o.body.length}` : ""}`),
    pass(n.status === 200 && isJson(n), `${n.status}${Array.isArray(n.body) ? ` n=${n.body.length}` : ""}`));
}

// C. SUBSONIC LIBRARY BROWSE (uses subsonicCredentials from login)
const ssAuth = (i) => `u=${encodeURIComponent(i.subsonic.username)}&p=${encodeURIComponent(i.subsonic.password)}&f=json&v=1.16.0&c=parity`;
const ssGet = (i, ep, extra = "") => fetch(i.base + `/rest/${ep}?${ssAuth(i)}${extra ? "&" + extra : ""}`).then(async r => ({
  status: r.status, ctype: r.headers.get("content-type") || "", body: await r.json().catch(() => null),
}));
const ssOk = (b) => b?.["subsonic-response"]?.status === "ok";

{
  const [o, n] = await Promise.all(INSTANCES.map(i => ssGet(i, "getMusicFolders")));
  const folders = (b) => b?.["subsonic-response"]?.musicFolders?.musicFolder || [];
  rec("C1", "Subsonic getMusicFolders",
    pass(ssOk(o.body), `folders=${folders(o.body).length}`),
    pass(ssOk(n.body), `folders=${folders(n.body).length}`));
}
{
  const [o, n] = await Promise.all(INSTANCES.map(i => ssGet(i, "getArtists")));
  const count = (b) => (b?.["subsonic-response"]?.artists?.index || []).reduce((s, e) => s + (e.artist?.length || 0), 0);
  rec("C2", "Subsonic getArtists",
    pass(ssOk(o.body) && count(o.body) > 0, `artists=${count(o.body)}`),
    pass(ssOk(n.body) && count(n.body) > 0, `artists=${count(n.body)}`));
}

const sampleAlbum = {}, sampleSong = {}, sampleSong2 = {};
{
  const [o, n] = await Promise.all(INSTANCES.map(i => ssGet(i, "getAlbumList2", "type=alphabeticalByName&size=20")));
  const albums = (b) => b?.["subsonic-response"]?.albumList2?.album || [];
  sampleAlbum.OLD = albums(o.body)[0]?.id;
  sampleAlbum.NEW = albums(n.body)[0]?.id;
  rec("C3", "Subsonic getAlbumList2",
    pass(ssOk(o.body) && albums(o.body).length > 0, `n=${albums(o.body).length}`),
    pass(ssOk(n.body) && albums(n.body).length > 0, `n=${albums(n.body).length}`));
}
{
  const fetch1 = (i, id) => id ? ssGet(i, "getAlbum", `id=${encodeURIComponent(id)}`) : Promise.resolve({ status: 0, body: null });
  const [o, n] = await Promise.all([fetch1(INSTANCES[0], sampleAlbum.OLD), fetch1(INSTANCES[1], sampleAlbum.NEW)]);
  const songs = (b) => b?.["subsonic-response"]?.album?.song || [];
  sampleSong.OLD = songs(o.body)[0]?.id;
  sampleSong.NEW = songs(n.body)[0]?.id;
  sampleSong2.OLD = songs(o.body)[1]?.id || sampleSong.OLD;
  sampleSong2.NEW = songs(n.body)[1]?.id || sampleSong.NEW;
  rec("C4", "Subsonic getAlbum",
    pass(ssOk(o.body) && songs(o.body).length > 0, `songs=${songs(o.body).length}`),
    pass(ssOk(n.body) && songs(n.body).length > 0, `songs=${songs(n.body).length}`));
}
{
  const fetch1 = (i, id) => id ? ssGet(i, "getSong", `id=${encodeURIComponent(id)}`) : Promise.resolve({ status: 0, body: null });
  const [o, n] = await Promise.all([fetch1(INSTANCES[0], sampleSong.OLD), fetch1(INSTANCES[1], sampleSong.NEW)]);
  rec("C5", "Subsonic getSong",
    pass(ssOk(o.body) && o.body["subsonic-response"].song?.id === sampleSong.OLD, `id=${sampleSong.OLD}`),
    pass(ssOk(n.body) && n.body["subsonic-response"].song?.id === sampleSong.NEW, `id=${sampleSong.NEW}`));
}
{
  const [o, n] = await Promise.all(INSTANCES.map(i => ssGet(i, "search3", `query=${encodeURIComponent(SEARCH_QUERY)}`)));
  const hits = (b) => {
    const r = b?.["subsonic-response"]?.searchResult3 || {};
    return (r.artist?.length || 0) + (r.album?.length || 0) + (r.song?.length || 0);
  };
  rec("C6", `Subsonic search3 q=${SEARCH_QUERY}`,
    pass(ssOk(o.body) && hits(o.body) > 0, `hits=${hits(o.body)}`),
    pass(ssOk(n.body) && hits(n.body) > 0, `hits=${hits(n.body)}`));
}

// D. STREAMING (must work — Phase 4 #218 rewrote this path)
async function streamTest(i, songId) {
  if (!songId) return { status: 0 };
  const r = await fetch(i.base + `/rest/stream?id=${encodeURIComponent(songId)}&u=${encodeURIComponent(i.subsonic.username)}&p=${encodeURIComponent(i.subsonic.password)}&v=1.16.0&c=parity`, {
    headers: { range: "bytes=0-65535" }, redirect: "manual",
  });
  const ctype = r.headers.get("content-type") || "";
  let bytes = 0;
  try { bytes = (await r.arrayBuffer()).byteLength; } catch {}
  return { status: r.status, ctype, bytes };
}
const okStream = (r) => (r.status === 206 || r.status === 200) && /^audio\//i.test(r.ctype) && r.bytes > 0;

{
  const [o, n] = await Promise.all([streamTest(INSTANCES[0], sampleSong.OLD), streamTest(INSTANCES[1], sampleSong.NEW)]);
  rec("D1", "GET /rest/stream song1 (range 0-65535)",
    pass(okStream(o), `${o.status} ${o.ctype} bytes=${o.bytes}`),
    pass(okStream(n), `${n.status} ${n.ctype} bytes=${n.bytes}`));
}
{
  const [o, n] = await Promise.all([streamTest(INSTANCES[0], sampleSong2.OLD), streamTest(INSTANCES[1], sampleSong2.NEW)]);
  rec("D2", "GET /rest/stream song2 (range 0-65535)",
    pass(okStream(o), `${o.status} ${o.ctype} bytes=${o.bytes}`),
    pass(okStream(n), `${n.status} ${n.ctype} bytes=${n.bytes}`));
}

// E. PLAYER HEALTH (additive)
{
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, "/player/health")));
  rec("E1", "GET /player/health (additive)",
    isApiMissing(o) ? "NEW-ONLY (missing on OLD, expected)" : pass(false, `unexpected OLD ${o.status} ${o.ctype}`),
    pass(n.status === 200 && isJson(n) && n.body?.status === "ok", `${n.status}`));
}

// F. PLAYER ADMIN NAMESPACE (additive)
{
  const [o, n] = await Promise.all(INSTANCES.map(i => jreq(i, "/api/admin/player/settings/sonos")));
  rec("F1", "GET /api/admin/player/settings/sonos (additive)",
    isApiMissing(o) ? "NEW-ONLY (missing on OLD, expected)" : pass(false, `unexpected OLD ${o.status} ${o.ctype}`),
    pass(n.status === 200 && isJson(n), `${n.status}`));
}

// REPORT
const pad = (s, n) => (String(s) + " ".repeat(n)).slice(0, n);
console.log(pad("ID", 5), pad("Test", 48), pad("OLD", 50), "NEW");
console.log("-".repeat(155));
for (const r of results) console.log(pad(r.id, 5), pad(r.label, 48), pad(r.OLD, 50), r.NEW);
const FAILS = results.filter(r => /FAIL/.test(r.OLD) || /FAIL/.test(r.NEW));
console.log(`\nTOTAL=${results.length}  FAIL=${FAILS.length}`);
if (FAILS.length) {
  console.log("\nFailures:");
  for (const r of FAILS) console.log(`  ${r.id} ${r.label}\n    OLD: ${r.OLD}\n    NEW: ${r.NEW}`);
}
process.exit(FAILS.length ? 1 : 0);
