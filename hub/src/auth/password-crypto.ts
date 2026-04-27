import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function loadOrCreatePasswordKey(path: string): Buffer {
  if (existsSync(path)) {
    const b64 = readFileSync(path, "utf8").trim();
    const key = Buffer.from(b64, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Password key at ${path} is ${key.length} bytes; expected ${KEY_BYTES}`,
      );
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key.toString("base64") + "\n", { mode: 0o600 });
  return key;
}

export function encryptPassword(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptPassword(enc: string, key: Buffer): string {
  const buf = Buffer.from(enc, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
