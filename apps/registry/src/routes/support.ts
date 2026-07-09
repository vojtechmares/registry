import type { Identity, Principal } from "../auth/principal.js";

/** An error the management API renders as `{ error, message }` with a status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, "invalid_request", message);
export const notFound = (message = "not found") => new ApiError(404, "not_found", message);
export const forbidden = (message = "forbidden") => new ApiError(403, "forbidden", message);
export const conflict = (message: string) => new ApiError(409, "conflict", message);
export const unauthenticated = (message = "authentication required") =>
  new ApiError(401, "unauthorized", message);

export function requireIdentity(principal: Principal): Identity {
  if (principal.kind === "anonymous") throw unauthenticated();
  return principal.identity;
}

/**
 * The control plane - accounts, tokens, project settings - is reachable only by
 * a signed-in human, never by a machine token.
 *
 * A machine token is a data-plane credential: it exists to pull and push within
 * a declared set of scopes. Were the control-plane guards to check only
 * `isAdmin`, a narrow token minted by an administrator could create a fresh
 * admin user, or make itself an owner of every project, and escalate straight
 * past its own confinement.
 */
export function requireUser(principal: Principal): Identity {
  const identity = requireIdentity(principal);
  if (principal.kind === "token") {
    throw forbidden("access tokens may not manage accounts, tokens, or project settings");
  }
  return identity;
}

export function requireAdmin(principal: Principal): Identity {
  const identity = requireUser(principal);
  if (!identity.isAdmin) throw forbidden("administrator privileges are required");
  return identity;
}

/**
 * A cross-site form post cannot set this header, and `SameSite=Strict` already
 * stops the cookie from riding along. Requiring it makes state-changing calls
 * unreachable from another origin.
 */
export function requireJsonBody(request: Request): void {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/json")) {
    throw badRequest("mutations must send a JSON body");
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  requireJsonBody(request);
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest("body is not valid JSON");
  }
}

/** A positive integer, or null. Used for quotas, retention counts, and TTLs. */
export function optionalPositive(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive integer or null`);
  }
  return value;
}
