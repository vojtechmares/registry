/**
 * Content digests.
 * https://github.com/opencontainers/image-spec/blob/main/descriptor.md#digests
 *
 *   digest              ::= algorithm ":" encoded
 *   algorithm           ::= algorithm-component (algorithm-separator algorithm-component)*
 *   algorithm-component ::= [a-z0-9]+
 *   algorithm-separator ::= [+._-]
 *   encoded             ::= [a-zA-Z0-9=_-]+
 */

import { Sha256, bytesToHex } from "./sha256.js";

/**
 * Algorithms this registry can actually verify.
 *
 * `sha512` is registered in the image spec, but every hashing path here - the
 * resumable {@link Sha256}, Web Crypto's `SHA-256`, R2's server-side checksum -
 * is sha256. Advertising sha512 would let a client push a sha512-addressed
 * manifest the registry could never verify, so the accepted set names only what
 * is implemented. In practice every OCI client uses sha256.
 */
export const SUPPORTED_ALGORITHMS = ["sha256"] as const;
export type DigestAlgorithm = (typeof SUPPORTED_ALGORITHMS)[number];

/** Hex length of each supported algorithm's encoded portion. */
const ENCODED_LENGTH: Record<DigestAlgorithm, number> = {
  sha256: 64,
};

const DIGEST_GRAMMAR = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;
const LOWER_HEX = /^[a-f0-9]+$/;

export interface ParsedDigest {
  readonly algorithm: string;
  readonly encoded: string;
}

/**
 * True when a manifest reference should be interpreted as a digest rather than
 * a tag. Tags may not contain ":", so the separator alone disambiguates - and
 * it must, because `sha256:totallywrong` has to fail as a *digest* (400) while
 * `.INVALID_MANIFEST_NAME` fails as a *tag* (404).
 */
export function looksLikeDigest(reference: string): boolean {
  return reference.includes(":");
}

/** Splits a digest on its grammar alone, without checking the encoded portion. */
export function parseDigest(digest: string): ParsedDigest | null {
  if (!DIGEST_GRAMMAR.test(digest)) return null;
  const separator = digest.indexOf(":");
  return {
    algorithm: digest.slice(0, separator),
    encoded: digest.slice(separator + 1),
  };
}

export function isSupportedAlgorithm(algorithm: string): algorithm is DigestAlgorithm {
  return (SUPPORTED_ALGORITHMS as readonly string[]).includes(algorithm);
}

/**
 * A digest this registry will accept: correct grammar, a registered algorithm,
 * and an encoded portion of the exact length and alphabet that algorithm implies.
 */
export function isValidDigest(digest: string): boolean {
  const parsed = parseDigest(digest);
  if (parsed === null) return false;
  if (!isSupportedAlgorithm(parsed.algorithm)) return false;
  return parsed.encoded.length === ENCODED_LENGTH[parsed.algorithm] && LOWER_HEX.test(parsed.encoded);
}

export function digestOf(data: Uint8Array): string {
  return `sha256:${new Sha256().update(data).digestHex()}`;
}

/** Digest via Web Crypto, which is far faster than our JS fallback for one-shot input. */
export async function digestOfAsync(data: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(buffer))}`;
}

/**
 * Constant-time comparison of two digest strings. Digests are public data, but
 * they gate deduplication, so treat a mismatch as security-relevant.
 */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The referrers fallback tag for a subject digest: `<algorithm>-<encoded>`. */
export function referrersTag(subjectDigest: string): string {
  return subjectDigest.replace(":", "-").slice(0, 128);
}
