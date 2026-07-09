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

  it("turns an error body into an ApiError carrying the status", async () => {
    mockFetch({ status: 403, body: { error: "forbidden", message: "nope" } });

    await expect(api.stats()).rejects.toBeInstanceOf(ApiError);
    await expect(api.stats()).rejects.toMatchObject({ status: 403, code: "forbidden", message: "nope" });
  });

  it("recognises an unauthenticated response", async () => {
    mockFetch({ status: 401, body: { error: "unauthorized", message: "authentication required" } });

    const error = await api.session().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isUnauthenticated).toBe(true);
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
