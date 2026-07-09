import { SELF, env } from "cloudflare:test";
import { hashPassword } from "../src/auth/password.js";

/** The origin is arbitrary; only the path and query reach the router. */
const BASE = "https://registry.test";

/** Drives the Worker end to end, the way a registry client would. */
export function call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  return SELF.fetch(url, { method, ...init });
}

export function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/** The same seeded byte pattern the conformance suite uses, so failures are reproducible. */
export function deterministic(size: number, seed = 1): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
}

/**
 * SHA-256 over the whole buffer via Web Crypto. The Worker computes the same
 * digest incrementally for chunked uploads, so agreement here is what proves
 * the resumable hash was reassembled correctly.
 */
export async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export interface SeedUserOptions {
  readonly id: string;
  readonly username: string;
  readonly password: string;
  readonly isAdmin?: boolean;
}

/**
 * Inserts a real user row, hashing the password exactly as the registration
 * path does, so the Basic-auth flow verifies against a genuine PBKDF2 hash.
 */
export async function seedUser(options: SeedUserOptions): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, username, email, password_hash, is_admin, disabled, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 0, ?, ?)`,
  )
    .bind(
      options.id,
      options.username,
      await hashPassword(options.password),
      options.isAdmin ? 1 : 0,
      now,
      now,
    )
    .run();
}

/** Reads the first `errors[].code` from an OCI error response body. */
export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { errors: Array<{ code: string }> };
  return body.errors[0]!.code;
}
