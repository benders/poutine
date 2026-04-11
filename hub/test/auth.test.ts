import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";

describe("Password hashing", () => {
  it("should hash a password", async () => {
    const hash = await hashPassword("mysecretpassword");
    expect(hash).toBeTruthy();
    expect(hash).not.toBe("mysecretpassword");
    expect(hash.startsWith("$argon2")).toBe(true);
  });

  it("should verify a correct password", async () => {
    const hash = await hashPassword("mysecretpassword");
    const valid = await verifyPassword(hash, "mysecretpassword");
    expect(valid).toBe(true);
  });

  it("should reject an incorrect password", async () => {
    const hash = await hashPassword("mysecretpassword");
    const valid = await verifyPassword(hash, "wrongpassword");
    expect(valid).toBe(false);
  });

  it("should produce different hashes for the same password", async () => {
    const hash1 = await hashPassword("mysecretpassword");
    const hash2 = await hashPassword("mysecretpassword");
    expect(hash1).not.toBe(hash2);
  });
});
