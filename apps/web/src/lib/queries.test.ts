import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { invalidate, keys } from "./queries";

function fakeClient(): QueryClient {
  return { invalidateQueries: vi.fn() } as unknown as QueryClient;
}

function invalidatedKeys(client: QueryClient): unknown[] {
  return (
    client.invalidateQueries as unknown as { mock: { calls: [{ queryKey: unknown }][] } }
  ).mock.calls.map(([arg]) => arg.queryKey);
}

describe("query keys", () => {
  it("are stable tuples, so caching does not change", () => {
    expect(keys.cleanup("acme")).toEqual(["cleanup", "acme"]);
    expect(keys.projectTokens("acme")).toEqual(["project-tokens", "acme"]);
    expect(keys.repositories("foo")).toEqual(["repositories", "foo"]);
    expect(keys.manifest("acme/api", "sha256:abc")).toEqual(["manifest", "acme/api", "sha256:abc"]);
  });
});

describe("invalidation edges", () => {
  it("a token mutation refreshes both the project's tokens and the account-wide list", () => {
    const client = fakeClient();
    invalidate.tokens(client, "acme");
    expect(invalidatedKeys(client)).toEqual([["project-tokens", "acme"], ["tokens"]]);
  });

  it("a project mutation refreshes its detail and the list it sits in", () => {
    const client = fakeClient();
    invalidate.project(client, "acme");
    expect(invalidatedKeys(client)).toEqual([["project", "acme"], ["projects"]]);
  });

  it("a membership change refreshes only the project detail", () => {
    const client = fakeClient();
    invalidate.projectMembers(client, "acme");
    expect(invalidatedKeys(client)).toEqual([["project", "acme"]]);
  });

  it("a webhook mutation refreshes the policy list and its delivery log", () => {
    const client = fakeClient();
    invalidate.notifications(client, "acme");
    expect(invalidatedKeys(client)).toEqual([
      ["notifications", "acme"],
      ["deliveries", "acme"],
    ]);
  });

  it("a replication mutation refreshes the rule list and its run log", () => {
    const client = fakeClient();
    invalidate.replication(client, "acme");
    expect(invalidatedKeys(client)).toEqual([
      ["replication", "acme"],
      ["executions", "acme"],
    ]);
  });

  it("a deleted repository sweeps the whole search family by its shared prefix", () => {
    const client = fakeClient();
    invalidate.repositories(client);
    expect(invalidatedKeys(client)).toEqual([["repositories"]]);
  });
});
