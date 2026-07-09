import { beforeAll, describe, expect, it } from "vitest";
import { base64UrlEncode, codeChallengeOf, createAuthorizationRequest, timingSafeEqual } from "./pkce.js";
import { type Jwk, verifyIdToken } from "./verify.js";

const ISSUER = "https://idp.test";
const CLIENT_ID = "registry";
const NONCE = "the-nonce";
const NOW = Date.parse("2026-07-10T00:00:00Z");

function encode(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** Mints a real RS256 token, so the verifier is exercised against actual crypto. */
async function makeSigner() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  const key: Jwk = { ...jwk, kid: "key-1", use: "sig", alg: "RS256" };

  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = encode({ alg: "RS256", kid: "key-1", typ: "JWT", ...header });
    const body = encode(claims);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
  };

  return { key, sign };
}

async function makeEs256Signer() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  const key: Jwk = { ...jwk, kid: "ec-1", use: "sig" };

  const sign = async (claims: Record<string, unknown>) => {
    const head = encode({ alg: "ES256", kid: "ec-1", typ: "JWT" });
    const body = encode(claims);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`),
    );
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
  };

  return { key, sign };
}

const validClaims = {
  iss: ISSUER,
  sub: "user-123",
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 300,
  iat: Math.floor(NOW / 1000),
  nonce: NONCE,
  email: "alice@example.com",
  preferred_username: "alice",
};

const options = { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE, now: NOW };

let signer: Awaited<ReturnType<typeof makeSigner>>;
beforeAll(async () => {
  signer = await makeSigner();
});

describe("verifyIdToken", () => {
  it("accepts a well-formed RS256 token", async () => {
    const result = await verifyIdToken(await signer.sign(validClaims), [signer.key], options);
    expect(result).toMatchObject({ ok: true, claims: { sub: "user-123" } });
  });

  it("accepts a well-formed ES256 token", async () => {
    const ec = await makeEs256Signer();
    const result = await verifyIdToken(await ec.sign(validClaims), [ec.key], options);
    expect(result.ok).toBe(true);
  });

  it("rejects a token signed with a different key", async () => {
    const other = await makeSigner();
    const result = await verifyIdToken(await other.sign(validClaims), [signer.key], options);
    expect(result).toEqual({ ok: false, reason: "signature does not verify" });
  });

  it("rejects `alg: none`, whatever the header says", async () => {
    // The header names the algorithm; the key decides it. An unsigned token has
    // no signature to check, and so cannot pass.
    const head = encode({ alg: "none", typ: "JWT" });
    const body = encode(validClaims);
    const result = await verifyIdToken(`${head}.${body}.`, [signer.key], options);
    expect(result.ok).toBe(false);
  });

  it("rejects a token whose header claims HMAC signed with the public key", async () => {
    // The classic confusion attack: the verifier is told to use HMAC, and the
    // public key - which anybody has - becomes the shared secret.
    const head = encode({ alg: "HS256", kid: "key-1", typ: "JWT" });
    const body = encode(validClaims);
    const secret = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JSON.stringify(signer.key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", secret, new TextEncoder().encode(`${head}.${body}`));
    const forged = `${head}.${body}.${base64UrlEncode(new Uint8Array(mac))}`;

    expect((await verifyIdToken(forged, [signer.key], options)).ok).toBe(false);
  });

  it("rejects a token from another issuer", async () => {
    const token = await signer.sign({ ...validClaims, iss: "https://evil.test" });
    expect(await verifyIdToken(token, [signer.key], options)).toEqual({
      ok: false,
      reason: "issued by someone else",
    });
  });

  it("rejects a token issued for another client", async () => {
    const token = await signer.sign({ ...validClaims, aud: "someone-else" });
    expect(await verifyIdToken(token, [signer.key], options)).toEqual({
      ok: false,
      reason: "issued for another client",
    });
  });

  it("accepts an audience array that contains us", async () => {
    const token = await signer.sign({ ...validClaims, aud: ["other", CLIENT_ID] });
    expect((await verifyIdToken(token, [signer.key], options)).ok).toBe(true);
  });

  it("rejects an audience array that does not", async () => {
    const token = await signer.sign({ ...validClaims, aud: ["other", "another"] });
    expect((await verifyIdToken(token, [signer.key], options)).ok).toBe(false);
  });

  it("rejects an expired token, and tolerates a little clock skew", async () => {
    const expired = await signer.sign({ ...validClaims, exp: Math.floor(NOW / 1000) - 3600 });
    expect(await verifyIdToken(expired, [signer.key], options)).toEqual({ ok: false, reason: "expired" });

    const justExpired = await signer.sign({ ...validClaims, exp: Math.floor(NOW / 1000) - 30 });
    expect((await verifyIdToken(justExpired, [signer.key], options)).ok).toBe(true);
  });

  it("rejects a token issued in the future", async () => {
    const token = await signer.sign({ ...validClaims, iat: Math.floor(NOW / 1000) + 3600 });
    expect(await verifyIdToken(token, [signer.key], options)).toEqual({
      ok: false,
      reason: "issued in the future",
    });
  });

  it("rejects a token whose nonce does not match the flow we started", async () => {
    const token = await signer.sign({ ...validClaims, nonce: "somebody-else's-nonce" });
    expect(await verifyIdToken(token, [signer.key], options)).toEqual({
      ok: false,
      reason: "nonce does not match",
    });
  });

  it("rejects a token with no nonce at all", async () => {
    const { nonce, ...withoutNonce } = validClaims;
    void nonce;
    expect((await verifyIdToken(await signer.sign(withoutNonce), [signer.key], options)).ok).toBe(false);
  });

  it("rejects a token with no subject", async () => {
    const token = await signer.sign({ ...validClaims, sub: "" });
    expect(await verifyIdToken(token, [signer.key], options)).toEqual({ ok: false, reason: "no subject" });
  });

  it("rejects a malformed token rather than throwing", async () => {
    for (const token of ["", "a.b", "a.b.c.d", "not-a-token"]) {
      expect((await verifyIdToken(token, [signer.key], options)).ok).toBe(false);
    }
  });

  it("tries every key when the token names none, as a provider mid-rotation does", async () => {
    const other = await makeSigner();
    const token = await signer.sign(validClaims, { kid: undefined });
    expect((await verifyIdToken(token, [other.key, signer.key], options)).ok).toBe(true);
  });

  it("refuses a key set it cannot use", async () => {
    const octet: Jwk = { kty: "oct", kid: "key-1" };
    expect(await verifyIdToken(await signer.sign(validClaims), [octet], options)).toEqual({
      ok: false,
      reason: "no usable signing key",
    });
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge from the verifier", async () => {
    // The RFC 7636 test vector.
    const challenge = await codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("mints a distinct state, nonce and verifier every time", async () => {
    const a = await createAuthorizationRequest();
    const b = await createAuthorizationRequest();

    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(a.nonce);
    expect(a.codeChallenge).toBe(await codeChallengeOf(a.codeVerifier));
  });

  it("produces a verifier within the length the RFC allows", async () => {
    const { codeVerifier } = await createAuthorizationRequest();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("timingSafeEqual", () => {
  it("compares equal and unequal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
