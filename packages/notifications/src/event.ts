/**
 * What the registry tells the outside world about, and in what shape.
 *
 * The payload is a contract with somebody else's code, so it is versioned and
 * flat, and it never carries anything a recipient could not have been shown by
 * the API anyway - no secrets, no other project's names.
 */

export const EVENT_TYPES = [
  "PUSH_ARTIFACT",
  "PULL_ARTIFACT",
  "DELETE_ARTIFACT",
  "QUOTA_EXCEEDED",
  "REPLICATION",
  "CLEANUP",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export interface NotificationEvent {
  /** Unique per delivery attempt's subject, so a recipient can deduplicate. */
  readonly id: string;
  readonly type: EventType;
  /** ISO 8601, UTC. */
  readonly occurredAt: string;
  readonly project: string;
  readonly repository?: string;
  readonly tag?: string | null;
  readonly digest?: string;
  /** The username behind the request, or `anonymous`. Never a token secret. */
  readonly actor?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The `version` field lets a recipient reject a payload it does not understand. */
export interface NotificationPayload {
  readonly version: 1;
  readonly event: NotificationEvent;
}

export function toPayload(event: NotificationEvent): NotificationPayload {
  return { version: 1, event };
}

/** A one-line description, used as an email subject and in a delivery log. */
export function describeEvent(event: NotificationEvent): string {
  const where = event.repository ?? event.project;
  const reference = event.tag ?? event.digest ?? "";
  const suffix = reference === "" ? "" : `:${reference}`;

  switch (event.type) {
    case "PUSH_ARTIFACT":
      return `Artifact pushed to ${where}${suffix}`;
    case "PULL_ARTIFACT":
      return `Artifact pulled from ${where}${suffix}`;
    case "DELETE_ARTIFACT":
      return `Artifact deleted from ${where}${suffix}`;
    case "QUOTA_EXCEEDED":
      return `Project ${event.project} is over its storage quota`;
    case "REPLICATION":
      return `Replication finished for ${where}`;
    case "CLEANUP":
      return `Cleanup ran for ${event.project}`;
  }
}

/** A plain-text body. No HTML: an email that renders as source is worse than one that does not. */
export function renderEmail(event: NotificationEvent): { subject: string; text: string } {
  const lines = [
    describeEvent(event),
    "",
    `Project:    ${event.project}`,
    ...(event.repository === undefined ? [] : [`Repository: ${event.repository}`]),
    ...(event.tag == null ? [] : [`Tag:        ${event.tag}`]),
    ...(event.digest === undefined ? [] : [`Digest:     ${event.digest}`]),
    ...(event.actor === undefined ? [] : [`Actor:      ${event.actor}`]),
    `Time:       ${event.occurredAt}`,
  ];

  if (event.data !== undefined && Object.keys(event.data).length > 0) {
    lines.push("", "Details:", JSON.stringify(event.data, null, 2));
  }

  return { subject: describeEvent(event), text: lines.join("\n") };
}
