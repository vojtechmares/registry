/**
 * Password hashing with PBKDF2-HMAC-SHA256, the strongest key-derivation
 * function Web Crypto exposes inside a Worker. Argon2 and scrypt would be
 * preferable, but neither is available without shipping WASM.
 *
 * The Workers runtime caps PBKDF2 at 100,000 iterations - `deriveBits` throws
 * a `NotSupportedError` above it - so that is the ceiling here, below the
 * 600,000 OWASP now recommends. Two things compensate: credential-verifying
 * requests are rate limited and cost-amplified before any hash runs, and the
 * iteration count is encoded with each hash, so it can be raised the moment the
 * platform lifts the cap without invalidating stored passwords.
 *
 * Encoded form: `pbkdf2$<iterations>$<base64 salt>$<base64 hash>`.
 */

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]!);
    expected = fromBase64(parts[3]!);
  } catch {
    return false;
  }

  const actual = await derive(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

/** Compares without leaking, through timing, how many leading bytes matched. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * Machine-to-machine credentials look like `ocr_<id>_<secret>`, so the registry
 * can tell a token from a password on sight, and secret scanners can spot one
 * in a log or a repository.
 */
export const TOKEN_PREFIX = "ocr_";

export interface ParsedAccessToken {
  readonly id: string;
  readonly secret: string;
}

export function parseAccessToken(value: string): ParsedAccessToken | null {
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  const rest = value.slice(TOKEN_PREFIX.length);
  const separator = rest.indexOf("_");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { id: rest.slice(0, separator), secret: rest.slice(separator + 1) };
}

export function formatAccessToken(id: string, secret: string): string {
  return `${TOKEN_PREFIX}${id}_${secret}`;
}

/** Token secrets are high-entropy, so a single SHA-256 pass is enough. */
export async function hashTokenSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toBase64(new Uint8Array(digest));
}

export function generateTokenSecret(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (character) =>
    character === "+" ? "-" : character === "/" ? "_" : "",
  );
}
