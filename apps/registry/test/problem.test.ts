/**
 * The shape of every refusal.
 *
 * The management API answers a failure with an RFC 9457 problem document, and
 * the dashboard, the OpenAPI document and any script driving the API all read
 * the same five members. These pin them.
 */

import { manifestTooLarge } from "@registry/oci";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/api/context.js";
import { onError } from "../src/api/problem.js";
import { basic, call, problem, seedProject, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "prob-root", username: "probroot", password: "correct-horse-battery" };
const OUTSIDER = { id: "prob-eve", username: "probeve", password: "eve-password-12345" };

const auth = basic(ADMIN.username, ADMIN.password);
const json = { "Content-Type": "application/json", Authorization: auth };

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedUser(OUTSIDER);
  await seedProject({ name: "probpriv", visibility: "private" });
  await seedRepository("probpriv/app");
});

describe("a refusal is a problem document", () => {
  it("is served under the media type RFC 9457 registers", async () => {
    const response = await call("GET", "/api/v1/projects/probmissing", { headers: { Authorization: auth } });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });

  it("carries the type, its title, the status, the detail and the instance", async () => {
    const response = await call("GET", "/api/v1/projects/probmissing", { headers: { Authorization: auth } });

    expect(await problem(response)).toEqual({
      type: "https://registry.mareshq.com/problems/not-found",
      title: "Not found",
      status: 404,
      detail: 'project "probmissing" does not exist',
      instance: "/api/v1/projects/probmissing",
    });
  });

  /**
   * A `type` identifies a problem this software defines, so it is the same string
   * whichever host answered. A relative reference would have resolved against the
   * origin instead, and two deployments would disagree about what a refusal was.
   */
  it("names a type that does not depend on the host that served it", async () => {
    const response = await call("GET", "https://elsewhere.example/api/v1/projects/probmissing", {
      headers: { Authorization: auth },
    });

    const body = await problem(response);
    expect(body.type).toBe("https://registry.mareshq.com/problems/not-found");
    expect(body.instance).toBe("/api/v1/projects/probmissing");
  });

  it("gives an unauthenticated caller the type that says so", async () => {
    const response = await call("GET", "/api/v1/users");
    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({
      type: "https://registry.mareshq.com/problems/unauthorized",
      title: "Authentication required",
      detail: "authentication required",
    });
  });

  it("says nothing about `errors` when no field was at fault", async () => {
    const response = await call("POST", "/api/v1/users", { headers: json, body: "{not json" });
    expect(response.status).toBe(400);

    const body = await problem(response);
    expect(body.detail).toBe("body is not valid JSON");
    expect(body.errors).toBeUndefined();
  });
});

/**
 * The authorization code the two planes share raises the distribution spec's
 * errors, not this catalogue's. They are mapped by the status they meant, and the
 * OCI code rides along so a log can be read across both planes.
 */
describe("a refusal from the shared authorization code", () => {
  it("becomes a problem, keeping the distribution spec's code", async () => {
    const response = await call("GET", "/api/v1/repositories/probpriv/app/tags", {
      headers: { Authorization: basic(OUTSIDER.username, OUTSIDER.password) },
    });
    expect(response.status).toBe(403);

    expect(await problem(response)).toMatchObject({
      type: "https://registry.mareshq.com/problems/forbidden",
      title: "Forbidden",
      status: 403,
      code: "DENIED",
      instance: "/api/v1/repositories/probpriv/app/tags",
    });
  });

  /**
   * Its `WWW-Authenticate` challenge points at the registry's bearer realm, which
   * is where a `docker` client goes to exchange credentials. A browser holding the
   * dashboard's cookie has nowhere to take it, so it is not forwarded.
   */
  it("does not forward the registry's challenge to the dashboard", async () => {
    const response = await call("GET", "/api/v1/repositories/probpriv/app/tags");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await problem(response)).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });
});

/** `onError` reached directly, for the two refusals no route can currently produce. */
describe("what onError does with what it cannot name", () => {
  const context = { req: { path: "/api/v1/somewhere" } } as unknown as ApiContext;

  /**
   * A status outside the catalogue keeps the status it meant. Answering 500
   * would throw away the only thing such a refusal was carrying.
   */
  it("answers about:blank for a status it has no type for", async () => {
    const response = onError(manifestTooLarge(4_000_000), context);
    expect(response.status).toBe(413);

    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Request failed",
      status: 413,
      detail: "manifest exceeds the maximum size of 4000000 bytes",
      instance: "/api/v1/somewhere",
      code: "MANIFEST_INVALID",
    });
  });

  /** A bug is logged, never described to the caller: its message is not a contract. */
  it("tells a caller nothing about an error nobody meant to raise", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = onError(new Error("connection string: postgres://root:hunter2@db"), context);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      type: "https://registry.mareshq.com/problems/internal-error",
      title: "Internal server error",
      status: 500,
      detail: "internal server error",
      instance: "/api/v1/somewhere",
    });
  });
});
