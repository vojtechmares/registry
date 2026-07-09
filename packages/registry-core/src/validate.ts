import {
  OciError,
  digestInvalid,
  isValidDigest,
  isValidRepositoryName,
  isValidTag,
  looksLikeDigest,
  manifestInvalid,
  manifestUnknown,
  nameInvalid,
} from "@registry/oci";

export function requireRepositoryName(name: string): string {
  if (!isValidRepositoryName(name)) throw nameInvalid(name);
  return name;
}

export function requireDigest(digest: string): string {
  if (!isValidDigest(digest)) throw digestInvalid(`"${digest}" is not a valid digest`);
  return digest;
}

export type ParsedReference =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "tag"; readonly tag: string };

/**
 * Resolves a manifest `<reference>` to a digest or a tag.
 *
 * The failure modes differ and both are pinned by the conformance suite:
 * `sha256:totallywrong` contains a colon, so it can only be a digest, and a
 * malformed digest is a 400. `.INVALID_MANIFEST_NAME` has no colon, so it can
 * only be a tag, and an unusable tag simply names nothing - a 404.
 *
 * On write an unusable tag is a client error rather than a miss, so `forWrite`
 * turns that 404 into a 400.
 */
export function parseReference(reference: string, forWrite = false): ParsedReference {
  if (looksLikeDigest(reference)) {
    return { kind: "digest", digest: requireDigest(reference) };
  }
  if (!isValidTag(reference)) {
    throw forWrite ? manifestInvalid(`"${reference}" is not a valid tag`) : manifestUnknown(reference);
  }
  return { kind: "tag", tag: reference };
}

/** Parses `?n=` from a listing request. Absent yields `null`; malformed is a 400. */
export function parsePageSize(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value < 0) {
    throw new OciError("UNSUPPORTED", `"n" must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** The hex portion of a digest, which is what object stores want for checksums. */
export function digestHex(digest: string): string {
  return digest.slice(digest.indexOf(":") + 1);
}
