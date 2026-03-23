import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function deriveKey(key: string): Buffer {
  // Derive a 32-byte key using SHA-256
  return createHash("sha256").update(key).digest();
}

export function encrypt(plaintext: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Concatenate iv + ciphertext + tag and encode as base64
  const result = Buffer.concat([iv, encrypted, tag]);
  return result.toString("base64");
}

export function decrypt(encrypted: string, key: string): string {
  const derivedKey = deriveKey(key);
  const data = Buffer.from(encrypted, "base64");

  const iv = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
