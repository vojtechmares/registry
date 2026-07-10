import type { MiddlewareHandler } from "hono";
import { describeRoute, resolver, type DescribeRouteOptions } from "hono-openapi";
import type { GenericSchema } from "valibot";
import { PROBLEM_MEDIA_TYPE } from "./problem.js";
import { ProblemSchema } from "./schemas.js";

type Responses = NonNullable<DescribeRouteOptions["responses"]>;
type ResponseEntry = Responses[string];

/**
 * The three ways a caller proves who they are.
 *
 * `basic` and `bearer` are what a script and the `docker` client use. `session`
 * is the dashboard's `HttpOnly` cookie, which no script can read and which is
 * therefore not something Swagger UI can be made to send - it is documented so
 * the reader knows the browser is doing it for them.
 */
export const SECURITY_SCHEMES = {
  basic: { type: "http", scheme: "basic", description: "A username and password, or a machine token." },
  bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "A token from `/v2/token`." },
  session: { type: "apiKey", in: "cookie", name: "registry_session", description: "The dashboard's cookie." },
} as const;

/** Every authenticated route accepts any of the three. */
const ANY_CREDENTIAL = [{ basic: [] }, { bearer: [] }, { session: [] }];

function jsonBody(schema: GenericSchema, description: string) {
  return { description, content: { "application/json": { schema: resolver(schema) } } };
}

/** Every refusal is an RFC 9457 problem document, under the media type the RFC registers. */
const error = (description: string) => ({
  description,
  content: { [PROBLEM_MEDIA_TYPE]: { schema: resolver(ProblemSchema) } },
});

export interface RouteSpec {
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** The success response. `null` documents a `204`, which carries no body. */
  readonly ok: {
    readonly status: number;
    readonly schema: GenericSchema | null;
    readonly description: string;
  };
  /** Which refusals this route can produce, beyond the ones every route shares. */
  readonly refusals?: Partial<Record<400 | 401 | 403 | 404 | 409 | 429, string>>;
  /** Routes reachable without credentials: the sign-in page and the docs. */
  readonly public?: boolean;
}

/**
 * One route's entry in the OpenAPI document.
 *
 * `429` is attached to every route rather than declared per-route, because the
 * rate limiter sits in front of all of them and a client that cannot see it in
 * the schema will not handle it.
 */
export function describe(spec: RouteSpec): MiddlewareHandler {
  const responses: Responses = {
    [String(spec.ok.status)]: (spec.ok.schema === null
      ? { description: spec.ok.description }
      : jsonBody(spec.ok.schema, spec.ok.description)) as ResponseEntry,
    429: error("Too many requests. `Retry-After` says how long to wait.") as ResponseEntry,
  };

  for (const [status, description] of Object.entries(spec.refusals ?? {})) {
    responses[status] = error(description) as ResponseEntry;
  }
  if (spec.public !== true && spec.refusals?.[401] === undefined) {
    responses["401"] = error("Authentication required.") as ResponseEntry;
  }

  return describeRoute({
    summary: spec.summary,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    tags: [...spec.tags],
    ...(spec.public === true ? {} : { security: ANY_CREDENTIAL }),
    responses,
  });
}
