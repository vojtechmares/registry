import { type ArtifactEventType, type NotificationEvent, events } from "@registry/notifications";
import type { RegistryEvent } from "../events.js";

/**
 * Which registry events the outside world hears about.
 *
 * A blob upload is not one of them: a single `docker push` moves a dozen layers
 * and one manifest, and a webhook fired per layer is noise nobody asked for.
 * The manifest is the artifact, and the artifact is the news.
 */
function eventTypeOf(kind: RegistryEvent["kind"]): ArtifactEventType | null {
  switch (kind) {
    case "manifest.push":
      return "PUSH_ARTIFACT";
    case "manifest.pull":
      return "PULL_ARTIFACT";
    case "manifest.delete":
    case "tag.delete":
      return "DELETE_ARTIFACT";
    case "blob.push":
      return null;
  }
}

export interface Actor {
  readonly username: string;
}

/**
 * Turns what the registry did into what a recipient is told, or null when it is
 * not news. The event is built by the package's constructor, never by hand here.
 */
export function toNotificationEvent(event: RegistryEvent, actor: Actor): NotificationEvent | null {
  const type = eventTypeOf(event.kind);
  if (type === null) return null;

  return events[type]({
    project: event.project,
    repository: event.repository,
    tag: event.tag,
    digest: event.digest,
    actor: actor.username,
    at: event.at,
  });
}

/** A push of the same tag twice in one request is one piece of news, not two. */
export function dedupe(translated: readonly NotificationEvent[]): NotificationEvent[] {
  const seen = new Set<string>();
  const unique: NotificationEvent[] = [];

  for (const event of translated) {
    const key = `${event.type} ${event.repository ?? ""} ${event.tag ?? ""} ${event.digest ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}
