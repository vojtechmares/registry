import { signJwt, verifyJwt } from "./jwt.js";
import type { RegistryConfig } from "./config.js";
import type { Identity } from "./principal.js";

/**
 * Dashboard sessions.
 *
 * The session JWT rides in an httpOnly cookie so no script can read it, and
 * `SameSite=Strict` means a third-party page cannot make the browser attach it.
 * The cookie is deliberately confined to `/api/`: the registry API at `/v2/`
 * must never authenticate from a cookie, or any page on the internet could
 * drive a `docker push` through a logged-in browser.
 */
export const SESSION_COOKIE = "registry_session";
export const SESSION_PATH = "/api";

/** Long enough to be usable, short enough that a revoked account loses access. */
const SESSION_TTL_SECONDS = 60 * 60;

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function createSessionCookie(
  identity: Identity,
  config: RegistryConfig,
  secure: boolean,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: identity.id,
      name: identity.username,
      admin: identity.isAdmin,
      access: [],
      iss: config.issuer,
      aud: config.service,
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + SESSION_TTL_SECONDS,
      jti: crypto.randomUUID(),
    },
    config.jwtSecret,
  );

  return cookie(token, SESSION_TTL_SECONDS, secure);
}

export function clearSessionCookie(secure: boolean): string {
  return cookie("", 0, secure);
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `Path=${SESSION_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  // Omitted over plain HTTP, or the browser drops the cookie during local development.
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function verifySessionCookie(token: string, config: RegistryConfig): Promise<Identity | null> {
  const claims = await verifyJwt(token, config.jwtSecret, {
    issuer: config.issuer,
    audience: config.service,
  });
  if (claims === null || claims.sub === "anonymous") return null;
  return { id: claims.sub, username: claims.name, isAdmin: claims.admin };
}
