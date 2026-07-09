import { type NotificationEvent, isEventType, policyWants } from "@registry/notifications";
import type { Env } from "../env.js";
import { TaskQueue } from "../tasks/queue.js";
import { DeliveryError, deliver } from "./deliver.js";
import { NotificationStore } from "./store.js";

export const NOTIFY_TASK = "notification.deliver";

interface NotifyPayload {
  readonly policyId: string;
  readonly event: NotificationEvent;
}

function isNotifyPayload(value: unknown): value is NotifyPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<NotifyPayload>;
  return (
    typeof payload.policyId === "string" &&
    typeof payload.event === "object" &&
    payload.event !== null &&
    typeof payload.event.type === "string" &&
    isEventType(payload.event.type)
  );
}

/**
 * Enqueues one delivery per policy that wants the event.
 *
 * Fanned out at enqueue time rather than at delivery time, so a webhook that
 * fails is retried on its own and does not drag a working one along with it.
 * Returns the number of deliveries queued.
 */
export async function notify(env: Env, event: NotificationEvent): Promise<number> {
  const store = new NotificationStore(env.DB);
  const listeners = await store.listeners(event.project);
  const wanted = listeners.filter((entry) => policyWants(entry.policy, event));
  if (wanted.length === 0) return 0;

  const queue = new TaskQueue(env.DB);
  for (const entry of wanted) {
    await queue.enqueue({ kind: NOTIFY_TASK, payload: { policyId: entry.policy.id, event } });
  }
  return wanted.length;
}

/**
 * Delivers one notification.
 *
 * A permanent failure - a URL the registry will not call, an endpoint that
 * answers 4xx, an unconfigured email provider - is recorded and swallowed. It
 * cannot succeed on a later attempt, and letting the queue retry it would only
 * spend the sweep's budget on a foregone conclusion.
 */
export async function handleNotifyTask(payload: unknown, env: Env): Promise<void> {
  if (!isNotifyPayload(payload)) throw new Error("malformed notification payload");

  const store = new NotificationStore(env.DB);
  const entry = await store.get(payload.policyId);
  // The policy was deleted between the enqueue and the delivery. Nothing to do.
  if (entry === null || !entry.policy.enabled) return;

  try {
    const status = await deliver(env, entry.policy, entry.secret, payload.event);
    await store.recordDelivery({
      policyId: entry.policy.id,
      project: entry.policy.project,
      eventType: payload.event.type,
      status: "delivered",
      responseStatus: status,
      error: null,
    });
  } catch (error) {
    const permanent = error instanceof DeliveryError && error.permanent;
    await store.recordDelivery({
      policyId: entry.policy.id,
      project: entry.policy.project,
      eventType: payload.event.type,
      status: "failed",
      responseStatus: error instanceof DeliveryError ? error.responseStatus : null,
      error: error instanceof Error ? error.message : String(error),
    });

    if (!permanent) throw error;
    console.warn("notification permanently failed", { policy: entry.policy.id, error });
  }
}
