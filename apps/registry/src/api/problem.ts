import type { ProblemDetails, ProblemFieldError } from "@registry/api-contract";
import { OciError } from "@registry/oci";
import { HTTPException } from "hono/http-exception";
import type { ApiContext } from "./context.js";

/**
 * Every refusal the management API makes, as an RFC 9457 problem document.
 *
 * The shape is the RFC's: a `type` that identifies the problem, a `title` that
 * summarises the type, a `status`, a `detail` about this one occurrence, and the
 * `instance` it happened at. What a caller branches on is `type`; what a person
 * reads is `detail`.
 */

/** The media type RFC 9457 registers. Not `application/json`, deliberately. */
export const PROBLEM_MEDIA_TYPE = "application/problem+json";

/**
 * The namespace the problem types live in.
 *
 * A `type` is an identifier, not an address. It names a problem this software
 * defines, so it stays the same string whichever host serves the API - which is
 * what lets a client branch on it, and what a relative reference like
 * `/problems/not-found` would have given up by resolving against whichever
 * origin happened to answer.
 */
const NAMESPACE = "https://registry.mareshq.com/problems/";

/**
 * Every problem the management API names.
 *
 * A type carries both its status and its title, because RFC 9457 asks that the
 * title not vary from one occurrence of a type to the next - it summarises the
 * type, not the incident. The sentence that varies is the `detail`.
 */
const CATALOGUE = {
  "invalid-request": { status: 400, title: "Invalid request" },
  unauthorized: { status: 401, title: "Authentication required" },
  forbidden: { status: 403, title: "Forbidden" },
  "not-found": { status: 404, title: "Not found" },
  conflict: { status: 409, title: "Conflict" },
  "rate-limited": { status: 429, title: "Too many requests" },
  "internal-error": { status: 500, title: "Internal server error" },
} as const satisfies Readonly<Record<string, { status: number; title: string }>>;

export type ProblemType = keyof typeof CATALOGUE;

/**
 * The named type a status maps back to, for the refusals raised by code that
 * does not know about this catalogue. Derived rather than restated, so the two
 * directions cannot disagree; every status in the catalogue is distinct.
 */
const BY_STATUS: ReadonlyMap<number, ProblemType> = new Map(
  Object.entries(CATALOGUE).map(([type, { status }]) => [status, type as ProblemType]),
);

/** A refusal, carrying the type that decides its status and its title. */
export class ProblemError extends Error {
  /** One entry per field a validator refused. Absent unless something failed validation. */
  readonly errors: readonly ProblemFieldError[] | undefined;

  constructor(
    readonly type: ProblemType,
    detail: string,
    errors?: readonly ProblemFieldError[],
  ) {
    super(detail);
    this.name = "ProblemError";
    this.errors = errors;
  }

  get status(): number {
    return CATALOGUE[this.type].status;
  }

  get title(): string {
    return CATALOGUE[this.type].title;
  }

  /** RFC 9457 calls it `detail`; `Error` calls it `message`. They are one sentence. */
  get detail(): string {
    return this.message;
  }
}

export const badRequest = (detail: string, errors?: readonly ProblemFieldError[]) =>
  new ProblemError("invalid-request", detail, errors);
export const notFound = (detail = "not found") => new ProblemError("not-found", detail);
export const forbidden = (detail = "forbidden") => new ProblemError("forbidden", detail);
export const conflict = (detail: string) => new ProblemError("conflict", detail);
export const unauthenticated = (detail = "authentication required") =>
  new ProblemError("unauthorized", detail);
export const rateLimited = (detail: string) => new ProblemError("rate-limited", detail);

/** The document a refusal becomes, for the request that provoked it. */
export function toProblem(error: ProblemError, instance: string): ProblemDetails {
  return {
    type: `${NAMESPACE}${error.type}`,
    title: error.title,
    status: error.status,
    detail: error.detail,
    instance,
    ...(error.errors === undefined ? {} : { errors: error.errors }),
  };
}

export function problemResponse(
  problem: ProblemDetails,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "Content-Type": PROBLEM_MEDIA_TYPE, ...headers },
  });
}

/**
 * A status this API has no named type for.
 *
 * `about:blank` is how RFC 9457 says the status code is the whole story: there
 * is nothing to look up, and nothing to branch on that the status did not
 * already say.
 */
function untyped(status: number, detail: string, instance: string): ProblemDetails {
  return {
    type: "about:blank",
    title: status >= 500 ? "Server error" : "Request failed",
    status,
    detail,
    instance,
  };
}

/** A refusal raised elsewhere, placed in this catalogue by the status it meant. */
function problemFor(status: number, detail: string, instance: string): ProblemDetails {
  const type = BY_STATUS.get(status);
  if (type === undefined) return untyped(status, detail, instance);
  return toProblem(new ProblemError(type, detail), instance);
}

/**
 * Every error the management API can raise, rendered as one problem document.
 */
export function onError(error: unknown, c: ApiContext): Response {
  const instance = c.req.path;

  if (error instanceof ProblemError) return problemResponse(toProblem(error, instance));

  // Raised by the authorization code the two planes share, which speaks the
  // distribution spec's vocabulary rather than this one. Mapped by status, so a
  // refusal this catalogue has no name for still answers with what it meant, and
  // the OCI code rides along as an extension member: it is the identifier `/v2`
  // would have used for the same refusal, and a log that holds both can be read
  // across the two planes.
  //
  // Its `WWW-Authenticate` challenge is deliberately not forwarded. It names the
  // registry's bearer realm, which is where a `docker` client goes to exchange
  // credentials - not somewhere a dashboard holding a session cookie can follow.
  if (error instanceof OciError) {
    return problemResponse({ ...problemFor(error.status, error.message, instance), code: error.code });
  }

  if (error instanceof HTTPException) {
    // The only 400 Hono raises on its own is a body that claimed to be JSON and
    // was not. Its own message reads "Malformed JSON in request body"; the
    // dashboard has always been told "body is not valid JSON".
    const detail = error.status === 400 ? "body is not valid JSON" : error.message;
    return problemResponse(problemFor(error.status, detail, instance));
  }

  console.error("unhandled management API error", error);
  return problemResponse(problemFor(500, "internal server error", instance));
}

export function notFoundHandler(c: ApiContext): Response {
  return problemResponse(toProblem(notFound(), c.req.path));
}
