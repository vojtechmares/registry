/**
 * Verifying an ID token, on `jose`.
 *
 * The accepted algorithms are pinned to the two every provider offers, so a
 * token that names `none`, or names HMAC to have its signature checked with the
 * public key as the shared secret, is refused before any crypto runs - the same
 * invariant the hand-rolled predecessor asserted, now on an audited verifier.
 * The key is chosen from the provider's JWKS by `kid`, and `jose` checks the
 * signature and every registered claim; the nonce - which binds the token to the
 * flow this registry started - it does not know, so that is checked here.
 */

import {
  type JWK,
  type JWTPayload,
  decodeProtectedHeader,
  errors as joseErrors,
  importJWK,
  jwtVerify,
} from "jose";

export type Algorithm = "RS256" | "ES256";

export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

export interface IdTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly iat: number;
  readonly nonce?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly preferred_username?: string;
  readonly name?: string;
  readonly groups?: string[];
}

/** Only the two algorithms every provider offers. Anything else is refused rather than guessed at. */
function algorithmOf(jwk: Jwk): Algorithm | null {
  if (jwk.kty === "RSA") return "RS256";
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  return null;
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  /** Tolerance for a provider whose clock disagrees with ours. */
  readonly clockSkewSeconds?: number;
  readonly now?: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: IdTokenClaims }
  | { readonly ok: false; readonly reason: string };

/** Turns `jose`'s failure into the reason the predecessor reported for the same fault. */
function reasonFor(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return "expired";
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    if (error.claim === "iss") return "issued by someone else";
    if (error.claim === "aud") return "issued for another client";
  }
  return "signature does not verify";
}

/**
 * Checks the signature, then every claim that decides whether this token is
 * about the right person, from the right provider, for us, right now, and in
 * answer to the flow we started.
 */
export async function verifyIdToken(
  token: string,
  keys: readonly Jwk[],
  options: VerifyOptions,
): Promise<VerifyResult> {
  if (token.split(".").length !== 3) return { ok: false, reason: "malformed token" };

  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    kid = typeof header.kid === "string" ? header.kid : undefined;
  } catch {
    return { ok: false, reason: "malformed header" };
  }

  // The `kid` narrows which key to try; a token that names no key - a provider
  // mid-rotation legitimately sends one - is checked against all of them.
  const usable = keys.filter((key) => algorithmOf(key) !== null);
  const candidates = kid === undefined ? usable : usable.filter((key) => key.kid === kid);
  if (candidates.length === 0) return { ok: false, reason: "no usable signing key" };

  const skew = options.clockSkewSeconds ?? 60;
  const nowMs = options.now ?? Date.now();
  const verifyOptions = {
    algorithms: ["RS256", "ES256"],
    issuer: options.issuer,
    audience: options.clientId,
    clockTolerance: skew,
    currentDate: new Date(nowMs),
  };

  let payload: JWTPayload | null = null;
  let lastError: unknown = null;
  for (const jwk of candidates) {
    let key: CryptoKey | Uint8Array;
    try {
      key = await importJWK(jwk as JWK, algorithmOf(jwk)!);
    } catch (error) {
      lastError = error;
      continue;
    }
    try {
      payload = (await jwtVerify(token, key, verifyOptions)).payload;
      break;
    } catch (error) {
      lastError = error;
      // Only a signature mismatch means "wrong key, try the next"; a bad claim or
      // a disallowed algorithm holds whichever key is tried, so stop.
      if (!(error instanceof joseErrors.JWSSignatureVerificationFailed)) break;
    }
  }
  if (payload === null) return { ok: false, reason: reasonFor(lastError) };

  // `jose` does not know our nonce, that a blank subject is no subject, or that a
  // token dated in the future is one this registry refuses.
  if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "no subject" };
  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof payload.iat !== "number" || payload.iat - skew > nowSeconds) {
    return { ok: false, reason: "issued in the future" };
  }
  if (payload.nonce !== options.nonce) return { ok: false, reason: "nonce does not match" };

  return { ok: true, claims: payload as unknown as IdTokenClaims };
}
