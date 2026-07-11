/**
 * How D1 columns encode the values the stores work in, stated once.
 *
 * SQLite has no JSON, boolean, or enum columns, so every store transcribes the
 * same few encodings by hand: a JSON string with a fallback for a malformed or
 * absent value, an integer `0`/`1` flag, an enum guarded against a value the
 * schema no longer allows. Gathering them here means a schema change has one
 * landing site rather than six, and a store reads as what it does rather than
 * how the column happens to be stored.
 */

import type { UserSummary } from "@registry/api-contract";
import { type Role, isRole } from "@registry/projects";

/** A JSON column decoded to `T`, or `fallback` when it is absent or malformed. */
export function jsonColumn<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** A JSON object column, or null when it is absent, malformed, or not an object. */
export function jsonObject<T extends object>(raw: string | null): T | null {
  const parsed = jsonColumn<unknown>(raw, null);
  return typeof parsed === "object" && parsed !== null ? (parsed as T) : null;
}

/** A JSON array column, keeping only the elements `keep` accepts. */
export function jsonArray<T>(raw: string | null, keep: (value: unknown) => value is T): T[] {
  const parsed = jsonColumn<unknown>(raw, null);
  return Array.isArray(parsed) ? parsed.filter(keep) : [];
}

/** A SQLite integer flag as a boolean; `1` is true, anything else false. */
export function flag(value: number): boolean {
  return value === 1;
}

/** A boolean as the integer flag SQLite stores. */
export function flagValue(value: boolean): number {
  return value ? 1 : 0;
}

/** A role column, or null when it is absent or names a role the schema no longer allows. */
export function roleOf(raw: string | null): Role | null {
  return raw !== null && isRole(raw) ? raw : null;
}

/** The columns every user summary is read from. */
export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly is_admin: number;
  readonly disabled: number;
  readonly created_at: number;
}

/** The one place a user row becomes a `UserSummary`. */
export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    isAdmin: flag(row.is_admin),
    disabled: flag(row.disabled),
    createdAt: row.created_at,
  };
}
