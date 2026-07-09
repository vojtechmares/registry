/**
 * HS256 JSON Web Tokens, signed with Web Crypto's HMAC.
 *
 * Written out rather than pulled in: the registry needs exactly one algorithm
 * and one claim set, and a JWT library's flexibility - `alg: none`, algorithm
 * confusion between HMAC and RSA - is the source of most JWT vulnerabilities.
 * Here the algorithm is fixed at both ends and never read from the token.
 */

import { timingSafeEqual } from "./password.js";

export interface RegistryClaims {
  /** Subject: the user id. */
  readonly sub: string;
  /** The authenticated username, for display and audit. */
  readonly name: string;
  readonly admin: boolean;
  /** Access granted by this token, in the Docker token-scope shape. */
  readonly access: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly actions: string[];
  }>;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf: number;
  readonly jti: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(claims: RegistryClaims, secret: string): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;

  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Returns the claims only if the signature, algorithm, audience and validity window all hold. */
export async function verifyJwt(
  token: string,
  secret: string,
  expected: { issuer: string; audience: string },
  now = Date.now(),
): Promise<RegistryClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let decodedHeader: unknown;
  try {
    decodedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header)));
  } catch {
    return null;
  }
  // The algorithm is asserted, never trusted from the token. `alg: none` and
  // HMAC/RSA confusion both die here.
  if (
    typeof decodedHeader !== "object" ||
    decodedHeader === null ||
    (decodedHeader as { alg?: unknown }).alg !== "HS256"
  ) {
    return null;
  }

  let actual: Uint8Array;
  try {
    actual = base64UrlDecode(signature);
  } catch {
    return null;
  }

  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(`${header}.${payload}`)),
  );
  if (!timingSafeEqual(actual, expectedSignature)) return null;

  let claims: RegistryClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as RegistryClaims;
  } catch {
    return null;
  }

  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return null;
  if (claims.iss !== expected.issuer || claims.aud !== expected.audience) return null;
  if (typeof claims.sub !== "string" || !Array.isArray(claims.access)) return null;

  return claims;
}
