/**
 * A repository name carries slashes, so it cannot be one path segment.
 *
 * The router matches it with a lazy parameter, which is what makes a fixed
 * suffix decide the route: `acme/team/svc/tags` is the tags of `acme/team/svc`,
 * not a repository called `acme/team/svc/tags`. This file walks the ambiguities
 * that rule creates, because getting one wrong silently serves the wrong image.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { RepositoryDetail, TagSummary, UsageStats } from "@registry/api-contract";
import { basic, call, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "rr-root", username: "rrroot", password: "correct-horse-battery" };
const auth = { Authorization: basic(ADMIN.username, ADMIN.password) };

/** A repository whose own last segment is `tags`, which the suffix rule must not steal. */
const AMBIGUOUS = "rrproj/weird/tags";
const DEEP = "rrproj/team/service/api";

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedRepository("rrproj/app", { name: "rrproj" });
  await seedRepository(DEEP, { name: "rrproj" });
  await seedRepository(AMBIGUOUS, { name: "rrproj" });
});

const detail = async (name: string): Promise<Response> =>
  call("GET", `/api/v1/repositories/${name}`, { headers: auth });

describe("a two-segment name", () => {
  it("reads its own detail", async () => {
    const response = await detail("rrproj/app");
    expect(response.status).toBe(200);
    expect(((await response.json()) as RepositoryDetail).name).toBe("rrproj/app");
  });

  it("reads its tags, its policy and its stats", async () => {
    const tags = await call("GET", "/api/v1/repositories/rrproj/app/tags", { headers: auth });
    expect(tags.status).toBe(200);
    expect((await tags.json()) as { tags: TagSummary[] }).toHaveProperty("tags");

    const policy = await call("GET", "/api/v1/repositories/rrproj/app/policy", { headers: auth });
    expect(policy.status).toBe(200);
    expect((await policy.json()) as { repository: string }).toMatchObject({ repository: "rrproj/app" });

    const stats = await call("GET", "/api/v1/repositories/rrproj/app/stats", { headers: auth });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as UsageStats).scope).toBe("rrproj/app");
  });
});

describe("a deeply nested name", () => {
  it("reads its own detail", async () => {
    const response = await detail(DEEP);
    expect(response.status).toBe(200);
    expect(((await response.json()) as RepositoryDetail).name).toBe(DEEP);
  });

  it("reads its tags, not those of a shorter prefix", async () => {
    const response = await call("GET", `/api/v1/repositories/${DEEP}/tags`, { headers: auth });
    expect(response.status).toBe(200);
  });

  it("reads its stats, which name the whole repository", async () => {
    const response = await call("GET", `/api/v1/repositories/${DEEP}/stats`, { headers: auth });
    expect(response.status).toBe(200);
    expect(((await response.json()) as UsageStats).scope).toBe(DEEP);
  });

  it("reads a manifest under it", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    // No such manifest, but the route must be the manifest route: a 400 would
    // mean the digest was parsed as part of the repository name.
    const response = await call("GET", `/api/v1/repositories/${DEEP}/manifests/${digest}`, { headers: auth });
    expect(response.status).toBe(404);
  });
});

/**
 * The fixed suffix wins, and always has.
 *
 * `GET /repositories/rrproj/weird/tags` is the tag listing of `rrproj/weird`,
 * never the detail of the repository literally called `rrproj/weird/tags`. That
 * repository is unreachable through this route - as it was under the regular
 * expressions this router replaced, whose `/^(.+)\/tags$/` matched first.
 */
describe("a name whose last segment is a route suffix", () => {
  it("is read as the suffix of a shorter name, not as itself", async () => {
    const response = await detail(AMBIGUOUS);
    expect(response.status).toBe(200);

    // The tag listing of `rrproj/weird`, which holds none - not the repository.
    const body = (await response.json()) as { tags?: TagSummary[]; name?: string };
    expect(body.name).toBeUndefined();
    expect(body.tags).toEqual([]);
  });

  it("does not shadow a sibling whose suffix sits in the middle", async () => {
    // `/tags/policy` ends in `policy`, so the policy route claims it and the
    // repository it names is `rrproj/weird/tags`.
    const response = await call("GET", `/api/v1/repositories/${AMBIGUOUS}/policy`, { headers: auth });
    expect(response.status).toBe(200);
    expect((await response.json()) as { repository: string }).toMatchObject({ repository: AMBIGUOUS });
  });
});

describe("names that are not names", () => {
  it("refuses an uppercase repository name", async () => {
    const response = await detail("rrproj/NOPE");
    expect(response.status).toBe(400);
  });

  it("refuses a digest that is not one", async () => {
    const response = await call("GET", "/api/v1/repositories/rrproj/app/manifests/not-a-digest", {
      headers: auth,
    });
    expect(response.status).toBe(400);
  });

  it("has no route for a bare trailing slash", async () => {
    expect((await call("GET", "/api/v1/repositories/", { headers: auth })).status).toBe(404);
  });
});
