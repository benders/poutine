import { SignJWT, jwtVerify } from "jose";
import type { Config } from "../config.js";

function getSecretKey(config: Config): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

function parseDuration(duration: string): string {
  // jose accepts durations like "15m", "7d" directly
  return duration;
}

export async function createAccessToken(
  userId: string,
  config: Config
): Promise<string> {
  const secret = getSecretKey(config);
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(parseDuration(config.jwtAccessExpiresIn))
    .setSubject(userId)
    .sign(secret);
}

export async function createRefreshToken(
  userId: string,
  config: Config
): Promise<string> {
  const secret = getSecretKey(config);
  return new SignJWT({ userId, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(parseDuration(config.jwtRefreshExpiresIn))
    .setSubject(userId)
    .sign(secret);
}

export async function verifyToken(
  token: string,
  config: Config
): Promise<{ userId: string }> {
  const secret = getSecretKey(config);
  const { payload } = await jwtVerify(token, secret);
  const userId = payload.sub || (payload as Record<string, unknown>).userId;
  if (typeof userId !== "string") {
    throw new Error("Invalid token: missing userId");
  }
  return { userId: userId as string };
}
