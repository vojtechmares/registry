import { describe, expect, it } from "vitest";
import { formatAccessToken } from "../src/auth/password.js";
import { verifiesPassword } from "../src/rate-limit.js";

function withAuth(header?: string): Request {
  return new Request("https://registry.test/v2/myorg/app/tags/list", {
    headers: header === undefined ? {} : { Authorization: header },
  });
}

const basic = (username: string, password: string) => `Basic ${btoa(`${username}:${password}`)}`;

describe("verifiesPassword", () => {
  it("prices the endpoints that take a password from the body", () => {
    expect(verifiesPassword(withAuth(), "/v2/token")).toBe(true);
    expect(verifiesPassword(withAuth(), "/api/v1/auth/login")).toBe(true);
  });

  it("prices Basic credentials on any endpoint, not just the token endpoint", () => {
    // Otherwise a password could be guessed against a tag listing at one
    // rate-limit token per attempt while costing the registry a full PBKDF2.
    expect(verifiesPassword(withAuth(basic("alice", "hunter2")), "/v2/myorg/app/tags/list")).toBe(true);
  });

  it("leaves a machine token at the ordinary price: it costs one SHA-256", () => {
    const token = formatAccessToken("abc123", "s3cret_with_underscore");
    expect(verifiesPassword(withAuth(basic("x", token)), "/v2/myorg/app/tags/list")).toBe(false);
  });

  it("leaves a bearer token at the ordinary price: it costs one HMAC", () => {
    expect(verifiesPassword(withAuth("Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig"), "/v2/")).toBe(false);
  });

  it("charges nothing extra for an anonymous request", () => {
    expect(verifiesPassword(withAuth(), "/v2/myorg/app/tags/list")).toBe(false);
  });

  it("does not charge for credentials so malformed they never reach PBKDF2", () => {
    expect(verifiesPassword(withAuth("Basic !!!not-base64!!!"), "/v2/")).toBe(false);
    expect(verifiesPassword(withAuth("Basic"), "/v2/")).toBe(false);
  });
});
