import { isAttachmentTag, isSignatureArtifactType } from "./detect.js";

/** A manifest, reduced to what decides whether a signature rule applies to it. */
export interface SignedSubject {
  readonly artifactType: string | null;
  /** Non-null when this manifest is attached to another. Not on its own an exemption - see below. */
  readonly subjectDigest: string | null;
}

/**
 * True for a manifest that is itself a signature, and so cannot be signed again.
 *
 * A `subject` alone is deliberately NOT enough. A perfectly ordinary runnable
 * image may carry a `subject` - the field is legal on any manifest - and
 * exempting on its presence would let a pusher bolt a decoy `subject` onto an
 * image and slip it, unsigned, past a project that requires signatures. Only a
 * recognised signature artifact type exempts a manifest here. The other genuine
 * exemptions - a signature in the legacy tag layout, and a platform manifest
 * inside a signed index - depend on the repository graph and are decided by the
 * registry, not by the manifest in isolation.
 */
function isSignatureManifest(manifest: SignedSubject): boolean {
  return isSignatureArtifactType(manifest.artifactType);
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
  if (isSignatureManifest(manifest)) return false;
  // The signature itself arrives as a tag in the layout that predates referrers.
  if (isAttachmentTag(tag)) return false;
  return true;
}

/**
 * Whether serving this manifest must be refused unless a signature for it
 * exists, considering only the manifest itself.
 *
 * A signature is exempt or nothing could verify anything: `cosign verify`
 * fetches the signature before it can check it, and the signature has none of
 * its own. The registry adds the two exemptions that need the repository graph:
 * a signature in the legacy layout (recognised only by its tag) and a platform
 * manifest inside a signed index.
 */
export function needsSignatureOnPull(manifest: SignedSubject): boolean {
  return !isSignatureManifest(manifest);
}
