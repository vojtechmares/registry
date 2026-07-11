/**
 * The quota-exceeded event and its per-project throttle, against real D1.
 *
 * A push refused for quota tells the project's subscribers, but a CI retry loop
 * that hammers a full project must not become a webhook storm, so at most one
 * event per project per cooldown window is dispatched.
 */

import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NOTIFY_TASK, handleNotifyTask } from "../src/notifications/dispatch.js";
import { QUOTA_EVENT_COOLDOWN_MS, claimQuotaWindow } from "../src/notifications/quota.js";
import { NotificationStore } from "../src/notifications/store.js";
import { TaskQueue } from "../src/tasks/queue.js";
import { runTask } from "../src/tasks/runner.js";
import { basic, call, digestOf, seedProject, seedRepository, seedUser } from "./helpers.js";

const OWNER = { id: "quota-root", username: "quotaroot", password: "correct-horse-battery" };
const auth = basic(OWNER.username, OWNER.password);
const NOW = Date.parse("2026-07-10T00:00:00Z");

beforeAll(async () => {
  await seedUser({ ...OWNER, isAdmin: true });
});

async function subscribeQuota(project: string, eventTypes: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO notification_policies
       (id, project, name, enabled, target_type, target, secret, event_types, created_at, updated_at)
     VALUES (?, ?, 'quota-hook', 1, 'webhook', 'https://example.com/quota', 'secret', ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), project, JSON.stringify(eventTypes), now, now)
    .run();
}

async function drainNotifications(): Promise<void> {
  const queue = new TaskQueue(env.DB);
  for (const task of await queue.claim(20)) {
    await runTask(queue, { [NOTIFY_TASK]: handleNotifyTask }, task, env);
  }
}

/** Lets `waitUntil` work drain before the test looks at what it wrote. */
async function settle(): Promise<void> {
  await SELF.fetch("https://registry.test/healthz");
  await scheduler.wait(20);
}

/** Pushes a blob larger than the project's quota, expecting a refusal. */
async function pushOversizeBlob(repository: string, seed: number): Promise<Response> {
  const bytes = new Uint8Array([seed, seed + 1, seed + 2, seed + 3]);
  const digest = await digestOf(bytes);
  return call("POST", `/v2/${repository}/blobs/uploads/?digest=${digest}`, {
    headers: { Authorization: auth, "Content-Length": String(bytes.length) },
    body: bytes as unknown as BodyInit,
  });
}

describe("claimQuotaWindow", () => {
  it("claims the window on the first refusal and throttles until it passes", async () => {
    await seedProject({ name: "throttle-a" });

    expect(await claimQuotaWindow(env.DB, "throttle-a", NOW)).toBe(true);
    // Within the window: throttled.
    expect(await claimQuotaWindow(env.DB, "throttle-a", NOW + 60_000)).toBe(false);
    // Past the window: the next event may go.
    expect(await claimQuotaWindow(env.DB, "throttle-a", NOW + QUOTA_EVENT_COOLDOWN_MS + 1)).toBe(true);
  });

  it("throttles each project independently", async () => {
    await seedProject({ name: "throttle-b" });
    await seedProject({ name: "throttle-c" });

    expect(await claimQuotaWindow(env.DB, "throttle-b", NOW)).toBe(true);
    // A different project's window is its own.
    expect(await claimQuotaWindow(env.DB, "throttle-c", NOW)).toBe(true);
    expect(await claimQuotaWindow(env.DB, "throttle-b", NOW + 1)).toBe(false);
  });
});

describe("the quota-exceeded event over HTTP", () => {
  let hooks: string[] = [];

  function captureWebhook() {
    hooks = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      hooks.push(String(init?.body ?? ""));
      return new Response(null, { status: 200 });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers one event for a refused push and throttles the retry", async () => {
    captureWebhook();
    await seedRepository("quota-ev/app", { name: "quota-ev", quotaBytes: 1 });
    await subscribeQuota("quota-ev", ["QUOTA_EXCEEDED"]);

    expect((await pushOversizeBlob("quota-ev/app", 1)).status).toBe(403);
    // A CI retry loop hits the same wall again.
    expect((await pushOversizeBlob("quota-ev/app", 5)).status).toBe(403);

    await settle();
    await drainNotifications();

    // Exactly one event despite two refusals.
    expect(hooks).toHaveLength(1);
    const payload = JSON.parse(hooks[0]!) as { event: { type: string; project: string } };
    expect(payload.event.type).toBe("QUOTA_EXCEEDED");
    expect(payload.event.project).toBe("quota-ev");

    const deliveries = await new NotificationStore(env.DB).deliveries("quota-ev", 10);
    expect(deliveries.filter((entry) => entry.eventType === "QUOTA_EXCEEDED")).toHaveLength(1);
  });

  it("sends nothing to a policy not subscribed to the quota type", async () => {
    captureWebhook();
    await seedRepository("quota-none/app", { name: "quota-none", quotaBytes: 1 });
    await subscribeQuota("quota-none", ["PUSH_ARTIFACT"]);

    expect((await pushOversizeBlob("quota-none/app", 1)).status).toBe(403);

    await settle();
    await drainNotifications();

    expect(hooks).toHaveLength(0);
  });
});
