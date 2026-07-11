import { OciError } from "@registry/oci";
import type { RegistryPolicy } from "@registry/registry-core";
import { D1MetadataStore } from "../storage/metadata.js";

/** What one retirement removed, named for the lifecycle event it records. */
type RetireAction = "retire-tag" | "retire-manifest";

/**
 * The single path a retention run takes to retire a tag or an untagged manifest.
 *
 * It asks the same guard the API's delete endpoints ask - `ProjectPolicy`,
 * through the `RegistryPolicy` port - so a project with immutable tags refuses a
 * retention deletion of a tagged target exactly as it refuses the API's, and the
 * immutability rule is not re-derived. It deletes through the same store methods
 * the API uses, and records one lifecycle event per retirement, always
 * attributed to the project.
 */
export class Retirer {
  private readonly store: D1MetadataStore;

  constructor(
    private readonly db: D1Database,
    private readonly policy: RegistryPolicy,
  ) {
    this.store = new D1MetadataStore(db);
  }

  /** Retires a tag. Returns false when the guard refuses it or it was already gone. */
  async retireTag(
    project: string,
    repository: string,
    tag: string,
    reason: string,
    now: number,
  ): Promise<boolean> {
    if (!(await this.permits(() => this.policy.beforeTagDelete(repository, tag)))) return false;
    if (!(await this.store.deleteTag(repository, tag))) return false;
    await this.record(project, repository, "retire-tag", tag, reason, now);
    return true;
  }

  /** Retires a manifest and every edge to it. Returns false when the guard refuses it. */
  async retireManifest(
    project: string,
    repository: string,
    digest: string,
    reason: string,
    now: number,
  ): Promise<boolean> {
    if (!(await this.permits(() => this.policy.beforeManifestDelete(repository, digest)))) return false;
    if (!(await this.store.deleteManifest(repository, digest))) return false;
    await this.record(project, repository, "retire-manifest", digest, reason, now);
    return true;
  }

  /**
   * Whether the guard permits the deletion.
   *
   * The guard throws to refuse - an immutable tag, say - and a refusal is not an
   * error here but a target the run leaves standing, exactly as the API leaves it
   * standing with a 403. Any other failure is a real fault and propagates.
   */
  private async permits(guard: () => Promise<void>): Promise<boolean> {
    try {
      await guard();
      return true;
    } catch (error) {
      if (error instanceof OciError) return false;
      throw error;
    }
  }

  /** The one writer for every lifecycle event the retention executor records. */
  private async record(
    project: string,
    repository: string,
    action: RetireAction,
    subject: string,
    reason: string,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO lifecycle_events (project, repository, action, subject, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(project, repository, action, subject, reason, now)
      .run();
  }
}
