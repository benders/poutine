import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  createHash,
  type KeyObject,
} from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

// Standard 12-byte SPKI prefix for Ed25519 public keys in DER encoding.
// Structure: SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING { raw_key } }
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

// ── Key loading / creation ────────────────────────────────────────────────────

export function loadOrCreatePrivateKey(
  path: string,
): { privateKey: KeyObject; publicKeyBase64: string } {
  let privateKey: KeyObject;

  if (existsSync(path)) {
    const pem = readFileSync(path, "utf8");
    privateKey = createPrivateKey(pem);
  } else {
    const { privateKey: pk } = generateKeyPairSync("ed25519");
    privateKey = pk;
    const pem = pk.export({ format: "pem", type: "pkcs8" }) as string;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pem, { mode: 0o600 });
  }

  const publicKey = createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // Last 32 bytes of the SPKI DER are the raw Ed25519 public key.
  const rawPubKey = spkiDer.slice(-32);
  const publicKeyBase64 = rawPubKey.toString("base64");

  return { privateKey, publicKeyBase64 };
}

// ── Public key parsing ────────────────────────────────────────────────────────

export function parsePeerPublicKey(spec: string): KeyObject {
  if (!spec.startsWith("ed25519:")) {
    throw new Error(`Invalid public key spec: expected "ed25519:<base64>", got "${spec}"`);
  }
  const raw = Buffer.from(spec.slice(8), "base64");
  if (raw.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key length: expected 32 bytes, got ${raw.length}`,
    );
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// ── Canonical payload ─────────────────────────────────────────────────────────

export function canonicalSigningPayload(input: {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  instanceId: string;
  userAssertion: string;
}): Buffer {
  return Buffer.from(
    [
      input.method,
      input.path,
      input.bodyHash,
      input.timestamp,
      input.instanceId,
      input.userAssertion,
    ].join("\n"),
    "utf8",
  );
}

// ── Hash helper ───────────────────────────────────────────────────────────────

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256")
    .update(typeof buf === "string" ? Buffer.from(buf, "utf8") : buf)
    .digest("hex");
}

// ── Sign / verify ─────────────────────────────────────────────────────────────

export function signRequest(privateKey: KeyObject, payload: Buffer): string {
  const sig = cryptoSign(null, payload, privateKey);
  return sig.toString("base64");
}

export function verifyRequest(
  publicKey: KeyObject,
  payload: Buffer,
  signatureBase64: string,
): boolean {
  try {
    const sigBuf = Buffer.from(signatureBase64, "base64");
    return cryptoVerify(null, payload, publicKey, sigBuf);
  } catch {
    return false;
  }
}
