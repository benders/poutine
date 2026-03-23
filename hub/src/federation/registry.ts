import type Database from "better-sqlite3";
import { encrypt, decrypt } from "../auth/encryption.js";

export interface InstanceData {
  name: string;
  url: string;
  username: string;
  password: string;
  ownerId: string;
  adapterType?: string;
}

export interface Instance {
  id: string;
  name: string;
  url: string;
  adapterType: string;
  ownerId: string;
  status: string;
  lastSeen: string | null;
  lastSyncedAt: string | null;
  trackCount: number;
  serverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export function registerInstance(
  db: Database.Database,
  data: InstanceData,
  encryptionKey: string
): Instance {
  const id = crypto.randomUUID();
  const credentials = JSON.stringify({
    username: data.username,
    password: data.password,
  });
  const encryptedCredentials = encrypt(credentials, encryptionKey);

  db.prepare(
    `INSERT INTO instances (id, name, url, adapter_type, encrypted_credentials, owner_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.name,
    data.url,
    data.adapterType || "subsonic",
    encryptedCredentials,
    data.ownerId
  );

  return getInstance(db, id)!;
}

export function listInstances(db: Database.Database): Instance[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, adapter_type, owner_id, status, last_seen,
              last_synced_at, track_count, server_version, created_at, updated_at
       FROM instances`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map(mapRow);
}

export function getInstance(
  db: Database.Database,
  id: string
): Instance | undefined {
  const row = db
    .prepare(
      `SELECT id, name, url, adapter_type, owner_id, status, last_seen,
              last_synced_at, track_count, server_version, created_at, updated_at
       FROM instances WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;

  return row ? mapRow(row) : undefined;
}

export function getInstanceCredentials(
  db: Database.Database,
  id: string,
  encryptionKey: string
): { username: string; password: string } | undefined {
  const row = db
    .prepare("SELECT encrypted_credentials FROM instances WHERE id = ?")
    .get(id) as { encrypted_credentials: string } | undefined;

  if (!row) return undefined;

  const decrypted = decrypt(row.encrypted_credentials, encryptionKey);
  return JSON.parse(decrypted);
}

export function removeInstance(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM instances WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateInstanceStatus(
  db: Database.Database,
  id: string,
  status: string,
  lastSeen?: string
): void {
  if (lastSeen) {
    db.prepare(
      "UPDATE instances SET status = ?, last_seen = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, lastSeen, id);
  } else {
    db.prepare(
      "UPDATE instances SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  }
}

function mapRow(row: Record<string, unknown>): Instance {
  return {
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    adapterType: row.adapter_type as string,
    ownerId: row.owner_id as string,
    status: row.status as string,
    lastSeen: row.last_seen as string | null,
    lastSyncedAt: row.last_synced_at as string | null,
    trackCount: row.track_count as number,
    serverVersion: row.server_version as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
