import { OciError } from "@registry/oci";
import { formatBytes, projectOf, quotaAdmits } from "@registry/projects";
import type { ManifestRecord, RegistryPolicy } from "@registry/registry-core";
import { needsSignatureOnPull, needsSignatureOnPush } from "@registry/signing";
import type { ProjectRules, ProjectStore } from "./storage/projects.js";
import type { SignatureIndex } from "./storage/signatures.js";

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

    throw quotaExceeded(
      rules.name,
      `${formatBytes(rules.usedBytes)} of ${formatBytes(rules.quotaBytes)} used, ` +
        `and this blob adds ${formatBytes(incoming)}`,
    );
  }

  /**
   * Refuses to move a tag onto a manifest nothing has signed.
   *
   * The rule bites at the tag rather than at the push, because a signature
   * names the digest it signs and so the digest must reach the registry first.
   * `docker push repo:v1` is refused; `push by digest, cosign sign, tag` is not.
   */
  async beforeManifestPush(repository: string, record: ManifestRecord, tag: string | null): Promise<void> {
    const rules = await this.rulesFor(repository);
    if (rules?.requireSignaturePush !== true) return;
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
}
