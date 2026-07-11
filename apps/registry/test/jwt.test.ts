/**
 * The registry's HS256 JWTs, now signed and verified with `jose`.
 *
 * The tests pin external accept/reject behaviour rather than library internals,
 * and one pair proves the wire format is unchanged: a token in the pre-swap
 * format (reproduced here) verifies under the new verifier, and a token the new
 * code mints verifies under the pre-swap verifier - so a deploy keeps in-flight
 * tokens valid.
 */

import { describe, expect, it } from "vitest";
import { type RegistryClaims, signJwt, verifyJwt } from "../src/auth/jwt.js";

const SECRET = "test-jwt-secret-not-for-production";
const EXPECTED = { issuer: "registry", audience: "registry-service" };
const NOW = Date.parse("2026-07-10T00:00:00Z");
const SECONDS = Math.floor(NOW / 1000);

function claims(overrides: Partial<RegistryClaims> = {}): RegistryClaims {
  return {
    sub: "user-1",
    name: "alice",
    admin: false,
    access: [{ type: "repository", name: "acme/api", actions: ["pull"] }],
    iss: EXPECTED.issuer,
    aud: EXPECTED.audience,
    iat: SECONDS,
    nbf: SECONDS,
    exp: SECONDS + 300,
    jti: "jti-1",
    ...overrides,
  };
}

/* -- The pre-swap wire format, reproduced so the swap can be proven compatible. -- */

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The exact HS256 framing the hand-rolled predecessor produced. */
async function legacySign(payloadObject: RegistryClaims, secret: string): Promise<string> {
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(payloadObject)));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** The hand-rolled predecessor's verification, kept only to prove compatibility. */
async function legacyVerify(
  token: string,
  secret: string,
  expected: { issuer: string; audience: string },
  now: number,
): Promise<RegistryClaims | null> {
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return null;
  const decodedHeader = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/"))) as { alg?: string };
  if (decodedHeader.alg !== "HS256") return null;

  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!ok) return null;

  const claimSet = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as RegistryClaims;
  const seconds = Math.floor(now / 1000);
  if (claimSet.exp <= seconds) return null;
  if (claimSet.nbf > seconds + 60) return null;
  if (claimSet.iss !== expected.issuer || claimSet.aud !== expected.audience) return null;
  return claimSet;
}

describe("signJwt / verifyJwt", () => {
  it("round-trips a valid token", async () => {
    const token = await signJwt(claims(), SECRET);
    expect(await verifyJwt(token, SECRET, EXPECTED, NOW)).toMatchObject({
      sub: "user-1",
      name: "alice",
      access: [{ type: "repository", name: "acme/api", actions: ["pull"] }],
    });
  });

  it("rejects a tampered signature", async () => {
    const token = await signJwt(claims(), SECRET);
    const last = token.at(-1);
    const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(await verifyJwt(tampered, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signJwt(claims(), "some-other-secret");
    expect(await verifyJwt(token, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signJwt(claims({ exp: SECONDS - 120 }), SECRET);
    expect(await verifyJwt(token, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects a not-yet-valid token", async () => {
    const token = await signJwt(claims({ nbf: SECONDS + 600 }), SECRET);
    expect(await verifyJwt(token, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects the wrong issuer and the wrong audience", async () => {
    expect(await verifyJwt(await signJwt(claims({ iss: "evil" }), SECRET), SECRET, EXPECTED, NOW)).toBeNull();
    expect(await verifyJwt(await signJwt(claims({ aud: "evil" }), SECRET), SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects alg: none, whatever the body says", async () => {
    const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })));
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims())));
    expect(await verifyJwt(`${header}.${payload}.`, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("rejects an RS256 header even when the body is HMAC-signed with the secret", async () => {
    // Algorithm confusion: the header claims RS256, the signature is a valid HMAC
    // over the secret. Pinning the accepted algorithm to HS256 rejects it on the
    // header alone, before any signature is checked.
    const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims())));
    const signature = base64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await hmacKey(SECRET),
          new TextEncoder().encode(`${header}.${payload}`),
        ),
      ),
    );
    expect(await verifyJwt(`${header}.${payload}.${signature}`, SECRET, EXPECTED, NOW)).toBeNull();
  });

  it("preserves the confinement claims that are not part of RegistryClaims", async () => {
    const confined = {
      ...claims(),
      scopes: [{ repository: "acme/api", actions: ["pull"] }],
      project: "acme",
      tokenId: "tok-1",
    } as RegistryClaims;
    const verified = (await verifyJwt(await signJwt(confined, SECRET), SECRET, EXPECTED, NOW)) as
      | (RegistryClaims & { project?: string; tokenId?: string })
      | null;
    expect(verified?.project).toBe("acme");
    expect(verified?.tokenId).toBe("tok-1");
  });
});

describe("cross-implementation wire-format compatibility", () => {
  it("verifies a token minted in the pre-swap wire format", async () => {
    const token = await legacySign(claims(), SECRET);
    expect(await verifyJwt(token, SECRET, EXPECTED, NOW)).toMatchObject({ sub: "user-1", name: "alice" });
  });

  it("mints a token the pre-swap verifier accepts", async () => {
    const token = await signJwt(claims(), SECRET);
    expect(await legacyVerify(token, SECRET, EXPECTED, NOW)).toMatchObject({ sub: "user-1", name: "alice" });
  });
});
