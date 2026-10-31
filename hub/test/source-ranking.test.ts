import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  SOURCE_RANK_ORDER_BY,
  compareSources,
  formatRank,
  type RankableSource,
} from "../src/library/source-ranking.js";

// The Step 5 ORDER BY as merge.ts hard-coded it before #241 — the refactor
// onto SOURCE_RANK_ORDER_BY must not change merge output.
const LEGACY_ORDER_BY = `
  CASE LOWER(COALESCE(ts.format, ''))
    WHEN 'flac' THEN 100
    WHEN 'wav'  THEN 90
    WHEN 'alac' THEN 85
    WHEN 'opus' THEN 70
    WHEN 'aac'  THEN 60
    WHEN 'mp3'  THEN 50
    WHEN 'ogg'  THEN 45
    ELSE 30
  END DESC,
  COALESCE(ts.bitrate, 0) DESC,
  CASE WHEN ts.instance_id = 'local' THEN 1 ELSE 0 END DESC,
  ts.id ASC`;

const FORMATS = ["flac", "FLAC", "wav", "alac", "opus", "aac", "mp3", "ogg", "wma", "", null];
const BITRATES = [null, 0, 128, 320, 320, 1000];
const INSTANCES = ["local", "peer-a", "peer-b"];

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function randomSources(n: number, seed: number): RankableSource[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: n }, (_, i) => ({
    id: `src-${String(Math.floor(r() * 1e6)).padStart(6, "0")}-${i}`,
    instance_id: pick(INSTANCES),
    format: pick(FORMATS),
    bitrate: pick(BITRATES),
  }));
}

describe("source ranking (#241)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE track_sources (id TEXT PRIMARY KEY, instance_id TEXT, format TEXT, bitrate INTEGER)");
  });

  function load(rows: RankableSource[]): void {
    const ins = db.prepare("INSERT INTO track_sources VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(r.id, r.instance_id, r.format, r.bitrate);
  }

  function sqlOrder(orderBy: string): string[] {
    return (db.prepare(`SELECT ts.id FROM track_sources ts ORDER BY ${orderBy}`).all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  for (const seed of [1, 2, 3, 42, 1337]) {
    it(`SQL fragment, legacy merge SQL and comparator agree (seed ${seed})`, () => {
      const rows = randomSources(60, seed);
      load(rows);
      const viaComparator = [...rows].sort(compareSources).map((r) => r.id);
      expect(sqlOrder(SOURCE_RANK_ORDER_BY)).toEqual(viaComparator);
      expect(sqlOrder(LEGACY_ORDER_BY)).toEqual(viaComparator);
    });
  }

  it("orders format before bitrate", () => {
    const flacLow = { id: "a", instance_id: "peer-a", format: "flac", bitrate: 100 };
    const mp3High = { id: "b", instance_id: "local", format: "mp3", bitrate: 320 };
    expect([mp3High, flacLow].sort(compareSources)[0]).toBe(flacLow);
  });

  it("breaks a format + bitrate tie in favour of local", () => {
    const peer = { id: "a", instance_id: "peer-a", format: "mp3", bitrate: 320 };
    const local = { id: "b", instance_id: "local", format: "mp3", bitrate: 320 };
    expect([peer, local].sort(compareSources)[0]).toBe(local);
  });

  it("is case-insensitive and ranks unknown/null formats lowest", () => {
    expect(formatRank("FLAC")).toBe(formatRank("flac"));
    expect(formatRank(null)).toBe(formatRank("wma"));
    expect(formatRank("wma")).toBeLessThan(formatRank("ogg"));
  });
});
