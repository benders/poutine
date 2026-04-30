// SQLite's datetime('now') yields "YYYY-MM-DD HH:MM:SS" in UTC.
// Subsonic clients (and most ISO 8601 consumers) expect "YYYY-MM-DDTHH:MM:SSZ".
// Passes through values that already contain "T" so callers holding either form work.
export function sqliteToIso(ts: string): string {
  return ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
}
