import type { EventType, NotificationEvent } from "./event.js";

export type TargetType = "webhook" | "email";

export interface NotificationPolicy {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetType: TargetType;
  /** A URL for a webhook, an address for an email. */
  readonly target: string;
  readonly eventTypes: readonly EventType[];
}

/**
 * Whether a policy wants to hear about an event.
 *
 * A policy with no event types listens to nothing, rather than to everything.
 * The opposite default would turn a half-configured policy into a firehose
 * pointed at somebody's inbox.
 */
export function policyWants(policy: NotificationPolicy, event: NotificationEvent): boolean {
  if (!policy.enabled) return false;
  if (policy.project !== event.project) return false;
  return policy.eventTypes.includes(event.type);
}

export function policiesFor(
  policies: readonly NotificationPolicy[],
  event: NotificationEvent,
): NotificationPolicy[] {
  return policies.filter((policy) => policyWants(policy, event));
}
