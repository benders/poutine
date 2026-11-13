import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";

/**
 * Session JWTs (#315). Two types, never interchangeable:
 *
 * - `access`  — bearer credential for `requireAuth` / `requireOwner` routes.
 * - `refresh` — good only at `POST /admin/refresh`.
 *
 * Both carry `tv`, the user's `users.token_version` at mint time. Callers
 * compare it against the current row; bumping the column revokes every
 * outstanding token for that user (see `auth/session.ts`).
 */
export type TokenType = "access" | "refresh";

export interface VerifiedToken {
  userId: string;
  tokenVersion: number;
}

const ALGORITHM = "HS256";

function getSecretKey(config: Config): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

async function signToken(
  type: TokenType,
  userId: string,
  tokenVersion: number,
  expiresIn: string,
  config: Config,
): Promise<string> {
  return new SignJWT({ userId, type, tv: tokenVersion })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(expiresIn) // jose accepts "15m", "7d" directly
    .setSubject(userId)
    .sign(getSecretKey(config));
}

async function verifyTyped(
  type: TokenType,
  token: string,
  config: Config,
): Promise<VerifiedToken> {
  const { payload } = await jwtVerify(token, getSecretKey(config), {
    algorithms: [ALGORITHM],
  });
  if (payload.type !== type) {
    throw new Error(`Not an ${type} token`);
  }
  const userId = payload.sub || payload.userId;
  if (typeof userId !== "string") {
    throw new Error("Invalid token: missing userId");
  }
  // Tokens minted before #315 carry no `tv`; they match the column default.
  const tv = payload.tv ?? 0;
  if (typeof tv !== "number" || !Number.isInteger(tv)) {
    throw new Error("Invalid token: bad token version");
  }
  return { userId, tokenVersion: tv };
}

export function createAccessToken(
  userId: string,
  config: Config,
  tokenVersion = 0,
): Promise<string> {
  return signToken("access", userId, tokenVersion, config.jwtAccessExpiresIn, config);
}

export function createRefreshToken(
  userId: string,
  config: Config,
  tokenVersion = 0,
): Promise<string> {
  return signToken("refresh", userId, tokenVersion, config.jwtRefreshExpiresIn, config);
}

/** Verify an **access** token. A refresh token is rejected. */
export function verifyToken(token: string, config: Config): Promise<VerifiedToken> {
  return verifyTyped("access", token, config);
}

/** Verify a **refresh** token. An access token is rejected. */
export function verifyRefreshToken(
  token: string,
  config: Config,
): Promise<VerifiedToken> {
  return verifyTyped("refresh", token, config);
}
