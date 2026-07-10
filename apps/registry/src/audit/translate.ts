import type { RegistryEvent } from "../events.js";
import type { AuditActor, AuditEntry } from "./store.js";

/**
 * Which artifact the event was about, spelled the way a person would.
 *
 * `acme/api:v1.0.0` when a tag was named, `acme/api@sha256:...` otherwise.
 */
function artifactOf(event: RegistryEvent): string {
  if (event.tag !== null) return `${event.repository}:${event.tag}`;
  return event.digest === "" ? event.repository : `${event.repository}@${event.digest}`;
}

/**
 * The audit rows one request's registry events deserve.
 *
 * Pulls produce none: a single `docker pull` reaches the manifest endpoint once
 * per manifest it walks, and a row for each would bury the pushes and deletes
 * that an audit log exists to show. `stats_daily` already counts them.
 *
 * Blob uploads produce none either, for the reason the counters skip them: a
 * layer is not a thing anybody named.
 */
export function auditEntriesFor(events: readonly RegistryEvent[], actor: AuditActor): AuditEntry[] {
  const entries: AuditEntry[] = [];

  for (const event of events) {
    if (event.kind === "manifest.pull" || event.kind === "blob.push") continue;

    const action = event.kind === "manifest.push" ? "artifact.push" : "artifact.delete";
    const detail: Record<string, unknown> = { repository: event.repository };
    if (event.digest !== "") detail.digest = event.digest;
    if (event.tag !== null) detail.tag = event.tag;
    if (event.mediaType !== null) detail.mediaType = event.mediaType;
    if (event.artifactType !== null) detail.artifactType = event.artifactType;
    if (event.kind === "tag.delete") detail.tagOnly = true;

    entries.push({
      actor,
      action,
      resourceType: "artifact",
      resource: artifactOf(event),
      project: event.project,
      detail,
    });
  }

  return entries;
}
