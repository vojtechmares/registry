/**
 * The only way to create a notification event.
 *
 * One constructor per type, so an event's shape is decided in exactly one place
 * and the Worker never assembles a payload by hand. The `satisfies` guard below
 * ties the set of constructors to `EVENT_TYPES`: a type declared without a
 * constructor here, or a constructor for a type that is not declared, fails to
 * compile.
 */

import type { EventType, NotificationEvent } from "./event.js";

/** What every event carries, whatever its type. `at` is epoch milliseconds. */
interface Occurrence {
  readonly project: string;
  readonly at: number;
}

interface ArtifactOccurrence extends Occurrence {
  readonly repository: string;
  readonly tag?: string | null;
  readonly digest?: string;
  readonly actor: string;
}

/** A replication run scopes to one repository when a push triggered it, and to the project on a sweep. */
interface ReplicationOccurrence extends Occurrence {
  readonly repository?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

interface ProjectOccurrence extends Occurrence {
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The fields shared by every event: a fresh id, the type, when, and the project. */
function base(
  type: EventType,
  occurrence: Occurrence,
): Pick<NotificationEvent, "id" | "type" | "occurredAt" | "project"> {
  return {
    id: crypto.randomUUID(),
    type,
    occurredAt: new Date(occurrence.at).toISOString(),
    project: occurrence.project,
  };
}

function artifact(type: EventType, input: ArtifactOccurrence): NotificationEvent {
  return {
    ...base(type, input),
    repository: input.repository,
    // A push by digest carries no tag; a blank one is no tag at all.
    tag: input.tag ?? null,
    ...(input.digest === undefined || input.digest === "" ? {} : { digest: input.digest }),
    actor: input.actor,
  };
}

function project(type: EventType, input: ProjectOccurrence): NotificationEvent {
  return { ...base(type, input), ...(input.data === undefined ? {} : { data: input.data }) };
}

export const events = {
  PUSH_ARTIFACT: (input: ArtifactOccurrence) => artifact("PUSH_ARTIFACT", input),
  PULL_ARTIFACT: (input: ArtifactOccurrence) => artifact("PULL_ARTIFACT", input),
  DELETE_ARTIFACT: (input: ArtifactOccurrence) => artifact("DELETE_ARTIFACT", input),
  QUOTA_EXCEEDED: (input: ProjectOccurrence) => project("QUOTA_EXCEEDED", input),
  REPLICATION: (input: ReplicationOccurrence): NotificationEvent => ({
    ...base("REPLICATION", input),
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.data === undefined ? {} : { data: input.data }),
  }),
  CLEANUP: (input: ProjectOccurrence) => project("CLEANUP", input),
} satisfies Record<EventType, (input: never) => NotificationEvent>;

/** The types the artifact constructors cover; the Worker maps registry activity to these. */
export type ArtifactEventType = "PUSH_ARTIFACT" | "PULL_ARTIFACT" | "DELETE_ARTIFACT";
