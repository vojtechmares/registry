/**
 * Repository names and tags, exactly as constrained by the distribution spec.
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md
 */

const NAME_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/**
 * Many clients cap `<host>/<name>` at 255 characters. Reserving 64 for a
 * hostname keeps names we accept pullable by those clients.
 */
export const MAX_NAME_LENGTH = 191;
export const MAX_TAG_LENGTH = 128;

export function isValidRepositoryName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

export function isValidTag(tag: string): boolean {
  return TAG_PATTERN.test(tag);
}

/**
 * A `<reference>` in a manifest URL is either a digest or a tag; the spec
 * permits nothing else.
 */
export type Reference =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "tag"; readonly tag: string };
