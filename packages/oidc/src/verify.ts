/**
 * Verifying an ID token.
 *
 * The algorithm is asserted from the key, never read from the token: a token
 * that names its own algorithm can name `none`, or name HMAC and be verified
 * with the public key as the shared secret. Both are the classic way to forge
 * one, and both die here because the header's `alg` is only ever used to *find*
 * the key, and the key decides how it is checked.
 */

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

function base64UrlDecode(text: string): Uint8Array {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    return null;
  }
}

/** Only the two algorithms every provider offers. Anything else is refused rather than guessed at. */
function algorithmOf(jwk: Jwk): Algorithm | null {
  if (jwk.kty === "RSA") return "RS256";
  if (jwk.kty === "EC" && jwk.crv === "P-256") return "ES256";
  return null;
}

/**
 * Named inline rather than reached for from the DOM library: this package is
 * built for the Workers runtime, whose type environment declares neither
 * `RsaHashedImportParams` nor `EcdsaParams`.
 */
type ImportParams = { name: "RSASSA-PKCS1-v1_5"; hash: "SHA-256" } | { name: "ECDSA"; namedCurve: "P-256" };

type VerifyParams = { name: "RSASSA-PKCS1-v1_5" } | { name: "ECDSA"; hash: "SHA-256" };

async function importKey(jwk: Jwk, algorithm: Algorithm): Promise<CryptoKey> {
  const parameters: ImportParams =
    algorithm === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };

  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, parameters, false, ["verify"]);
}

async function verifySignature(
  jwk: Jwk,
  algorithm: Algorithm,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const key = await importKey(jwk, algorithm);
  const parameters: VerifyParams =
    algorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };

  return crypto.subtle.verify(
    parameters,
    key,
    signature as unknown as BufferSource,
    new TextEncoder().encode(signingInput),
  );
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
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  const header = decodeJson<{ alg?: string; kid?: string }>(rawHeader);
  if (header === null) return { ok: false, reason: "malformed header" };

  let signature: Uint8Array;
  try {
    signature = base64UrlDecode(rawSignature);
  } catch {
    return { ok: false, reason: "malformed signature" };
  }

  // The `kid` narrows which key to try, and nothing more. A token that names no
  // key, or names one the provider does not publish, is checked against all of
  // them - a provider mid-rotation legitimately does this.
  const candidates = keys.filter((key) => header.kid === undefined || key.kid === header.kid);
  const usable = (candidates.length > 0 ? candidates : keys).filter((key) => algorithmOf(key) !== null);
  if (usable.length === 0) return { ok: false, reason: "no usable signing key" };

  const signingInput = `${rawHeader}.${rawPayload}`;
  let verified = false;
  for (const jwk of usable) {
    const algorithm = algorithmOf(jwk)!;
    try {
      if (await verifySignature(jwk, algorithm, signingInput, signature)) {
        verified = true;
        break;
      }
    } catch {
      // A key that will not import is a key that did not sign this.
    }
  }
  if (!verified) return { ok: false, reason: "signature does not verify" };

  const claims = decodeJson<IdTokenClaims>(rawPayload);
  if (claims === null) return { ok: false, reason: "malformed claims" };

  if (claims.iss !== options.issuer) return { ok: false, reason: "issued by someone else" };

  // `aud` may be an array, and then it must contain us. An `azp` check would
  // matter if we accepted tokens issued to other clients; we do not.
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(options.clientId)) return { ok: false, reason: "issued for another client" };

  if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, reason: "no subject" };

  const skew = options.clockSkewSeconds ?? 60;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) return { ok: false, reason: "expired" };
  if (typeof claims.iat !== "number" || claims.iat - skew > now) {
    return { ok: false, reason: "issued in the future" };
  }

  // Without this, an ID token obtained in any other flow could be replayed here.
  if (claims.nonce !== options.nonce) return { ok: false, reason: "nonce does not match" };

  return { ok: true, claims };
}
