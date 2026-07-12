import { describe, it, expect } from "vitest";
import { createDatabase } from "../src/db/client.js";
import { createSubsonicQueries } from "../src/db/queries/subsonic-queries.js";

// Catches SQL/schema drift at factory-init time instead of first request
// (#243 phase 2 — subsonic.ts's db.prepare calls moved here).
describe("createSubsonicQueries", () => {
  it("prepares all statements against a fresh schema without throwing", () => {
    const db = createDatabase(":memory:");
    expect(() => createSubsonicQueries(db)).not.toThrow();
    db.close();
  });

  it("returns statement objects keyed by intent", () => {
    const db = createDatabase(":memory:");
    const queries = createSubsonicQueries(db);
    for (const [name, stmt] of Object.entries(queries)) {
      expect(stmt, `${name} should be a prepared statement`).toBeDefined();
      expect(typeof stmt.get).toBe("function");
      expect(typeof stmt.all).toBe("function");
    }
    db.close();
  });
});
