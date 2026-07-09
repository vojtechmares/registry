/**
 * Recognising a signature attached to an OCI artifact.
 *
 * There are two layouts in the wild and a registry that enforces signing has to
 * understand both.
 *
 * The modern one is the referrers API: the signature is a manifest with
 * `subject` pointing at what it signs, and an `artifactType` naming the tool.
 *
 * The older one - still what `cosign` writes against registries that do not
 * advertise referrers support, and still what most pipelines produce - is a
 * tag. A signature for `sha256:<hex>` is pushed as the tag `sha256-<hex>.sig`
 * in the same repository, with no `subject` and no `artifactType` to find it by.
 */

/** `cosign sign`, when the registry advertises the referrers API. */
export const COSIGN_SIGNATURE_ARTIFACT_TYPE = "application/vnd.dev.cosign.artifact.sig.v1+json";

/** `notation sign`. */
export const NOTATION_SIGNATURE_ARTIFACT_TYPE = "application/vnd.cncf.notary.signature";

const SIGNATURE_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
  COSIGN_SIGNATURE_ARTIFACT_TYPE,
  NOTATION_SIGNATURE_ARTIFACT_TYPE,
]);

export function isSignatureArtifactType(artifactType: string | null | undefined): boolean {
  return artifactType != null && SIGNATURE_ARTIFACT_TYPES.has(artifactType);
}

const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/;

/**
 * The tag `cosign` writes a signature to, in the layout that predates referrers.
 * Null when `digest` is not a sha256 digest, since no other algorithm has this
 * convention.
 */
export function cosignSignatureTag(digest: string): string | null {
  const match = DIGEST_PATTERN.exec(digest);
  return match === null ? null : `sha256-${match[1]!}.sig`;
}

/**
 * A tag the tooling owns rather than a release the operator named.
 *
 * `.sig`, `.att` and `.sbom` are cosign's attachments; the bare `sha256-<hex>`
 * is the referrers fallback tag. The suffix list is closed on purpose: were any
 * suffix accepted, pushing `sha256-<hex>.anything` would be a way to slip an
 * unsigned manifest past a project that demands signatures, because attachments
 * are exempt from the rule they carry.
 */
const ATTACHMENT_TAG_PATTERN = /^sha256-[a-f0-9]{64}(?:\.(?:sig|att|sbom))?$/;

export function isAttachmentTag(tag: string): boolean {
  return ATTACHMENT_TAG_PATTERN.test(tag);
}
