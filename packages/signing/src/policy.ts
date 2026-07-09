import { isAttachmentTag, isSignatureArtifactType } from "./detect.js";

/** A manifest, reduced to what decides whether a signature rule applies to it. */
export interface SignedSubject {
  readonly artifactType: string | null;
  /** Non-null when this manifest is attached to another, as a signature is. */
  readonly subjectDigest: string | null;
}

/** True for a manifest that exists to describe another one, and so cannot itself be signed. */
function isAttachment(manifest: SignedSubject): boolean {
  return manifest.subjectDigest !== null || isSignatureArtifactType(manifest.artifactType);
}

/**
 * Whether pushing this manifest under `tag` must be refused unless a signature
 * for it already exists. `tag` is null for a push by digest.
 *
 * Tagging is the choke point, not the push, because a signature names the
 * digest it signs: the digest has to be in the registry before anything can
 * sign it. So the workflow a project with this rule enforces is push by digest,
 * sign, then tag - which is exactly what `cosign sign registry/repo@sha256:...`
 * already does - and an unsigned `docker push` is refused at the tag.
 */
export function needsSignatureOnPush(manifest: SignedSubject, tag: string | null): boolean {
  if (tag === null) return false;
  if (isAttachment(manifest)) return false;
  // The signature itself arrives as a tag in the layout that predates referrers.
  if (isAttachmentTag(tag)) return false;
  return true;
}

/**
 * Whether serving this manifest must be refused unless a signature for it
 * exists.
 *
 * Attachments are exempt or nothing could verify anything: `cosign verify`
 * fetches the signature before it can check it, and the signature has no
 * signature of its own. A caller must still consult the registry for the older
 * layout, whose signature manifests carry no `subject` and no `artifactType` -
 * only a tag names them.
 */
export function needsSignatureOnPull(manifest: SignedSubject): boolean {
  return !isAttachment(manifest);
}
