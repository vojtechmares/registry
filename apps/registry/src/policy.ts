import { type NotificationEvent, events } from "@registry/notifications";
import { OciError, digestEquals } from "@registry/oci";
import { formatBytes, projectOf, quotaAdmits } from "@registry/projects";
import type { ManifestRecord, RegistryPolicy } from "@registry/registry-core";
import { needsSignatureOnPull, needsSignatureOnPush } from "@registry/signing";
import type { ProjectRules, ProjectStore } from "./storage/projects.js";
import type { SignatureIndex } from "./storage/signatures.js";
import type { TagIndex } from "./storage/tags.js";

/**
 * A project is out of space.
 *
 * `DENIED` rather than a bespoke code: the distribution spec fixes the set, and
 * a client that does not recognise the code still reads the message. 403 rather
 * than 413, because the request is not too large - the project is too full, and
 * retrying with fewer bytes is not the remedy.
 */
export function quotaExceeded(project: string, message: string): OciError {
  return new OciError("DENIED", `project "${project}" is over its storage quota: ${message}`, {
    status: 403,
  });
}

export function unsignedArtifact(repository: string, digest: string, action: string): OciError {
  return new OciError(
    "DENIED",
    `"${repository}" requires a signature: ${digest} has none, so it cannot be ${action}`,
    { status: 403 },
  );
}

/**
 * A tag in this project already means something, and will go on meaning it.
 *
 * `DENIED` and 403 for the same reason a quota refusal is: the distribution
 * spec fixes the set of codes, and the request is not malformed - it is refused.
 */
export function immutableTag(repository: string, tag: string, action: string): OciError {
  return new OciError(
    "DENIED",
    `"${projectOf(repository)}" enforces immutable tags: "${repository}:${tag}" cannot be ${action}`,
    { status: 403 },
  );
}

/**
 * The registry's rules, sourced from the project a repository belongs to.
 *
 * One project per request in practice, so its row is fetched once and reused
 * across every hook the request happens to trip.
 */
export class ProjectPolicy implements RegistryPolicy {
  private readonly cache = new Map<string, Promise<ProjectRules | null>>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly signatures: SignatureIndex,
    private readonly tags: TagIndex,
    // Called on a quota refusal so the request boundary can announce it. Absent
    // off the request path - a replication pull or a retention run refuses the
    // same way, but only a caller's push is worth telling the project about.
    private readonly onQuotaExceeded?: (event: NotificationEvent) => void,
  ) {}

  private rulesFor(repository: string): Promise<ProjectRules | null> {
    const project = projectOf(repository);
    let pending = this.cache.get(project);
    if (pending === undefined) {
      pending = this.projects.rules(project);
      this.cache.set(project, pending);
    }
    return pending;
  }

  /**
   * Refuses a blob the project has no room for.
   *
   * The blob's bytes count against the project only if no repository in it
   * already links them, so re-pushing a layer the project holds is free even
   * when the project is full. `usedBytes` may lag a concurrent push by one
   * blob; a quota is a budget, not a fence, and the alternative is serialising
   * every upload in the project behind one row.
   */
  async beforeBlobLink(repository: string, blob: { digest: string; size: number }): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules === null || rules.quotaBytes === null) return;

    const incoming = (await this.projects.charges(rules.name, blob.digest)) ? blob.size : 0;
    if (quotaAdmits(rules, incoming)) return;

    // Construct the event at the refusal, the one place that knows the project is
    // over. Whether it is dispatched - and how often - is the boundary's throttle.
    this.onQuotaExceeded?.(
      events.QUOTA_EXCEEDED({
        project: rules.name,
        at: Date.now(),
        data: { quotaBytes: rules.quotaBytes, usedBytes: rules.usedBytes },
      }),
    );

    throw quotaExceeded(
      rules.name,
      `${formatBytes(rules.usedBytes)} of ${formatBytes(rules.quotaBytes)} used, ` +
        `and this blob adds ${formatBytes(incoming)}`,
    );
  }

  /**
   * Refuses to move an immutable tag, and to tag a manifest nothing has signed.
   *
   * The signature rule bites at the tag rather than at the push, because a
   * signature names the digest it signs and so the digest must reach the
   * registry first. `docker push repo:v1` is refused; `push by digest, cosign
   * sign, tag` is not.
   */
  async beforeManifestPush(repository: string, record: ManifestRecord, tag: string | null): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules === null) return;

    if (rules.immutableTags && tag !== null) {
      const current = await this.tags.resolveTag(repository, tag);
      // Re-pushing the digest the tag already names changes nothing, and a CI
      // job that reruns its release step must not fail. Only moving it is refused.
      if (current !== null && !digestEquals(current, record.digest)) {
        throw immutableTag(repository, tag, `moved from ${current} to ${record.digest}`);
      }
    }

    if (!rules.requireSignaturePush) return;
    if (!needsSignatureOnPush(record, tag)) return;

    if (!(await this.signatures.isSigned(repository, record.digest))) {
      throw unsignedArtifact(repository, record.digest, "tagged");
    }
  }

  /** Refuses to serve a manifest nothing has signed. */
  async beforeManifestPull(repository: string, record: ManifestRecord): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules?.requireSignaturePull !== true) return;
    if (!needsSignatureOnPull(record)) return;

    // The layout that predates the referrers API leaves nothing on the manifest
    // to say it is a signature - only the tag that points at it. Refusing to
    // serve that manifest would deny a verifier the very thing it came for.
    if (await this.signatures.isAttachment(repository, record.digest)) return;

    // A platform manifest inside a multi-architecture index is pulled by digest
    // as part of that index, and `cosign` signs the index digest, not each
    // child. So a child of a signed index is covered by the index's signature -
    // otherwise a normally-signed multi-arch image could not be pulled at all.
    if (await this.signatures.isSignedIndexChild(repository, record.digest)) return;

    if (!(await this.signatures.isSigned(repository, record.digest))) {
      throw unsignedArtifact(repository, record.digest, "pulled");
    }
  }

  /**
   * Refuses to delete an immutable tag.
   *
   * A tag that could be deleted and pushed again is not immutable; it is
   * immutable until someone wants it not to be, which is the same as mutable
   * with an extra step.
   *
   * A tag that does not exist is left to the core, which answers 404. Refusing
   * here would turn every missing tag in the project into a 403.
   */
  async beforeTagDelete(repository: string, tag: string): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules?.immutableTags !== true) return;
    if ((await this.tags.resolveTag(repository, tag)) === null) return;

    throw immutableTag(repository, tag, "deleted");
  }

  /**
   * Refuses to delete a manifest that an immutable tag names.
   *
   * Deleting by digest takes every tag pointing at the manifest with it, so it
   * is the same act as deleting those tags. An untagged manifest - a signature,
   * an SBOM, a superseded image - has no tag to protect, and garbage collection
   * and the untagged sweep must both keep working.
   */
  async beforeManifestDelete(repository: string, digest: string): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules?.immutableTags !== true) return;
    if (!(await this.tags.isTagged(repository, digest))) return;

    throw new OciError(
      "DENIED",
      `"${rules.name}" enforces immutable tags: ${digest} is tagged in "${repository}", ` +
        "so it cannot be deleted",
      { status: 403 },
    );
  }
}
