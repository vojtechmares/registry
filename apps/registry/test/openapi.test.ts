/**
 * The published contract.
 *
 * A route that is not in the document may as well not exist, so this asserts the
 * document actually describes the API rather than merely being served.
 */

import { describe, expect, it } from "vitest";
import { call } from "./helpers.js";

interface Operation {
  summary?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, unknown>;
}

interface Spec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
}

async function spec(): Promise<Spec> {
  const response = await call("GET", "/api/v1/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as Spec;
}

describe("the OpenAPI document", () => {
  it("is served, and is an OpenAPI 3.1 document", async () => {
    const document = await spec();
    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.info.title).toBe("Registry management API");
  });

  it("declares the three ways a caller proves who they are", async () => {
    const { components } = await spec();
    expect(Object.keys(components.securitySchemes ?? {}).toSorted()).toEqual(["basic", "bearer", "session"]);
  });

  it("describes every route the management API answers", async () => {
    const { paths } = await spec();

    // A representative path from each router, including the ones whose
    // parameters span slashes.
    for (const path of [
      "/api/v1/auth/login",
      "/api/v1/auth/session",
      "/api/v1/stats",
      "/api/v1/audit",
      "/api/v1/users",
      "/api/v1/users/{id}",
      "/api/v1/tokens",
      "/api/v1/projects",
      "/api/v1/projects/{project}",
      "/api/v1/projects/{project}/members/{userId}",
      "/api/v1/projects/{project}/cleanup",
      "/api/v1/projects/{project}/tokens/{id}",
      "/api/v1/projects/{project}/notifications",
      "/api/v1/projects/{project}/replication/{id}",
      "/api/v1/repositories",
      "/api/v1/repositories/{name}",
      "/api/v1/repositories/{name}/tags",
      "/api/v1/repositories/{name}/manifests/{digest}",
    ]) {
      expect(paths[path], path).toBeDefined();
    }
  });

  it("does not document the document, nor the page that renders it", async () => {
    const { paths } = await spec();
    expect(paths["/api/v1/openapi.json"]).toBeUndefined();
    expect(paths["/api/v1/docs"]).toBeUndefined();
  });

  it("gives every route a summary, a tag and the rate-limit refusal", async () => {
    const { paths } = await spec();
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(operation.summary, where).toBeTruthy();
        expect(operation.tags?.length, where).toBeGreaterThan(0);
        expect(operation.responses["429"], where).toBeDefined();
      }
    }
  });

  /**
   * A client that reads `application/json` off a refusal and finds a problem
   * document has been misled by the document, not by the API.
   */
  it("declares every refusal as a problem document, never as plain JSON", async () => {
    const { paths } = await spec();

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;

          const where = `${method.toUpperCase()} ${path} -> ${status}`;
          const content = (response as { content?: Record<string, unknown> }).content ?? {};
          expect(Object.keys(content), where).toEqual(["application/problem+json"]);
        }
      }
    }
  });

  it("describes the members a problem document carries", async () => {
    const { paths } = await spec();
    const refusal = paths["/api/v1/audit"]?.get?.responses["401"] as {
      content: Record<string, { schema: { properties?: Record<string, unknown>; required?: string[] } }>;
    };

    const schema = refusal.content["application/problem+json"]?.schema;
    expect(schema?.required?.toSorted()).toEqual(["detail", "instance", "status", "title", "type"]);
    expect(schema?.properties).toHaveProperty("errors");
  });

  it("marks the sign-in routes public and everything else authenticated", async () => {
    const { paths } = await spec();
    expect(paths["/api/v1/auth/login"]?.post?.security).toBeUndefined();
    expect(paths["/api/v1/auth/providers"]?.get?.security).toBeUndefined();

    const audit = paths["/api/v1/audit"]?.get;
    expect(audit?.security).toEqual([{ basic: [] }, { bearer: [] }, { session: [] }]);
    expect(audit?.responses["401"]).toBeDefined();
  });

  it("carries the request body schema valibot validates against", async () => {
    const { paths } = await spec();
    const body = paths["/api/v1/users"]?.post?.requestBody?.content["application/json"]?.schema as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(body.type).toBe("object");
    expect(body.required.toSorted()).toEqual(["email", "password", "username"]);

    // A field a caller may omit, or send as `null`, and which then defaults.
    expect(body.properties.isAdmin).toEqual({
      anyOf: [{ type: "boolean" }, { type: "null" }],
      default: false,
    });
  });

  it("documents a path parameter for each segment of a slashy route", async () => {
    const { paths } = await spec();
    const names = paths["/api/v1/repositories/{name}/manifests/{digest}"]?.get?.parameters?.map(
      (p) => p.name,
    );
    expect(names?.toSorted()).toEqual(["digest", "name"]);
  });

  it("publishes the enums the API actually enforces", async () => {
    const { paths } = await spec();
    const member = paths["/api/v1/projects/{project}/members"]?.post?.requestBody?.content["application/json"]
      ?.schema as { properties: { role: { enum: string[] } } };

    expect(member.properties.role.enum).toEqual(["guest", "developer", "maintainer", "owner"]);
  });
});

describe("Swagger UI", () => {
  it("is served as a page that loads the document", async () => {
    const response = await call("GET", "/api/v1/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");

    const html = await response.text();
    expect(html).toContain("/api/v1/openapi.json");
    expect(html).toContain("swagger-ui");
  });
});

describe("unknown management routes", () => {
  it("answer with the problem document the dashboard parses", async () => {
    const response = await call("GET", "/api/v1/nonexistent");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await response.json()).toEqual({
      type: "https://registry.mareshq.com/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "not found",
      instance: "/api/v1/nonexistent",
    });
  });
});
