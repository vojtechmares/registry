/**
 * Notification fan-out and delivery, against real D1.
 *
 * `fetch` is stubbed, because the point of these tests is what the registry
 * sends and when it gives up, not whether the internet is reachable.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type NotificationEvent, verifySignature } from "@registry/notifications";
import { NOTIFY_TASK, handleNotifyTask, notify } from "../src/notifications/dispatch.js";
import { NotificationStore } from "../src/notifications/store.js";
import { dedupe, toNotificationEvent } from "../src/notifications/translate.js";
import { TaskQueue } from "../src/tasks/queue.js";
import { runTask } from "../src/tasks/runner.js";
import { basic, call, seedProject, seedUser } from "./helpers.js";

const OWNER = { id: "notif-root", username: "notifroot", password: "correct-horse-battery" };
const auth = basic(OWNER.username, OWNER.password);
const jsonHeaders = { Authorization: auth, "Content-Type": "application/json" };

const SECRET = "test-secret";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: "evt-1",
    type: "PUSH_ARTIFACT",
    occurredAt: "2026-07-10T00:00:00.000Z",
    project: "notif",
    repository: "notif/app",
    tag: "v1",
    actor: "notifroot",
    ...overrides,
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

let captured: Captured[] = [];
let respondWith: () => Response;

beforeAll(async () => {
  await seedUser({ ...OWNER, isAdmin: true });
});

beforeEach(() => {
  captured = [];
  respondWith = () => new Response(null, { status: 200 });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return respondWith();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Creates a webhook policy directly, bypassing the API's URL screening. */
async function seedPolicy(
  project: string,
  overrides: Partial<{ id: string; target: string; eventTypes: string[]; enabled: boolean }> = {},
): Promise<string> {
  const id = overrides.id ?? crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO notification_policies
       (id, project, name, enabled, target_type, target, secret, event_types, created_at, updated_at)
     VALUES (?, ?, 'hook', ?, 'webhook', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      project,
      overrides.enabled === false ? 0 : 1,
      overrides.target ?? "https://example.com/hook",
      SECRET,
      JSON.stringify(overrides.eventTypes ?? ["PUSH_ARTIFACT"]),
      now,
      now,
    )
    .run();
  return id;
}

describe("translating registry events", () => {
  it("turns a manifest push into a PUSH_ARTIFACT", () => {
    const translated = toNotificationEvent(
      {
        kind: "manifest.push",
        project: "acme",
        repository: "acme/api",
        digest: "sha256:abc",
        tag: "v1",
        mediaType: "m",
        artifactType: null,
        size: 10,
        at: Date.now(),
      },
      { username: "alice" },
    );
    expect(translated?.type).toBe("PUSH_ARTIFACT");
    expect(translated?.actor).toBe("alice");
  });

  it("does not announce a layer upload", () => {
    const translated = toNotificationEvent(
      {
        kind: "blob.push",
        project: "acme",
        repository: "acme/api",
        digest: "sha256:abc",
        tag: null,
        mediaType: null,
        artifactType: null,
        size: 10,
        at: Date.now(),
      },
      { username: "alice" },
    );
    expect(translated).toBeNull();
  });

  it("collapses a repeated event into one piece of news", () => {
    const a = event();
    const b = event({ id: "evt-2" });
    expect(dedupe([a, b])).toHaveLength(1);
  });
});

describe("fan-out", () => {
  it("queues one delivery per interested policy", async () => {
    await seedProject({ name: "notif" });
    await seedPolicy("notif");
    await seedPolicy("notif");
    // Not interested in a push.
    await seedPolicy("notif", { eventTypes: ["PULL_ARTIFACT"] });

    expect(await notify(env, event())).toBe(2);

    const queued = await new TaskQueue(env.DB).claim(10);
    expect(queued).toHaveLength(2);
    expect(queued.every((task) => task.kind === NOTIFY_TASK)).toBe(true);
  });

  it("skips a disabled policy", async () => {
    await seedProject({ name: "notif-off" });
    await seedPolicy("notif-off", { enabled: false });
    expect(await notify(env, event({ project: "notif-off" }))).toBe(0);
  });

  it("never crosses a project boundary", async () => {
    await seedProject({ name: "notif-a" });
    await seedProject({ name: "notif-b" });
    await seedPolicy("notif-a");
    expect(await notify(env, event({ project: "notif-b" }))).toBe(0);
  });
});

describe("delivering a webhook", () => {
  it("posts a signed payload the recipient can verify", async () => {
    await seedProject({ name: "notif-sign" });
    const id = await seedPolicy("notif-sign");
    await handleNotifyTask({ policyId: id, event: event({ project: "notif-sign" }) }, env);

    expect(captured).toHaveLength(1);
    const [sent] = captured;
    expect(sent!.url).toBe("https://example.com/hook");
    expect(sent!.headers.get("X-Registry-Event")).toBe("PUSH_ARTIFACT");

    const signature = sent!.headers.get("X-Registry-Signature")!;
    expect(await verifySignature(sent!.body, signature, SECRET)).toBe(true);
    expect(await verifySignature(sent!.body, signature, "wrong")).toBe(false);

    const payload = JSON.parse(sent!.body) as { version: number; event: { type: string } };
    expect(payload.version).toBe(1);
    expect(payload.event.type).toBe("PUSH_ARTIFACT");
  });

  it("does not follow a redirect, which would be a second unscreened URL", async () => {
    await seedProject({ name: "notif-redir" });
    const id = await seedPolicy("notif-redir");
    await handleNotifyTask({ policyId: id, event: event({ project: "notif-redir" }) }, env);
    expect(captured).toHaveLength(1);
  });

  it("records a successful delivery", async () => {
    await seedProject({ name: "notif-ok" });
    const id = await seedPolicy("notif-ok");
    await handleNotifyTask({ policyId: id, event: event({ project: "notif-ok" }) }, env);

    const log = await new NotificationStore(env.DB).deliveries("notif-ok", 10);
    expect(log[0]).toMatchObject({ status: "delivered", responseStatus: 200 });
  });

  it("retries a 5xx", async () => {
    await seedProject({ name: "notif-5xx" });
    const id = await seedPolicy("notif-5xx");
    respondWith = () => new Response(null, { status: 503 });

    await expect(
      handleNotifyTask({ policyId: id, event: event({ project: "notif-5xx" }) }, env),
    ).rejects.toThrow(/503/);

    const log = await new NotificationStore(env.DB).deliveries("notif-5xx", 10);
    expect(log[0]).toMatchObject({ status: "failed", responseStatus: 503 });
  });

  it("gives up on a 4xx, which will never succeed", async () => {
    await seedProject({ name: "notif-4xx" });
    const id = await seedPolicy("notif-4xx");
    respondWith = () => new Response(null, { status: 410 });

    // Swallowed, not thrown: the queue must not retry a foregone conclusion.
    await handleNotifyTask({ policyId: id, event: event({ project: "notif-4xx" }) }, env);

    const log = await new NotificationStore(env.DB).deliveries("notif-4xx", 10);
    expect(log[0]).toMatchObject({ status: "failed", responseStatus: 410 });
  });

  it("retries a 429, which is the endpoint asking for patience", async () => {
    await seedProject({ name: "notif-429" });
    const id = await seedPolicy("notif-429");
    respondWith = () => new Response(null, { status: 429 });
    await expect(
      handleNotifyTask({ policyId: id, event: event({ project: "notif-429" }) }, env),
    ).rejects.toThrow(/429/);
  });

  it("refuses to call a private address, permanently", async () => {
    await seedProject({ name: "notif-ssrf" });
    const id = await seedPolicy("notif-ssrf", { target: "https://169.254.169.254/latest/meta-data" });

    await handleNotifyTask({ policyId: id, event: event({ project: "notif-ssrf" }) }, env);
    expect(captured).toHaveLength(0);

    const log = await new NotificationStore(env.DB).deliveries("notif-ssrf", 10);
    expect(log[0]?.status).toBe("failed");
  });

  it("does nothing when the policy was deleted between queueing and delivery", async () => {
    await seedProject({ name: "notif-gone" });
    await handleNotifyTask({ policyId: "does-not-exist", event: event({ project: "notif-gone" }) }, env);
    expect(captured).toHaveLength(0);
  });

  it("fails a malformed payload rather than guessing", async () => {
    await expect(handleNotifyTask({ nonsense: true }, env)).rejects.toThrow(/malformed/);
  });

  it("runs through the queue, retrying a transient failure", async () => {
    await seedProject({ name: "notif-queue" });
    await seedPolicy("notif-queue");
    respondWith = () => new Response(null, { status: 500 });

    await notify(env, event({ project: "notif-queue" }));
    const queue = new TaskQueue(env.DB);
    const [task] = await queue.claim(10);

    const ok = await runTask(queue, { [NOTIFY_TASK]: handleNotifyTask }, task!, env);
    expect(ok).toBe(false);

    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?")
      .bind(task!.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });
});

describe("the notification policy API", () => {
  it("refuses a webhook URL that is not https", async () => {
    await seedProject({ name: "api-notif" });
    const response = await call("POST", "/api/v1/projects/api-notif/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "hook",
        targetType: "webhook",
        target: "http://example.com/hook",
        eventTypes: ["PUSH_ARTIFACT"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a webhook pointed at the metadata service", async () => {
    await seedProject({ name: "api-notif2" });
    const response = await call("POST", "/api/v1/projects/api-notif2/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "hook",
        targetType: "webhook",
        target: "https://169.254.169.254/",
        eventTypes: ["PUSH_ARTIFACT"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses an unknown event type", async () => {
    await seedProject({ name: "api-notif3" });
    const response = await call("POST", "/api/v1/projects/api-notif3/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "hook",
        targetType: "webhook",
        target: "https://example.com/hook",
        eventTypes: ["EVERYTHING"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("mints a secret and returns it exactly once", async () => {
    await seedProject({ name: "api-notif4" });
    const created = await call("POST", "/api/v1/projects/api-notif4/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "hook",
        targetType: "webhook",
        target: "https://example.com/hook",
        eventTypes: ["PUSH_ARTIFACT"],
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; secret: string };
    expect(body.secret).toMatch(/^[a-f0-9]{32}$/);

    const listed = await call("GET", "/api/v1/projects/api-notif4/notifications", {
      headers: { Authorization: auth },
    });
    const { policies } = (await listed.json()) as { policies: Array<Record<string, unknown>> };
    expect(policies[0]).not.toHaveProperty("secret");
  });

  it("accepts an email target", async () => {
    await seedProject({ name: "api-notif5" });
    const response = await call("POST", "/api/v1/projects/api-notif5/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "mail",
        targetType: "email",
        target: "ops@example.com",
        eventTypes: ["QUOTA_EXCEEDED"],
      }),
    });
    expect(response.status).toBe(201);
  });

  it("refuses a malformed email target", async () => {
    await seedProject({ name: "api-notif6" });
    const response = await call("POST", "/api/v1/projects/api-notif6/notifications", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "mail",
        targetType: "email",
        target: "not-an-address",
        eventTypes: ["QUOTA_EXCEEDED"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("is closed to a caller who does not own the project", async () => {
    await seedProject({ name: "api-notif7" });
    await seedUser({ id: "nosy", username: "nosy", password: "correct-horse-battery" });
    const response = await call("GET", "/api/v1/projects/api-notif7/notifications", {
      headers: { Authorization: basic("nosy", "correct-horse-battery") },
    });
    expect(response.status).toBe(403);
  });
});
