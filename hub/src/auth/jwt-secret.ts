import { randomBytes } from "node:crypto";
import type { Database } from "better-sqlite3";

const KEY = "jwt_secret";

export function ensureJwtSecret(db: Database): string {
  const existing = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY) as { value: string } | undefined;
  if (existing) return existing.value;

  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    KEY,
    secret,
  );
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY) as { value: string };
  return row.value;
}
