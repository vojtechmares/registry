import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

function mockFetch(response: Partial<{ status: number; body: unknown; text: string }> = {}) {
  const status = response.status ?? 200;
  const text = response.text ?? (response.body === undefined ? "" : JSON.stringify(response.body));

  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    text: () => Promise.resolve(text),
  } as Response);

  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("sends the session cookie on same-origin requests", async () => {
    const fetchSpy = mockFetch({ body: { repositories: [] } });
    await api.repositories();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  it("declares a JSON content type on mutations, which the API requires against CSRF", async () => {
    const fetchSpy = mockFetch({ body: { id: "1", username: "root", isAdmin: true } });
    await api.login("root", "hunter2hunter2");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ username: "root", password: "hunter2hunter2" }));
  });

  it("keeps slashes in a repository name as path separators", async () => {
    const fetchSpy = mockFetch({ body: { name: "a/b/c" } });
    await api.repository("a/b/c");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/v1/repositories/a/b/c");
  });

  it("escapes a digest, whose colon must not be read as a scheme", async () => {
    const fetchSpy = mockFetch({ body: {} });
    await api.manifest("a/b", "sha256:abc");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/v1/repositories/a/b/manifests/sha256%3Aabc");
  });

  it("turns a problem document into an ApiError carrying the status", async () => {
    mockFetch({
      status: 403,
      body: {
        type: "https://registry.mareshq.com/problems/forbidden",
        title: "Forbidden",
        status: 403,
        detail: "nope",
        instance: "/api/v1/stats",
      },
    });

    await expect(api.stats()).rejects.toBeInstanceOf(ApiError);
    await expect(api.stats()).rejects.toMatchObject({
      status: 403,
      type: "https://registry.mareshq.com/problems/forbidden",
      title: "Forbidden",
      // The `detail` is the sentence a person is shown, so it is what `message` holds.
      message: "nope",
    });
  });

  it("recognises an unauthenticated response", async () => {
    mockFetch({
      status: 401,
      body: {
        type: "https://registry.mareshq.com/problems/unauthorized",
        title: "Authentication required",
        status: 401,
        detail: "authentication required",
        instance: "/api/v1/auth/session",
      },
    });

    const error = await api.session().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthenticated).toBe(true);
  });

  /**
   * A refusal that never reached the Worker - a proxy's HTML page, a dropped
   * connection - is still a refusal the dashboard has to report. The status is
   * what it acts on, so a body it cannot read must not become a parse error.
   */
  it("still raises an ApiError when the body is not a problem document", async () => {
    mockFetch({ status: 502, text: "<html>Bad Gateway</html>" });

    const error = await api.stats().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).type).toBe("about:blank");
  });

  it("tolerates a 204 with no body", async () => {
    mockFetch({ status: 204 });
    await expect(api.revokeToken("abc")).resolves.toBeUndefined();
  });

  it("unwraps list envelopes so callers see plain arrays", async () => {
    mockFetch({ body: { tokens: [{ id: "1" }] } });
    await expect(api.tokens()).resolves.toEqual([{ id: "1" }]);
  });

  it("omits the search parameter when nothing is being searched for", async () => {
    const fetchSpy = mockFetch({ body: { repositories: [] } });
    await api.repositories("");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/v1/repositories");

    await api.repositories("my org");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/v1/repositories?search=my%20org");
  });
});

describe("project endpoints", () => {
  it("lists projects and unwraps the envelope", async () => {
    const fetchSpy = mockFetch({ body: { projects: [{ name: "acme" }] } });
    const projects = await api.projects();

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("/api/v1/projects");
    expect(projects).toEqual([{ name: "acme" }]);
  });

  it("patches only the settings it was given", async () => {
    const fetchSpy = mockFetch({ body: { name: "acme" } });
    await api.updateProject("acme", { visibility: "public" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/projects/acme");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ visibility: "public" }));
  });

  it("sets a member's role by user id", async () => {
    const fetchSpy = mockFetch({ body: { project: "acme", userId: "u1", role: "developer" } });
    await api.setMember("acme", "u1", "developer");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/projects/acme/members/u1");
    expect(init.method).toBe("PUT");
  });

  it("requests project usage over a window", async () => {
    const fetchSpy = mockFetch({ body: { scope: "acme", days: 7 } });
    await api.projectStats("acme", 7);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("/api/v1/projects/acme/stats?days=7");
  });

  it("reads whether single sign-on is available", async () => {
    const fetchSpy = mockFetch({ body: { password: true, oidc: true } });
    const providers = await api.providers();

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("/api/v1/auth/providers");
    expect(providers.oidc).toBe(true);
  });

  // The dashboard never learns user ids: `GET /users` is admin-only, so an owner
  // adds a member by the name they know them by and the registry resolves it.
  it("adds a member by username, against the collection", async () => {
    const fetchSpy = mockFetch({
      status: 201,
      body: { project: "acme", userId: "u1", username: "bob", role: "developer" },
    });
    const member = await api.addMember("acme", "bob", "developer");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/projects/acme/members");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ username: "bob", role: "developer" }));
    expect(member.userId).toBe("u1");
  });

  it("escapes a project name in every path it appears in", async () => {
    const fetchSpy = mockFetch({ status: 204 });
    await api.deleteNotification("a b", "id/1");

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("/api/v1/projects/a%20b/notifications/id%2F1");
  });

  it("unwraps the notification and replication envelopes", async () => {
    mockFetch({ body: { policies: [{ id: "n1" }] } });
    await expect(api.notifications("acme")).resolves.toEqual([{ id: "n1" }]);

    mockFetch({ body: { rules: [{ id: "r1" }] } });
    await expect(api.replicationRules("acme")).resolves.toEqual([{ id: "r1" }]);
  });

  it("reads the delivery log and the execution history, bounded", async () => {
    const fetchSpy = mockFetch({ body: { deliveries: [] } });
    await api.deliveries("acme");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/v1/projects/acme/deliveries?limit=50");

    const executionSpy = mockFetch({ body: { executions: [] } });
    await api.executions("acme", 10);
    expect(executionSpy.mock.calls[0]?.[0]).toBe("/api/v1/projects/acme/executions?limit=10");
  });

  it("runs a replication rule now", async () => {
    const fetchSpy = mockFetch({ status: 202, body: { queued: true } });
    await api.runReplicationRule("acme", "r1");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/projects/acme/replication/r1");
    expect(init.method).toBe("POST");
  });
});
