/**
 * Store-level tests for the branches that are otherwise reachable only through a
 * full HTTP flow: federated (OIDC) account linking, including the email
 * collision, and the quota settlement a repository deletion performs.
 */

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { RepositoryStore } from "../src/storage/repositories.js";
import { UserStore } from "../src/storage/users.js";
import { seedProject, seedRepository } from "./helpers.js";

function users(): UserStore {
  return new UserStore(env.DB);
}

async function emailOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?")
    .bind(id)
    .first<{ email: string | null }>();
  return row?.email ?? null;
}

const link = (overrides: Record<string, unknown> = {}) => ({
  issuer: "https://idp.test",
  subject: "subject-123",
  username: "alice",
  email: "alice@example.com" as string | null,
  isAdmin: false,
  ...overrides,
});

describe("UserStore OIDC account linking", () => {
  it("creates a local account on first sign-in and returns the same one after", async () => {
    const first = await users().findOrCreateOidcUser(link());
    expect(first.username).toBe("alice");
    expect(first.isAdmin).toBe(false);

    const again = await users().findOrCreateOidcUser(link({ username: "ignored-on-return" }));
    expect(again.id).toBe(first.id);
    expect(again.username).toBe("alice");
  });

  it("re-reads administrator status from the provider on every sign-in", async () => {
    const created = await users().findOrCreateOidcUser(link({ subject: "admin-flip", isAdmin: false }));
    expect(created.isAdmin).toBe(false);

    const promoted = await users().findOrCreateOidcUser(link({ subject: "admin-flip", isAdmin: true }));
    expect(promoted.id).toBe(created.id);
    expect(promoted.isAdmin).toBe(true);
  });

  it("keys accounts on (issuer, subject), so the same subject from another issuer is a new account", async () => {
    const a = await users().findOrCreateOidcUser(link({ subject: "shared", issuer: "https://one.test" }));
    const b = await users().findOrCreateOidcUser(link({ subject: "shared", issuer: "https://two.test" }));
    expect(b.id).not.toBe(a.id);
  });

  it("drops an email another account already holds rather than failing the sign-in", async () => {
    // An existing account holds the address.
    const holder = await users().createUser({
      id: "holder-id",
      username: "holder",
      email: "taken@example.com",
      passwordHash: "x",
      isAdmin: false,
    });
    expect(holder.email).toBe("taken@example.com");

    // A federated sign-in claiming the same address is admitted, without it.
    const federated = await users().findOrCreateOidcUser(
      link({ subject: "collides", username: "newcomer", email: "taken@example.com" }),
    );
    expect(federated.email).toBeNull();
    expect(await emailOf(federated.id)).toBeNull();
    // The holder keeps its address.
    expect(await emailOf("holder-id")).toBe("taken@example.com");
  });

  it("gives a taken username the next free suffix", async () => {
    await users().createUser({
      id: "alice-local",
      username: "alice",
      email: null,
      passwordHash: "x",
      isAdmin: false,
    });
    const federated = await users().findOrCreateOidcUser(link({ subject: "suffix", username: "alice" }));
    expect(federated.username).toBe("alice-2");
  });
});

async function linkBlob(project: string, repository: string, digest: string, size: number): Promise<void> {
  const now = Date.now();
  // Content-addressed: a blob two repositories share is one row, linked twice.
  await env.DB.prepare(
    "INSERT INTO blobs (digest, size, storage_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (digest) DO NOTHING",
  )
    .bind(digest, size, `blobs/${digest}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO repository_blobs (repository, project, digest, created_at, link_token) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(repository, project, digest, now, crypto.randomUUID())
    .run();
}

async function usedBytes(project: string): Promise<number> {
  const row = await env.DB.prepare("SELECT used_bytes FROM projects WHERE name = ?")
    .bind(project)
    .first<{ used_bytes: number }>();
  return row?.used_bytes ?? 0;
}

describe("RepositoryStore deletion quota settlement", () => {
  beforeEach(async () => {
    await seedProject({ name: "del-quota" });
  });

  it("settles used_bytes to what the surviving links account for", async () => {
    await seedRepository("del-quota/app");
    await linkBlob("del-quota", "del-quota/app", `sha256:${"a".repeat(64)}`, 500);
    await env.DB.prepare("UPDATE projects SET used_bytes = 500 WHERE name = ?").bind("del-quota").run();
    expect(await usedBytes("del-quota")).toBe(500);

    expect(await new RepositoryStore(env.DB).deleteRepository("del-quota/app")).toBe(true);

    // The only link is gone, so the project is charged for nothing.
    expect(await usedBytes("del-quota")).toBe(0);
    const remaining = await env.DB.prepare("SELECT 1 FROM repositories WHERE name = ?")
      .bind("del-quota/app")
      .first();
    expect(remaining).toBeNull();
  });

  it("keeps charging for a blob a sibling repository still links", async () => {
    await seedRepository("del-quota/app");
    await seedRepository("del-quota/mirror");
    const shared = `sha256:${"b".repeat(64)}`;
    await linkBlob("del-quota", "del-quota/app", shared, 800);
    await linkBlob("del-quota", "del-quota/mirror", shared, 800);
    await env.DB.prepare("UPDATE projects SET used_bytes = 800 WHERE name = ?").bind("del-quota").run();

    await new RepositoryStore(env.DB).deleteRepository("del-quota/app");

    // The bytes are counted once per project, and the mirror still links them.
    expect(await usedBytes("del-quota")).toBe(800);
  });
});
