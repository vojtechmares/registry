/**
 * Every user has an email address, and no two users share one.
 *
 * The interesting cases are the ones where two addresses are the same address
 * spelled differently, and the ones where a caller tries to change somebody
 * else's.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { UserSummary } from "@registry/api-contract";
import { basic, call, seedUser } from "./helpers.js";

const ADMIN = { id: "ue-root", username: "ueroot", password: "correct-horse-battery" };
const ALICE = { id: "ue-alice", username: "uealice", password: "alice-password-1234" };
const BOB = { id: "ue-bob", username: "uebob", password: "bob-password-12345" };

const adminAuth = basic(ADMIN.username, ADMIN.password);
const aliceAuth = basic(ALICE.username, ALICE.password);
const json = { "Content-Type": "application/json" };

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedUser(ALICE);
  await seedUser(BOB);
  await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("alice@example.com", ALICE.id).run();
});

const create = (body: unknown, auth = adminAuth): Promise<Response> =>
  call("POST", "/api/v1/users", { headers: { ...json, Authorization: auth }, body: JSON.stringify(body) });

const patch = (id: string, body: unknown, auth: string): Promise<Response> =>
  call("PATCH", `/api/v1/users/${id}`, {
    headers: { ...json, Authorization: auth },
    body: JSON.stringify(body),
  });

describe("creating a user", () => {
  it("requires an email address", async () => {
    const response = await create({ username: "noemail", password: "a-long-password" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("email is required");
  });

  it("refuses something that is not an address", async () => {
    const response = await create({ username: "bademail", password: "a-long-password", email: "carol" });
    expect(response.status).toBe(400);
  });

  it("stores the address folded to lowercase", async () => {
    const response = await create({
      username: "carol",
      password: "a-long-password",
      email: "  Carol@Example.COM ",
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as UserSummary).email).toBe("carol@example.com");
  });

  it("refuses an address another account already holds", async () => {
    const response = await create({
      username: "dave",
      password: "a-long-password",
      email: "alice@example.com",
    });
    expect(response.status).toBe(409);
  });

  it("refuses it however it is capitalised, because it is the same mailbox", async () => {
    const response = await create({
      username: "erin",
      password: "a-long-password",
      email: "ALICE@example.com",
    });
    expect(response.status).toBe(409);
  });

  it("is still refused to a non-administrator", async () => {
    const response = await create(
      { username: "mallory", password: "a-long-password", email: "m@example.com" },
      aliceAuth,
    );
    expect(response.status).toBe(403);
  });
});

describe("changing an address", () => {
  it("lets an administrator change anyone's", async () => {
    const response = await patch(BOB.id, { email: "bob@example.com" }, adminAuth);
    expect(response.status).toBe(200);
    expect(((await response.json()) as UserSummary).email).toBe("bob@example.com");
  });

  it("lets a user change their own", async () => {
    const response = await patch(ALICE.id, { email: "alice+new@example.com" }, aliceAuth);
    expect(response.status).toBe(200);
    expect(((await response.json()) as UserSummary).email).toBe("alice+new@example.com");
  });

  it("does not let a user change someone else's", async () => {
    const response = await patch(BOB.id, { email: "stolen@example.com" }, aliceAuth);
    expect(response.status).toBe(403);
  });

  it("accepts a user saving the address they already hold", async () => {
    // The conflict check must not find the user colliding with themselves.
    const response = await patch(ALICE.id, { email: "alice@example.com" }, aliceAuth);
    expect(response.status).toBe(200);
  });

  it("refuses an address another account holds", async () => {
    await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("taken@example.com", BOB.id).run();
    const response = await patch(ALICE.id, { email: "taken@example.com" }, aliceAuth);
    expect(response.status).toBe(409);
  });

  it("404s for a user that does not exist", async () => {
    const response = await patch("no-such-user", { email: "ghost@example.com" }, adminAuth);
    expect(response.status).toBe(404);
  });

  it("refuses an empty address rather than clearing it", async () => {
    const response = await patch(ALICE.id, { email: "" }, aliceAuth);
    expect(response.status).toBe(400);
  });
});

describe("the unique index", () => {
  it("is what actually enforces it, whatever the route checked", async () => {
    // Two accounts with one address is the state the route exists to prevent.
    // If the check ever races itself, this is what stops the write.
    await expect(
      env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind("alice@example.com", BOB.id).run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("still lets many accounts have no address at all", async () => {
    // The bootstrap administrator and a federated account whose provider sent
    // no address both live here, and must not collide with one another.
    await env.DB.prepare("UPDATE users SET email = NULL WHERE id IN (?, ?)").bind(ALICE.id, BOB.id).run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email IS NULL").first<{
      n: number;
    }>();
    expect(row?.n).toBeGreaterThanOrEqual(2);
  });
});
