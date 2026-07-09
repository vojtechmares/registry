/**
 * Replication against real D1 and R2, with the far registry stubbed.
 *
 * The properties worth holding onto: a remote password is never stored in the
 * clear, a pull always lands inside the rule's own project, a push only fires
 * for the rules that asked, and a replicated image is charged to the quota it
 * would have been charged had someone pushed it by hand.
 */

import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seal, unseal } from "../src/crypto/sealed.js";
import { destinationFor, handleReplicateTask, localRegistry } from "../src/replication/execute.js";
import { ReplicationStore } from "../src/replication/store.js";
import { triggerReplication } from "../src/replication/trigger.js";
import { TaskQueue } from "../src/tasks/queue.js";
import { basic, call, projectUsage, seedProject, seedRepository, seedUser } from "./helpers.js";

const OWNER = { id: "repl-root", username: "replroot", password: "correct-horse-battery" };
const auth = basic(OWNER.username, OWNER.password);
const jsonHeaders = { Authorization: auth, "Content-Type": "application/json" };

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An upstream registry with one image at `library/alpine:v1`. */
async function upstream() {
  const config = new Uint8Array([1, 2, 3]);
  const layer = new Uint8Array([4, 5, 6, 7]);
  const configDigest = await sha256(config);
  const layerDigest = await sha256(layer);

  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: 3 },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: 4 }],
  });
  const manifestBytes = new TextEncoder().encode(manifest);

  const blobs = new Map([
    [configDigest, config],
    [layerDigest, layer],
  ]);

  return {
    manifestBytes,
    layerDigest,
    configDigest,
    totalBytes: config.length + layer.length,
    handler: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";

      if (url.pathname === "/v2/library/alpine/tags/list") {
        return Response.json({ name: "library/alpine", tags: ["v1", "latest", "nightly"] });
      }
      if (url.pathname.startsWith("/v2/library/alpine/manifests/")) {
        return new Response(manifestBytes, {
          headers: { "Content-Type": MANIFEST_TYPE, "Docker-Content-Digest": await sha256(manifestBytes) },
        });
      }
      const blobMatch = /^\/v2\/library\/alpine\/blobs\/(.+)$/.exec(url.pathname);
      if (blobMatch !== null) {
        const bytes = blobs.get(blobMatch[1]!);
        if (bytes === undefined) return new Response(null, { status: 404 });
        if (method === "HEAD") return new Response(null, { status: 200 });
        return new Response(bytes as unknown as BodyInit, {
          headers: { "Content-Length": String(bytes.length) },
        });
      }
      return new Response(null, { status: 404 });
    },
  };
}

beforeAll(async () => {
  await seedUser({ ...OWNER, isAdmin: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sealing credentials", () => {
  it("round-trips a password", async () => {
    const sealed = await seal("hunter2", "worker-secret");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("hunter2");
    expect(await unseal(sealed, "worker-secret")).toBe("hunter2");
  });

  it("will not open under a different secret", async () => {
    const sealed = await seal("hunter2", "worker-secret");
    expect(await unseal(sealed, "other-secret")).toBeNull();
  });

  it("will not open when tampered with", async () => {
    const sealed = await seal("hunter2", "worker-secret");
    const parts = sealed.split(".");
    const flipped = `${parts[0]}.${parts[1]}.${parts[2]}.${btoa("tampered")}`;
    expect(await unseal(flipped, "worker-secret")).toBeNull();
  });

  it("rejects a malformed seal rather than throwing", async () => {
    expect(await unseal("garbage", "worker-secret")).toBeNull();
    expect(await unseal("v2.a.b.c", "worker-secret")).toBeNull();
  });

  it("uses a fresh salt, so the same password seals differently each time", async () => {
    expect(await seal("hunter2", "s")).not.toBe(await seal("hunter2", "s"));
  });

  it("stores only ciphertext, and hands back the plaintext on demand", async () => {
    await seedProject({ name: "repl-cred" });
    const store = new ReplicationStore(env.DB, "worker-secret");
    const rule = await store.create({
      id: crypto.randomUUID(),
      project: "repl-cred",
      name: "mirror",
      direction: "push",
      remoteUrl: "https://remote.test",
      credentials: { username: "alice", password: "hunter2" },
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: [],
      tagFilter: {},
      trigger: "manual",
      schedule: null,
    });

    const row = await env.DB.prepare("SELECT remote_password FROM replication_rules WHERE id = ?")
      .bind(rule.id)
      .first<{ remote_password: string }>();
    expect(row?.remote_password).not.toContain("hunter2");

    expect(await store.credentials(rule.id)).toEqual({ username: "alice", password: "hunter2" });
  });
});

const pullRule = (project: string, namespace = "") =>
  ({
    id: "r",
    project,
    name: "n",
    enabled: true,
    direction: "pull" as const,
    remoteUrl: "https://remote.test",
    destinationNamespace: namespace,
    repositoryFilter: "*",
    sourceRepositories: [],
    tagFilter: {},
    trigger: "manual" as const,
    schedule: null,
  }) satisfies Parameters<typeof destinationFor>[0];

describe("destinationFor", () => {
  it("lands a remote repository inside the rule's project", () => {
    expect(destinationFor(pullRule("mirror"), "library/alpine")).toBe("mirror/alpine");
  });

  it("honours a destination namespace", () => {
    expect(destinationFor(pullRule("mirror", "docker"), "library/alpine")).toBe("mirror/docker/alpine");
  });

  it("cannot be steered out of the project by the remote name", () => {
    // Only the last segment of the remote name is used, and the project is
    // always prepended, so no upstream name reaches another project. A traversal
    // attempt lands harmlessly inside the rule's own namespace.
    for (const remote of ["../../evil", "other/../../thing", "a/b/c", "library/alpine"]) {
      const destination = destinationFor(pullRule("mirror"), remote);
      if (destination === null) continue;
      expect(destination.startsWith("mirror/")).toBe(true);
    }
    expect(destinationFor(pullRule("mirror"), "a/b/c")).toBe("mirror/c");
  });

  it("refuses a remote name that would not make a valid repository", () => {
    expect(destinationFor(pullRule("mirror"), "")).toBeNull();
    expect(destinationFor(pullRule("mirror"), "UPPER")).toBeNull();
    // `..` is not a legal repository path component.
    expect(destinationFor(pullRule("mirror"), "..")).toBeNull();
  });

  it("refuses a project name that is not one", () => {
    // A rule row can only be created through the API, which validates the
    // project; this is the belt to that brace.
    expect(destinationFor(pullRule("Mirror"), "library/alpine")).toBeNull();
  });
});

describe("pulling from an upstream registry", () => {
  it("copies the matching tags into the project, blobs and all", async () => {
    const source = await upstream();
    vi.stubGlobal("fetch", source.handler);

    await seedProject({ name: "repl-pull" });
    const store = new ReplicationStore(env.DB, env.JWT_SECRET);
    const rule = await store.create({
      id: crypto.randomUUID(),
      project: "repl-pull",
      name: "alpine",
      direction: "pull",
      remoteUrl: "https://remote.test",
      credentials: null,
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: ["library/alpine"],
      tagFilter: { pattern: "v*" },
      trigger: "manual",
      schedule: null,
    });

    await handleReplicateTask({ ruleId: rule.id }, env);

    // Only `v1` matched the filter.
    const local = localRegistry(env);
    expect(await local.listTags("repl-pull/alpine")).toEqual(["v1"]);

    const manifest = await local.getManifest("repl-pull/alpine", "v1");
    expect(manifest?.digest).toBe(await sha256(source.manifestBytes));

    // And the blobs came with it.
    expect(await local.hasBlob("repl-pull/alpine", source.layerDigest)).toBe(true);
  });

  it("charges the project's quota for what it pulled", async () => {
    const source = await upstream();
    vi.stubGlobal("fetch", source.handler);

    await seedProject({ name: "repl-quota" });
    const store = new ReplicationStore(env.DB, env.JWT_SECRET);
    const rule = await store.create({
      id: crypto.randomUUID(),
      project: "repl-quota",
      name: "alpine",
      direction: "pull",
      remoteUrl: "https://remote.test",
      credentials: null,
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: ["library/alpine"],
      tagFilter: { pattern: "v1" },
      trigger: "manual",
      schedule: null,
    });

    await handleReplicateTask({ ruleId: rule.id }, env);
    expect(await projectUsage("repl-quota")).toBe(source.totalBytes);
  });

  it("refuses to exceed the project's quota, and says so in the execution log", async () => {
    const source = await upstream();
    vi.stubGlobal("fetch", source.handler);

    await seedProject({ name: "repl-full", quotaBytes: 1 });
    const store = new ReplicationStore(env.DB, env.JWT_SECRET);
    const rule = await store.create({
      id: crypto.randomUUID(),
      project: "repl-full",
      name: "alpine",
      direction: "pull",
      remoteUrl: "https://remote.test",
      credentials: null,
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: ["library/alpine"],
      tagFilter: { pattern: "v1" },
      trigger: "manual",
      schedule: null,
    });

    await handleReplicateTask({ ruleId: rule.id }, env);

    const runs = await store.executions("repl-full", 10);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("quota");
    expect(await projectUsage("repl-full")).toBe(0);
  });

  it("records a run that succeeded", async () => {
    const source = await upstream();
    vi.stubGlobal("fetch", source.handler);

    await seedProject({ name: "repl-log" });
    const store = new ReplicationStore(env.DB, env.JWT_SECRET);
    const rule = await store.create({
      id: crypto.randomUUID(),
      project: "repl-log",
      name: "alpine",
      direction: "pull",
      remoteUrl: "https://remote.test",
      credentials: null,
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: ["library/alpine"],
      tagFilter: { pattern: "v1" },
      trigger: "manual",
      schedule: null,
    });

    await handleReplicateTask({ ruleId: rule.id }, env);
    const runs = await store.executions("repl-log", 10);
    expect(runs[0]).toMatchObject({ status: "succeeded", manifests: 1, blobs: 2 });
  });

  it("does nothing for a rule that was deleted before the task ran", async () => {
    await expect(handleReplicateTask({ ruleId: crypto.randomUUID() }, env)).resolves.toBeUndefined();
  });
});

async function seedPushRule(project: string, overrides: Record<string, unknown> = {}) {
  const store = new ReplicationStore(env.DB, env.JWT_SECRET);
  return store.create({
    id: crypto.randomUUID(),
    project,
    name: "mirror",
    direction: "push",
    remoteUrl: "https://remote.test",
    credentials: null,
    destinationNamespace: "",
    repositoryFilter: "*",
    sourceRepositories: [],
    tagFilter: {},
    trigger: "event",
    schedule: null,
    ...overrides,
  } as Parameters<ReplicationStore["create"]>[0]);
}

describe("triggering on push", () => {
  const pushEvent = (project: string, repository: string, tag: string | null) => ({
    kind: "manifest.push" as const,
    project,
    repository,
    digest: "sha256:abc",
    tag,
    mediaType: MANIFEST_TYPE,
    artifactType: null,
    size: 10,
    at: Date.now(),
  });

  it("queues a run for a matching rule", async () => {
    await seedProject({ name: "trig-a" });
    await seedPushRule("trig-a");
    expect(await triggerReplication(env, [pushEvent("trig-a", "trig-a/api", "v1")])).toBe(1);
  });

  it("does not fire for a push by digest, which is half of a workflow", async () => {
    await seedProject({ name: "trig-b" });
    await seedPushRule("trig-b");
    expect(await triggerReplication(env, [pushEvent("trig-b", "trig-b/api", null)])).toBe(0);
  });

  it("does not fire for a repository the rule does not name", async () => {
    await seedProject({ name: "trig-c" });
    await seedPushRule("trig-c", { repositoryFilter: "trig-c/other" });
    expect(await triggerReplication(env, [pushEvent("trig-c", "trig-c/api", "v1")])).toBe(0);
  });

  it("does not fire for a tag the rule filters out", async () => {
    await seedProject({ name: "trig-d" });
    await seedPushRule("trig-d", { tagFilter: { semver: "^1.0.0" } });
    expect(await triggerReplication(env, [pushEvent("trig-d", "trig-d/api", "nightly")])).toBe(0);
    expect(await triggerReplication(env, [pushEvent("trig-d", "trig-d/api", "v1.2.3")])).toBe(1);
  });

  it("never fires a pull rule, which subscribes to somebody else's registry", async () => {
    await seedProject({ name: "trig-e" });
    const store = new ReplicationStore(env.DB, env.JWT_SECRET);
    await store.create({
      id: crypto.randomUUID(),
      project: "trig-e",
      name: "sub",
      direction: "pull",
      remoteUrl: "https://remote.test",
      credentials: null,
      destinationNamespace: "",
      repositoryFilter: "*",
      sourceRepositories: ["library/alpine"],
      tagFilter: {},
      trigger: "scheduled",
      schedule: "0 3 * * *",
    });
    expect(await triggerReplication(env, [pushEvent("trig-e", "trig-e/api", "v1")])).toBe(0);
  });

  it("never fires another project's rule", async () => {
    await seedProject({ name: "trig-f" });
    await seedProject({ name: "trig-g" });
    await seedPushRule("trig-f");
    expect(await triggerReplication(env, [pushEvent("trig-g", "trig-g/api", "v1")])).toBe(0);
  });

  it("queues a durable task the sweep would find anyway", async () => {
    await seedProject({ name: "trig-h" });
    await seedPushRule("trig-h");
    await triggerReplication(env, [pushEvent("trig-h", "trig-h/api", "v1")]);

    const [task] = await new TaskQueue(env.DB).claim(10);
    expect(task?.kind).toBe("replication.run");
  });
});

describe("the replication rule API", () => {
  it("refuses a remote URL that is not https", async () => {
    await seedProject({ name: "api-repl" });
    const response = await call("POST", "/api/v1/projects/api-repl/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({ name: "r", direction: "push", remoteUrl: "http://remote.test" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a pull rule triggered by a push to this registry", async () => {
    await seedProject({ name: "api-repl2" });
    const response = await call("POST", "/api/v1/projects/api-repl2/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "r",
        direction: "pull",
        remoteUrl: "https://remote.test",
        trigger: "event",
        sourceRepositories: ["library/alpine"],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a pull rule that names no source repositories", async () => {
    await seedProject({ name: "api-repl3" });
    const response = await call("POST", "/api/v1/projects/api-repl3/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({ name: "r", direction: "pull", remoteUrl: "https://remote.test" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a scheduled rule with no cron expression", async () => {
    await seedProject({ name: "api-repl4" });
    const response = await call("POST", "/api/v1/projects/api-repl4/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "r",
        direction: "push",
        remoteUrl: "https://remote.test",
        trigger: "scheduled",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a tag filter whose semver range will not parse", async () => {
    await seedProject({ name: "api-repl5" });
    const response = await call("POST", "/api/v1/projects/api-repl5/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "r",
        direction: "push",
        remoteUrl: "https://remote.test",
        tagFilter: { semver: "garbage" },
      }),
    });
    expect(response.status).toBe(400);
  });

  it("creates a rule and never echoes the password", async () => {
    await seedProject({ name: "api-repl6" });
    const response = await call("POST", "/api/v1/projects/api-repl6/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({
        name: "r",
        direction: "push",
        remoteUrl: "https://remote.test/",
        remoteUsername: "alice",
        remotePassword: "hunter2",
        trigger: "event",
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain("hunter2");
    expect(JSON.parse(body)).toMatchObject({ remoteUrl: "https://remote.test", remoteUsername: "alice" });
  });

  it("queues a manual run rather than waiting on another registry", async () => {
    await seedProject({ name: "api-repl7" });
    await seedRepository("api-repl7/app");
    const created = await call("POST", "/api/v1/projects/api-repl7/replication", {
      headers: jsonHeaders,
      body: JSON.stringify({ name: "r", direction: "push", remoteUrl: "https://remote.test" }),
    });
    const { id } = (await created.json()) as { id: string };

    const run = await call("POST", `/api/v1/projects/api-repl7/replication/${id}`, {
      headers: jsonHeaders,
      body: "{}",
    });
    expect(run.status).toBe(202);

    const [task] = await new TaskQueue(env.DB).claim(10);
    expect(task?.kind).toBe("replication.run");
  });

  it("is closed to a caller who does not own the project", async () => {
    await seedProject({ name: "api-repl8" });
    await seedUser({ id: "repl-nosy", username: "replnosy", password: "correct-horse-battery" });
    const response = await call("GET", "/api/v1/projects/api-repl8/replication", {
      headers: { Authorization: basic("replnosy", "correct-horse-battery") },
    });
    expect(response.status).toBe(403);
  });
});
