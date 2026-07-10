import type { Env, MiddlewareHandler, ValidationTargets } from "hono";
import { validator as honoValidator } from "hono-openapi";
import type { BaseIssue, BaseSchema, InferOutput } from "valibot";
import { badRequest } from "./errors.js";

/**
 * One valibot issue, in the shape valibot actually produces.
 *
 * `@hono/standard-validator` hands the hook `StandardSchemaV1.Issue`, which
 * promises only `message` and `path`. Every field read here is part of
 * valibot's own issue, and the narrowing is checked at runtime by
 * `describeIssue` before it relies on any of them.
 */
interface Issue {
  readonly kind: string;
  readonly type: string;
  readonly received: string;
  readonly message: string;
  readonly path?: ReadonlyArray<{ readonly key?: unknown }> | undefined;
}

/** `rules.0.tags.regex`, the field the issue is about, or `""` for the body itself. */
function dotPath(issue: Issue): string {
  if (issue.path === undefined) return "";
  return issue.path.map((segment) => String(segment.key)).join(".");
}

/**
 * A missing entry, as opposed to one holding the wrong thing.
 *
 * Valibot reports both against the enclosing object, so the absent key is the
 * one whose input was `undefined`.
 */
function isMissing(issue: Issue): boolean {
  return issue.kind === "schema" && issue.type === "object" && issue.received === "undefined";
}

/**
 * Turns valibot's first complaint into the sentence the API has always sent.
 *
 * The field is named by its path rather than by the message, so a schema never
 * has to repeat its own key: `v.check(isEmailAddress, "is not an email
 * address")` under `email` reads back as `email: is not an email address`, and
 * the same check nested in an array reads as `rules.0.tags.regex: ...`. The
 * absent-key case is spelled out in full, because "email: is required" reads
 * worse than "email is required" and the dashboard shows this text verbatim.
 */
export function describeIssue(raw: { readonly message: string }): string {
  const issue = raw as Issue;
  if (typeof issue.kind !== "string") return issue.message;

  const path = dotPath(issue);
  if (isMissing(issue)) return path === "" ? issue.message : `${path} is required`;
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/**
 * `validator`, but failing the way the rest of the management API fails.
 *
 * Without a hook, `hono-openapi` answers a bad body with valibot's raw issue
 * array, which is neither the `{ error, message }` shape the dashboard parses
 * nor something a person reads. Only the first issue is reported: valibot
 * checks entries in declaration order, so it is the one furthest up the body.
 */
export function validate<
  Schema extends BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  Target extends keyof ValidationTargets,
>(
  target: Target,
  schema: Schema,
): MiddlewareHandler<
  Env,
  string,
  { in: { [K in Target]: unknown }; out: { [K in Target]: InferOutput<Schema> } }
> {
  return honoValidator(target, schema, (result) => {
    if (!result.success) throw badRequest(describeIssue(result.error[0] ?? { message: "invalid request" }));
  }) as never;
}

/**
 * A JSON content type a cross-site form cannot set.
 *
 * `SameSite=Strict` already stops the session cookie from riding along on a
 * cross-origin request, and this is the second lock: a `<form>` can only send
 * `text/plain`, `multipart/form-data` or `application/x-www-form-urlencoded`,
 * so requiring `application/json` puts every mutation out of a hostile page's
 * reach.
 *
 * Hono's own JSON validator will not do: handed `text/plain` it does not parse
 * the body and validates `{}` instead, which a schema whose fields are all
 * optional - `PATCH /projects/:name`, say - accepts.
 */
export const jsonBody: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.startsWith("application/json")) throw badRequest("mutations must send a JSON body");
  await next();
};
