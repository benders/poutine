import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../src/db/client.js";
import {
  registerInstance,
  listInstances,
  getInstance,
  removeInstance,
  updateInstanceStatus,
  getInstanceCredentials,
} from "../src/federation/registry.js";

describe("Instance registry", () => {
  let db: Database.Database;
  const encryptionKey = "test-encryption-key";
  let ownerId: string;

  beforeEach(() => {
    db = createDatabase(":memory:");
    // Insert a user to serve as instance owner
    ownerId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, ?)"
    ).run(ownerId, "admin", "fakehash", 1);
  });

  afterEach(() => {
    db.close();
  });

  it("should register a new instance", () => {
    const instance = registerInstance(
      db,
      {
        name: "Test Instance",
        url: "https://music.example.com",
        username: "admin",
        password: "secret123",
        ownerId,
      },
      encryptionKey
    );

    expect(instance.id).toBeTruthy();
    expect(instance.name).toBe("Test Instance");
    expect(instance.url).toBe("https://music.example.com");
    expect(instance.status).toBe("offline");
    expect(instance.adapterType).toBe("subsonic");
  });

  it("should list all instances", () => {
    registerInstance(
      db,
      {
        name: "Instance 1",
        url: "https://music1.example.com",
        username: "user1",
        password: "pass1",
        ownerId,
      },
      encryptionKey
    );

    registerInstance(
      db,
      {
        name: "Instance 2",
        url: "https://music2.example.com",
        username: "user2",
        password: "pass2",
        ownerId,
      },
      encryptionKey
    );

    const instances = listInstances(db);
    expect(instances).toHaveLength(2);
    expect(instances[0].name).toBe("Instance 1");
    expect(instances[1].name).toBe("Instance 2");
  });

  it("should get a single instance by ID", () => {
    const created = registerInstance(
      db,
      {
        name: "My Instance",
        url: "https://music.example.com",
        username: "admin",
        password: "secret",
        ownerId,
      },
      encryptionKey
    );

    const fetched = getInstance(db, created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("My Instance");
    expect(fetched!.id).toBe(created.id);
  });

  it("should return undefined for nonexistent instance", () => {
    const fetched = getInstance(db, "nonexistent-id");
    expect(fetched).toBeUndefined();
  });

  it("should remove an instance", () => {
    const created = registerInstance(
      db,
      {
        name: "To Delete",
        url: "https://delete.example.com",
        username: "admin",
        password: "secret",
        ownerId,
      },
      encryptionKey
    );

    const removed = removeInstance(db, created.id);
    expect(removed).toBe(true);

    const fetched = getInstance(db, created.id);
    expect(fetched).toBeUndefined();
  });

  it("should return false when removing nonexistent instance", () => {
    const removed = removeInstance(db, "nonexistent-id");
    expect(removed).toBe(false);
  });

  it("should update instance status", () => {
    const created = registerInstance(
      db,
      {
        name: "Status Test",
        url: "https://status.example.com",
        username: "admin",
        password: "secret",
        ownerId,
      },
      encryptionKey
    );

    expect(created.status).toBe("offline");

    const now = new Date().toISOString();
    updateInstanceStatus(db, created.id, "online", now);

    const updated = getInstance(db, created.id);
    expect(updated!.status).toBe("online");
    expect(updated!.lastSeen).toBe(now);
  });

  it("should update status without lastSeen", () => {
    const created = registerInstance(
      db,
      {
        name: "Status Test 2",
        url: "https://status2.example.com",
        username: "admin",
        password: "secret",
        ownerId,
      },
      encryptionKey
    );

    updateInstanceStatus(db, created.id, "degraded");

    const updated = getInstance(db, created.id);
    expect(updated!.status).toBe("degraded");
  });

  it("should store and retrieve encrypted credentials", () => {
    const created = registerInstance(
      db,
      {
        name: "Creds Test",
        url: "https://creds.example.com",
        username: "myuser",
        password: "mypassword",
        ownerId,
      },
      encryptionKey
    );

    const creds = getInstanceCredentials(db, created.id, encryptionKey);
    expect(creds).toBeDefined();
    expect(creds!.username).toBe("myuser");
    expect(creds!.password).toBe("mypassword");
  });

  it("should not expose credentials in list or get", () => {
    registerInstance(
      db,
      {
        name: "No Creds",
        url: "https://nocreds.example.com",
        username: "admin",
        password: "secret",
        ownerId,
      },
      encryptionKey
    );

    const instances = listInstances(db);
    const instance = instances[0];
    // The Instance type should not have credentials
    expect((instance as Record<string, unknown>).encryptedCredentials).toBeUndefined();
    expect((instance as Record<string, unknown>).encrypted_credentials).toBeUndefined();
  });
});
