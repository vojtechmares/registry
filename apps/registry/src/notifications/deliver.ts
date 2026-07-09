import {
  type NotificationEvent,
  type NotificationPolicy,
  WEBHOOK_HEADERS,
  isAllowedWebhookUrl,
  renderEmail,
  signPayload,
  toPayload,
} from "@registry/notifications";
import type { Env } from "../env.js";

/** A slow endpoint must not hold a Worker's subrequest open indefinitely. */
const TIMEOUT_MS = 10_000;

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly responseStatus: number | null,
    /** A failure that will never succeed. Retrying it only wastes the queue's budget. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/**
 * Posts a signed payload to a project's webhook.
 *
 * Redirects are not followed. The URL was screened once, when the policy was
 * saved; a redirect would let the endpoint choose a second URL that nobody
 * screened, and point it at whatever the registry alone can reach.
 */
async function deliverWebhook(policy: NotificationPolicy, secret: string | null, event: NotificationEvent) {
  if (!isAllowedWebhookUrl(policy.target)) {
    throw new DeliveryError(`refusing to call "${policy.target}"`, null, true);
  }

  const body = JSON.stringify(toPayload(event));
  const headers = new Headers({
    "Content-Type": "application/json",
    "User-Agent": "registry-webhook/1",
    [WEBHOOK_HEADERS.event]: event.type,
    [WEBHOOK_HEADERS.delivery]: event.id,
  });
  if (secret !== null && secret !== "") {
    headers.set(WEBHOOK_HEADERS.signature, await signPayload(body, secret));
  }

  const response = await fetch(policy.target, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.ok) return response.status;

  // 4xx is the endpoint saying "not this, ever". 5xx is "not right now".
  const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw new DeliveryError(`webhook responded ${response.status}`, response.status, permanent);
}

/**
 * Sends an email through whatever HTTP provider is configured.
 *
 * A generic JSON shape rather than a binding, so a deployment can point at
 * Resend, Postmark, or anything that accepts `{from, to, subject, text}`. With
 * nothing configured this is a permanent failure and not a silent success: an
 * operator who asked for email notifications should find out that they never
 * arrive.
 */
async function deliverEmail(env: Env, policy: NotificationPolicy, event: NotificationEvent) {
  const url = env.EMAIL_PROVIDER_URL;
  const key = env.EMAIL_API_KEY;
  const from = env.EMAIL_FROM;

  if (url === undefined || key === undefined || from === undefined) {
    throw new DeliveryError("email notifications are not configured on this registry", null, true);
  }

  const { subject, text } = renderEmail(event);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [policy.target], subject, text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.ok) return response.status;

  const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
  throw new DeliveryError(`email provider responded ${response.status}`, response.status, permanent);
}

export async function deliver(
  env: Env,
  policy: NotificationPolicy,
  secret: string | null,
  event: NotificationEvent,
): Promise<number> {
  return policy.targetType === "webhook"
    ? deliverWebhook(policy, secret, event)
    : deliverEmail(env, policy, event);
}
