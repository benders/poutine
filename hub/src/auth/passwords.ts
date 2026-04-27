import {
  encryptPassword,
  decryptPassword,
  constantTimeEqual,
} from "./password-crypto.js";

export function setPassword(plain: string, key: Buffer): string {
  return encryptPassword(plain, key);
}

export function verifyPassword(
  enc: string,
  candidate: string,
  key: Buffer,
): boolean {
  if (!enc) return false;
  let stored: string;
  try {
    stored = decryptPassword(enc, key);
  } catch {
    return false;
  }
  return constantTimeEqual(stored, candidate);
}

export function getStoredPassword(enc: string, key: Buffer): string | null {
  if (!enc) return null;
  try {
    return decryptPassword(enc, key);
  } catch {
    return null;
  }
}
