import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

// Cookies are encrypted JWTs (A256GCM) with a key derived from AUTH_SECRET: nothing in them can
// be read or changed in the browser, and there's no session table.

const keyFor = (secret: string) => createHash("sha256").update(secret).digest();

/** Encrypts a payload that expires after `expiresIn` ("8h") or at a time in seconds. */
export async function seal(
  payload: Record<string, unknown>,
  expiresIn: string | number,
  secret: string,
): Promise<string> {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .encrypt(keyFor(secret));
}

/** The payload, or null when the token is missing, expired, tampered with or from another key. */
export async function unseal(
  token: string | undefined,
  secret: string,
): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    return (await jwtDecrypt(token, keyFor(secret))).payload;
  } catch {
    return null;
  }
}
