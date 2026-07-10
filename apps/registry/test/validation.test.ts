/**
 * What valibot refuses, and what it says when it does.
 *
 * A refusal is an RFC 9457 problem document, whose `detail` the dashboard shows
 * to a person. These pin the sentences the schemas produce, the `errors` entries
 * that name the fields those sentences are about, and the content-type guard
 * that keeps a mutation out of a hostile page's reach.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as v from "valibot";
import { AuditQuery, LimitQuery, WindowQuery } from "../src/api/schemas.js";
import { describeIssue } from "../src/api/validate.js";
import { basic, call, problem, seedProject, seedUser } from "./helpers.js";

const ADMIN = { id: "val-root", username: "valroot", password: "correct-horse-battery" };
const auth = basic(ADMIN.username, ADMIN.password);
const json = { "Content-Type": "application/json", Authorization: auth };

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
});

async function message(response: Response): Promise<string> {
  return (await problem(response)).detail;
}

/** The sentence valibot's first complaint about `input` turns into. */
function first(schema: v.GenericSchema, input: unknown): string {
  const result = v.safeParse(schema, input);
  expect(result.success).toBe(false);
  return describeIssue(result.issues![0]!);
}

describe("describeIssue", () => {
  it("names an absent field rather than repeating valibot's phrasing", () => {
    expect(first(v.object({ email: v.string() }), {})).toBe("email is required");
  });

  it("prefixes a field's own complaint with its path", () => {
    expect(first(v.object({ n: v.number("must be a number") }), { n: "x" })).toBe("n: must be a number");
  });

  it("reaches into an array to name the rule that was wrong", () => {
    const schema = v.object({ rules: v.array(v.object({ keepLast: v.number("must be a number") })) });
    expect(first(schema, { rules: [{ keepLast: 1 }, { keepLast: "x" }] })).toBe(
      "rules.1.keepLast: must be a number",
    );
  });

  it("leaves a complaint about the body itself unprefixed, having no field to name", () => {
    expect(first(v.object({ a: v.string() }), "not an object")).toContain("Invalid type");
  });
});

describe("query parameters are clamped, not refused", () => {
  it("reads a missing, absurd or negative window as something a chart can hold", () => {
    expect(v.parse(WindowQuery, {}).days).toBe(30);
    expect(v.parse(WindowQuery, { days: "7" }).days).toBe(7);
    expect(v.parse(WindowQuery, { days: "100000" }).days).toBe(365);
    expect(v.parse(WindowQuery, { days: "abc" }).days).toBe(30);
  });

  it("never lets a negative page size through, which SQLite reads as no limit at all", () => {
    expect(v.parse(LimitQuery, { limit: "-5" }).limit).toBe(100);
    expect(v.parse(LimitQuery, { limit: "0" }).limit).toBe(100);
    expect(v.parse(LimitQuery, { limit: "5000" }).limit).toBe(500);
    expect(v.parse(AuditQuery, { limit: "-1" }).limit).toBe(50);
    expect(v.parse(AuditQuery, { limit: "9999" }).limit).toBe(200);
  });

  it("reads an empty filter as no filter", () => {
    const parsed = v.parse(AuditQuery, { actor: "", resourceType: "" });
    expect(parsed.actor).toBeUndefined();
    expect(parsed.resourceType).toBeUndefined();
  });
});

describe("the messages the dashboard shows", () => {
  it("names the field a user was created without", async () => {
    const response = await call("POST", "/api/v1/users", {
      headers: json,
      body: JSON.stringify({ username: "valnoemail", password: "a-long-password" }),
    });
    expect(response.status).toBe(400);
    expect(await message(response)).toBe("email is required");
  });

  it("names the setting that was not a boolean", async () => {
    await seedProject({ name: "valproj" });
    const response = await call("PATCH", "/api/v1/projects/valproj", {
      headers: json,
      body: JSON.stringify({ immutableTags: "yes" }),
    });
    expect(response.status).toBe(400);
    expect(await message(response)).toContain("immutableTags");
  });

  it("names the rule, the field and the offset when a regex will not compile", async () => {
    await seedProject({ name: "valclean" });
    const response = await call("PUT", "/api/v1/projects/valclean/cleanup", {
      headers: json,
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [
          { repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null },
          { repositories: "*", tags: { regex: "(unclosed" }, keepLast: 1, keepWithinDays: null },
        ],
      }),
    });
    expect(response.status).toBe(400);

    const text = await message(response);
    expect(text).toContain("rules.1.tags.regex");
    expect(text).toContain("offset");
  });

  it("says a JSON body was not JSON", async () => {
    const response = await call("POST", "/api/v1/users", { headers: json, body: "{not json" });
    expect(response.status).toBe(400);
    expect(await message(response)).toBe("body is not valid JSON");
  });
});

/**
 * `errors`, the extension member RFC 9457 gives as its own worked example.
 *
 * The `detail` above is one sentence for a person; this is the machine-readable
 * companion, so a form can mark the field each complaint belongs to instead of
 * parsing a sentence for it.
 */
describe("every field at fault is named, not only the first", () => {
  it("points a JSON Pointer at each field the body got wrong", async () => {
    const response = await call("POST", "/api/v1/users", {
      headers: json,
      body: JSON.stringify({ password: "short" }),
    });
    expect(response.status).toBe(400);

    expect((await problem(response)).errors).toEqual([
      { detail: "is required", pointer: "/username" },
      { detail: "must be at least 12 characters", pointer: "/password" },
      { detail: "is required", pointer: "/email" },
    ]);
  });

  it("reaches into an array to point at the rule that was wrong", async () => {
    await seedProject({ name: "valptr" });
    const response = await call("PUT", "/api/v1/projects/valptr/cleanup", {
      headers: json,
      body: JSON.stringify({
        enabled: true,
        schedule: "0 3 * * *",
        rules: [
          { repositories: "*", tags: {}, keepLast: 1, keepWithinDays: null },
          { repositories: "*", tags: { semver: "garbage" }, keepLast: 1, keepWithinDays: null },
        ],
      }),
    });
    expect(response.status).toBe(400);

    const [issue] = (await problem(response)).errors ?? [];
    expect(issue?.pointer).toBe("/rules/1/tags/semver");
  });

  /** A query string is not a document, so there is nothing to point into. */
  it("names a query parameter rather than pointing into a body it has not got", async () => {
    const response = await call("GET", "/api/v1/audit?resourceType=blob", {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(400);

    expect((await problem(response)).errors).toEqual([
      { detail: "is not an audited resource type", parameter: "resourceType" },
    ]);
  });
});

/**
 * `null` where a field was simply not set.
 *
 * The router this replaced read `body.x ?? fallback` throughout, so a client
 * that serialises an absent value as `null` rather than dropping the key was
 * always understood. Nothing about moving to a schema should change that.
 */
describe("an omitted field and a null one mean the same thing", () => {
  it("creates a project whose description and quota were sent as null", async () => {
    const response = await call("POST", "/api/v1/projects", {
      headers: json,
      body: JSON.stringify({ name: "valnull", visibility: null, description: null, quotaBytes: null }),
    });
    expect(response.status).toBe(201);

    const project = (await response.json()) as { visibility: string; description: string | null };
    expect(project.visibility).toBe("private");
    expect(project.description).toBeNull();
  });

  it("creates a replication rule whose optional fields were sent as null", async () => {
    await seedProject({ name: "valrepl" });
    const response = await call("POST", "/api/v1/projects/valrepl/replication", {
      headers: json,
      body: JSON.stringify({
        name: "mirror",
        direction: "push",
        remoteUrl: "https://remote.test",
        trigger: null,
        schedule: null,
        sourceRepositories: null,
        repositoryFilter: null,
        destinationNamespace: null,
        tagFilter: null,
      }),
    });
    expect(response.status).toBe(201);

    const rule = (await response.json()) as { trigger: string; repositoryFilter: string; schedule: null };
    expect(rule.trigger).toBe("manual");
    expect(rule.repositoryFilter).toBe("*");
    expect(rule.schedule).toBeNull();
  });

  it("does not file source repositories against a push rule, which subscribes to nothing", async () => {
    await seedProject({ name: "valpush" });
    const response = await call("POST", "/api/v1/projects/valpush/replication", {
      headers: json,
      body: JSON.stringify({
        name: "mirror",
        direction: "push",
        remoteUrl: "https://remote.test",
        sourceRepositories: ["library/alpine"],
      }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { sourceRepositories: string[] }).sourceRepositories).toEqual([]);
  });

  it("still refuses a quota too large to survive a round trip through SQLite", async () => {
    await seedProject({ name: "valbig" });
    const response = await call("PATCH", "/api/v1/projects/valbig", {
      headers: json,
      body: JSON.stringify({ quotaBytes: Number.MAX_SAFE_INTEGER + 2 }),
    });
    expect(response.status).toBe(400);
    expect(await message(response)).toContain("positive integer");
  });
});

/**
 * The content-type guard.
 *
 * A cross-site `<form>` can only send `text/plain`, `multipart/form-data` or
 * `application/x-www-form-urlencoded`. Requiring `application/json` is what puts
 * a cookie-authenticated mutation out of a hostile page's reach - and Hono's own
 * JSON validator will not do it, because handed `text/plain` it validates `{}`
 * instead of the body, which a schema whose fields are all optional accepts.
 */
describe("mutations must declare a JSON body", () => {
  it("refuses a form-shaped content type, and changes nothing", async () => {
    await seedProject({ name: "valcsrf" });

    const response = await call("PATCH", "/api/v1/projects/valcsrf", {
      headers: { "Content-Type": "text/plain", Authorization: auth },
      body: JSON.stringify({ immutableTags: true }),
    });
    expect(response.status).toBe(400);
    expect(await message(response)).toBe("mutations must send a JSON body");

    const row = await env.DB.prepare("SELECT immutable_tags FROM projects WHERE name = ?")
      .bind("valcsrf")
      .first<{ immutable_tags: number }>();
    expect(row?.immutable_tags).toBe(0);
  });

  it("refuses it on a route whose body is never read", async () => {
    const response = await call("POST", "/api/v1/auth/logout", {
      headers: { "Content-Type": "text/plain" },
    });
    expect(response.status).toBe(400);
  });
});

/**
 * Authorization decides before validation does.
 *
 * A caller who may not act must not be handed a tour of the schema, and a
 * refusal must not be reported as a malformed body. This is the ordering the
 * middleware chain exists to guarantee.
 */
describe("authorization runs ahead of validation", () => {
  it("refuses an outsider's nonsense body with 403, not 400", async () => {
    await seedUser({ id: "val-bob", username: "valbob", password: "bob-password-12345" });
    await seedProject({ name: "valclosed" });

    const response = await call("PATCH", "/api/v1/projects/valclosed", {
      headers: { "Content-Type": "application/json", Authorization: basic("valbob", "bob-password-12345") },
      body: JSON.stringify({ quotaBytes: "not a number" }),
    });
    expect(response.status).toBe(403);
  });

  it("refuses an anonymous caller's nonsense body with 401", async () => {
    const response = await call("POST", "/api/v1/users", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(response.status).toBe(401);
  });

  it("does not let a bad query parameter answer ahead of the refusal", async () => {
    // `resourceType` is a closed set. Were it validated first, a caller who may
    // not read the audit log could tell a valid value from an invalid one by
    // watching 400 where they should always see 403 - a schema oracle.
    await seedUser({ id: "val-eve", username: "valeve", password: "eve-password-12345" });
    const eve = basic("valeve", "eve-password-12345");

    const bad = await call("GET", "/api/v1/audit?resourceType=blob", { headers: { Authorization: eve } });
    expect(bad.status).toBe(403);

    const good = await call("GET", "/api/v1/audit?resourceType=project", { headers: { Authorization: eve } });
    expect(good.status).toBe(403);

    // The administrator still gets the 400 the parameter deserves.
    const admin = await call("GET", "/api/v1/audit?resourceType=blob", { headers: { Authorization: auth } });
    expect(admin.status).toBe(400);
  });
});
