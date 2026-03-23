import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import {
  listInstances,
  getInstanceCredentials,
  updateInstanceStatus,
} from "./registry.js";

export interface SubsonicClient {
  ping(): Promise<boolean>;
}

export type CreateClientFn = (
  url: string,
  username: string,
  password: string
) => SubsonicClient;

export async function checkInstanceHealth(
  instance: { id: string; url: string },
  client: SubsonicClient
): Promise<"online" | "offline"> {
  try {
    const ok = await client.ping();
    return ok ? "online" : "offline";
  } catch {
    return "offline";
  }
}

export function startHealthChecker(
  db: Database.Database,
  config: Config,
  createClient: CreateClientFn
): NodeJS.Timeout {
  const check = async () => {
    const instances = listInstances(db);

    for (const instance of instances) {
      const creds = getInstanceCredentials(db, instance.id, config.encryptionKey);
      if (!creds) continue;

      const client = createClient(instance.url, creds.username, creds.password);
      const status = await checkInstanceHealth(instance, client);
      const lastSeen = status === "online" ? new Date().toISOString() : undefined;
      updateInstanceStatus(db, instance.id, status, lastSeen);
    }
  };

  // Run immediately, then on interval
  check().catch(() => {});

  return setInterval(() => {
    check().catch(() => {});
  }, config.healthCheckIntervalMs);
}
