/**
 * HS256 JSON Web Tokens, signed and verified with `jose`.
 *
 * A JWT library's danger is its flexibility - `alg: none`, HMAC/RSA confusion -
 * so the algorithm is pinned to a single value at both ends. Verification passes
 * `jose` an allowed-algorithms list of exactly `HS256`, and the library rejects
 * any other `alg`, including `none`, before any crypto runs - the same invariant
 * the registry needs, now on audited base64url/JSON parsing. The wire format is
 * an ordinary HS256 JWT, unchanged from the hand-rolled predecessor, so tokens
 * minted by either implementation are interchangeable.
 */

import { SignJWT, jwtVerify } from "jose";

export interface RegistryClaims {
  /** Subject: the user id. */
  readonly sub: string;
  /** The authenticated username, for display and audit. */
  readonly name: string;
  readonly admin: boolean;
  /** Access granted by this token, in the Docker token-scope shape. */
  readonly access: ReadonlyArray<{
    readonly type: string;
    readonly name: string;
    readonly actions: string[];
  }>;
  readonly iss: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf: number;
  readonly jti: string;
}

/** The one algorithm the registry mints and accepts. Pinned, never read from the token. */
const ALGORITHM = "HS256";

/**
 * Clock-skew grace on the validity window, matching the hand-rolled predecessor,
 * which accepted a `nbf` up to a minute ahead so a verifier whose clock trails
 * the issuer's does not reject a freshly minted token.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

function keyOf(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signJwt(claims: RegistryClaims, secret: string): Promise<string> {
  // The claims already carry iss/aud/sub/exp/iat/nbf/jti (and any confinement),
  // so they are the payload as-is; `jose` frames and signs them without a setter
  // overriding anything.
  return new SignJWT({ ...claims }).setProtectedHeader({ alg: ALGORITHM, typ: "JWT" }).sign(keyOf(secret));
}

/** Returns the claims only if the signature, algorithm, audience and validity window all hold. */
export async function verifyJwt(
  token: string,
  secret: string,
  expected: { issuer: string; audience: string },
  now = Date.now(),
): Promise<RegistryClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keyOf(secret), {
      // The allowed-algorithms list is the pin: `alg: none` and HMAC/RSA
      // confusion are rejected here, before any signature is checked.
      algorithms: [ALGORITHM],
      issuer: expected.issuer,
      audience: expected.audience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now),
    });

    // `jose` validates the registered claims and the algorithm; the registry's
    // own claims - a string subject and an access array - it does not know about.
    if (typeof payload.sub !== "string" || !Array.isArray(payload.access)) return null;

    return payload as unknown as RegistryClaims;
  } catch {
    return null;
  }
}
