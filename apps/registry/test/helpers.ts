import { SELF, env } from "cloudflare:test";
import type { ProblemDetails } from "@registry/api-contract";
import { type Role, projectOf } from "@registry/projects";
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

/** The RFC 9457 problem document every management API refusal carries. */
export async function problem(response: Response): Promise<ProblemDetails> {
  return (await response.json()) as ProblemDetails;
}

/** What a refusal says about this occurrence, which is what the dashboard shows. */
export async function detail(response: Response): Promise<string> {
  return (await problem(response)).detail;
}

export interface SeedProjectOptions {
  readonly name: string;
  readonly visibility?: "public" | "private";
  readonly quotaBytes?: number | null;
  readonly requireSignaturePush?: boolean;
  readonly requireSignaturePull?: boolean;
  readonly immutableTags?: boolean;
}

export async function seedProject(options: SeedProjectOptions): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO projects
       (name, visibility, quota_bytes, used_bytes, require_signature_push, require_signature_pull,
        immutable_tags, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       visibility = excluded.visibility,
       quota_bytes = excluded.quota_bytes,
       require_signature_push = excluded.require_signature_push,
       require_signature_pull = excluded.require_signature_pull,
       immutable_tags = excluded.immutable_tags`,
  )
    .bind(
      options.name,
      options.visibility ?? "private",
      options.quotaBytes ?? null,
      options.requireSignaturePush === true ? 1 : 0,
      options.requireSignaturePull === true ? 1 : 0,
      options.immutableTags === true ? 1 : 0,
      now,
      now,
    )
    .run();
}

/** Creates the repository and, implicitly, the project holding it. */
export async function seedRepository(name: string, project?: SeedProjectOptions): Promise<void> {
  const owner = projectOf(name);
  await seedProject({ name: owner, ...project });

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO repositories (name, project, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name) DO NOTHING`,
  )
    .bind(name, owner, now, now)
    .run();
}

export async function seedMember(project: string, userId: string, role: Role): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO project_members (project, user_id, role, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (project, user_id) DO UPDATE SET role = excluded.role`,
  )
    .bind(project, userId, role, Date.now())
    .run();
}

/** The bytes a project is charged for, as the registry itself accounts them. */
export async function projectUsage(name: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_bytes FROM projects WHERE name = ?")
    .bind(name)
    .first<{ used_bytes: number }>();
  return row?.used_bytes ?? 0;
}
