import { projectOf } from "@registry/projects";
import type { ManifestRecord, RegistryEvents } from "@registry/registry-core";

export type EventKind = "manifest.pull" | "manifest.push" | "manifest.delete" | "tag.delete" | "blob.push";

/** Something the registry did, recorded after the fact and never before. */
export interface RegistryEvent {
  readonly kind: EventKind;
  readonly project: string;
  readonly repository: string;
  readonly digest: string;
  readonly tag: string | null;
  readonly mediaType: string | null;
  readonly artifactType: string | null;
  readonly size: number;
  readonly at: number;
}

/**
 * Collects what a request did, so it can be counted and announced once the
 * response is already on its way.
 *
 * The `RegistryEvents` methods are synchronous by design: a `docker pull` must
 * not wait on a counter, and a webhook that is slow must not become a registry
 * that is slow. Everything accumulates here and is flushed from `waitUntil`.
 */
export class EventCollector implements RegistryEvents {
  readonly events: RegistryEvent[] = [];

  private record(
    kind: EventKind,
    repository: string,
    fields: Partial<Omit<RegistryEvent, "kind" | "project" | "repository" | "at">>,
  ): void {
    this.events.push({
      kind,
      project: projectOf(repository),
      repository,
      digest: fields.digest ?? "",
      tag: fields.tag ?? null,
      mediaType: fields.mediaType ?? null,
      artifactType: fields.artifactType ?? null,
      size: fields.size ?? 0,
      at: Date.now(),
    });
  }

  blobPushed(repository: string, blob: { digest: string; size: number }): void {
    this.record("blob.push", repository, { digest: blob.digest, size: blob.size });
  }

  manifestPushed(repository: string, record: ManifestRecord, tag: string | null): void {
    this.record("manifest.push", repository, {
      digest: record.digest,
      tag,
      mediaType: record.mediaType,
      artifactType: record.artifactType,
      size: record.size,
    });
  }

  manifestPulled(repository: string, record: ManifestRecord, reference: string): void {
    this.record("manifest.pull", repository, {
      digest: record.digest,
      tag: reference === record.digest ? null : reference,
      mediaType: record.mediaType,
      artifactType: record.artifactType,
      size: record.size,
    });
  }

  manifestDeleted(repository: string, digest: string): void {
    this.record("manifest.delete", repository, { digest });
  }

  tagDeleted(repository: string, tag: string): void {
    this.record("tag.delete", repository, { tag });
  }
}

/** How each event kind moves the daily counters. */
export function countersFor(kind: EventKind): { pulls: number; pushes: number; deletes: number } | null {
  switch (kind) {
    case "manifest.pull":
      return { pulls: 1, pushes: 0, deletes: 0 };
    case "manifest.push":
      return { pulls: 0, pushes: 1, deletes: 0 };
    case "manifest.delete":
    case "tag.delete":
      return { pulls: 0, pushes: 0, deletes: 1 };
    // A layer upload is not a push of anything a person named. Counting it would
    // report a single `docker push` as a dozen, and a re-push of a cached image
    // as none.
    case "blob.push":
      return null;
  }
}
