import { OciError } from "@registry/oci";
import { formatBytes, projectOf, quotaAdmits } from "@registry/projects";
import type { ManifestRecord, RegistryPolicy } from "@registry/registry-core";
import type { ProjectRules, ProjectStore } from "./storage/projects.js";

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

  constructor(private readonly projects: ProjectStore) {}

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

  async beforeManifestPush(_repository: string, _record: ManifestRecord, _tag: string | null): Promise<void> {
    // Signature rules land here.
  }

  async beforeManifestPull(_repository: string, _record: ManifestRecord): Promise<void> {
    // Signature rules land here.
  }
}
