import { OciError } from "@registry/oci";
import type { ApiErrorBody } from "@registry/api-contract";
import { HTTPException } from "hono/http-exception";
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
export const rateLimited = (message: string) => new ApiError(429, "rate_limited", message);

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

function render(status: number, error: string, message: string): Response {
  const body: ApiErrorBody = { error, message };
  return Response.json(body, { status });
}

/**
 * Every error the management API can raise, rendered in the one shape the
 * dashboard knows how to read.
 */
export function onError(error: unknown): Response {
  if (error instanceof ApiError) return render(error.status, error.code, error.message);

  // Raised by the policy hooks and the OCI helpers, which the management API
  // reaches through the shared authorization code.
  if (error instanceof OciError) return render(error.status, error.code, error.message);

  if (error instanceof HTTPException) {
    // The only 400 Hono raises on its own is a body that claimed to be JSON and
    // was not. Its own message reads "Malformed JSON in request body"; the
    // dashboard has always been told "body is not valid JSON".
    if (error.status === 400) return render(400, "invalid_request", "body is not valid JSON");
    return render(error.status, "error", error.message);
  }

  console.error("unhandled management API error", error);
  return render(500, "internal_error", "internal server error");
}

export function notFoundHandler(): Response {
  return render(404, "not_found", "not found");
}
