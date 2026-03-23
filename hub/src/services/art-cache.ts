import type Database from "better-sqlite3";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface CacheEntry {
  filePath: string;
  contentType: string;
}

export interface CacheStats {
  currentBytes: number;
  fileCount: number;
  maxBytes: number;
}

export class ArtCache {
  private readonly cacheDir: string;

  constructor(
    private readonly db: Database.Database,
    cacheDir: string,
  ) {
    this.cacheDir = cacheDir;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private filePathForKey(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return join(this.cacheDir, hash);
  }

  get(key: string): CacheEntry | null {
    const row = this.db
      .prepare("SELECT content_type FROM art_cache WHERE id = ?")
      .get(key) as { content_type: string } | undefined;

    if (!row) return null;

    const filePath = this.filePathForKey(key);
    if (!existsSync(filePath)) {
      // DB row exists but file is missing — clean up
      this.db.prepare("DELETE FROM art_cache WHERE id = ?").run(key);
      return null;
    }

    // Update last_accessed
    this.db
      .prepare("UPDATE art_cache SET last_accessed = datetime('now') WHERE id = ?")
      .run(key);

    return { filePath, contentType: row.content_type };
  }

  put(key: string, data: Buffer, contentType: string): void {
    const filePath = this.filePathForKey(key);
    writeFileSync(filePath, data);

    this.db
      .prepare(
        `INSERT INTO art_cache (id, content_type, size, cached_at, last_accessed)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           content_type = excluded.content_type,
           size = excluded.size,
           cached_at = datetime('now'),
           last_accessed = datetime('now')`,
      )
      .run(key, contentType, data.length);

    this.evict();
  }

  evict(): void {
    const maxBytes = this.getMaxBytes();
    const currentBytes = this.getCurrentBytes();

    if (currentBytes <= maxBytes) return;

    // Get entries ordered by least recently accessed
    const entries = this.db
      .prepare("SELECT id, size FROM art_cache ORDER BY last_accessed ASC")
      .all() as Array<{ id: string; size: number }>;

    let freed = 0;
    const target = currentBytes - maxBytes;

    for (const entry of entries) {
      if (freed >= target) break;

      const filePath = this.filePathForKey(entry.id);
      try {
        unlinkSync(filePath);
      } catch {
        // File may already be gone
      }
      this.db.prepare("DELETE FROM art_cache WHERE id = ?").run(entry.id);
      freed += entry.size;
    }
  }

  getStats(): CacheStats {
    return {
      currentBytes: this.getCurrentBytes(),
      fileCount: this.getFileCount(),
      maxBytes: this.getMaxBytes(),
    };
  }

  getMaxBytes(): number {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'art_cache_max_bytes'")
      .get() as { value: string } | undefined;

    return row ? parseInt(row.value, 10) : DEFAULT_MAX_BYTES;
  }

  setMaxBytes(maxBytes: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('art_cache_max_bytes', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(maxBytes));

    this.evict();
  }

  clear(): void {
    const entries = this.db
      .prepare("SELECT id FROM art_cache")
      .all() as Array<{ id: string }>;

    for (const entry of entries) {
      try {
        unlinkSync(this.filePathForKey(entry.id));
      } catch {
        // File may already be gone
      }
    }

    this.db.prepare("DELETE FROM art_cache").run();
  }

  private getCurrentBytes(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(size), 0) as total FROM art_cache")
      .get() as { total: number };
    return row.total;
  }

  private getFileCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM art_cache")
      .get() as { count: number };
    return row.count;
  }
}
