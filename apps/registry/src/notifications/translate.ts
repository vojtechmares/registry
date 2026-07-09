import type { EventType, NotificationEvent } from "@registry/notifications";
import type { RegistryEvent } from "../events.js";

/**
 * Which registry events the outside world hears about.
 *
 * A blob upload is not one of them: a single `docker push` moves a dozen layers
 * and one manifest, and a webhook fired per layer is noise nobody asked for.
 * The manifest is the artifact, and the artifact is the news.
 */
function eventTypeOf(kind: RegistryEvent["kind"]): EventType | null {
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

/** Turns what the registry did into what a recipient is told, or null when it is not news. */
export function toNotificationEvent(event: RegistryEvent, actor: Actor): NotificationEvent | null {
  const type = eventTypeOf(event.kind);
  if (type === null) return null;

  return {
    id: crypto.randomUUID(),
    type,
    occurredAt: new Date(event.at).toISOString(),
    project: event.project,
    repository: event.repository,
    tag: event.tag,
    ...(event.digest === "" ? {} : { digest: event.digest }),
    actor: actor.username,
  };
}

/** A push of the same tag twice in one request is one piece of news, not two. */
export function dedupe(events: readonly NotificationEvent[]): NotificationEvent[] {
  const seen = new Set<string>();
  const unique: NotificationEvent[] = [];

  for (const event of events) {
    const key = `${event.type} ${event.repository ?? ""} ${event.tag ?? ""} ${event.digest ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}
