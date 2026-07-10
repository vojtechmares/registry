import type { ProblemFieldError } from "@registry/api-contract";
import type { Env, MiddlewareHandler, ValidationTargets } from "hono";
import { validator as honoValidator } from "hono-openapi";
import type { BaseIssue, BaseSchema, InferOutput } from "valibot";
import { badRequest } from "./problem.js";

/**
 * One valibot issue, in the shape valibot actually produces.
 *
 * `@hono/standard-validator` hands the hook `StandardSchemaV1.Issue`, which
 * promises only `message` and `path`. Every field read here is part of
 * valibot's own issue, and the narrowing is checked at runtime by `issueOf`
 * before anything relies on it.
 */
interface Issue {
  readonly kind: string;
  readonly type: string;
  readonly received: string;
  readonly message: string;
  readonly path?: ReadonlyArray<{ readonly key?: unknown }> | undefined;
}

/** The issue, when it is one of valibot's. Null when the validator produced something else. */
function issueOf(raw: { readonly message: string }): Issue | null {
  const issue = raw as Issue;
  return typeof issue.kind === "string" ? issue : null;
}

/** `["rules", "0", "tags", "regex"]`, the field the issue is about, or `[]` for the body itself. */
function pathOf(issue: Issue): readonly string[] {
  if (issue.path === undefined) return [];
  return issue.path.map((segment) => String(segment.key));
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
  const issue = issueOf(raw);
  if (issue === null) return raw.message;

  const path = pathOf(issue).join(".");
  if (isMissing(issue)) return path === "" ? issue.message : `${path} is required`;
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** RFC 6901: `~` and `/` are the only two characters a JSON Pointer must escape. */
function pointerOf(path: readonly string[]): string {
  return path.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/**
 * One complaint, as an entry in the problem document's `errors`.
 *
 * This is the shape RFC 9457 gives as its own worked example: a `detail` per
 * field, and a JSON Pointer naming the field within the body - where the empty
 * pointer names the body itself, which is where a complaint with no path
 * belongs. A query string or a path has no document to point into, so the fault
 * names its parameter instead.
 *
 * The detail here does not repeat the field name the way `describeIssue` does:
 * the pointer already says which field, and `"is required"` beside `/email` is
 * what the RFC's example reads like.
 */
function fieldError(target: keyof ValidationTargets, raw: { readonly message: string }): ProblemFieldError {
  const issue = issueOf(raw);
  if (issue === null) return { detail: raw.message };

  const detail = isMissing(issue) ? "is required" : issue.message;
  const path = pathOf(issue);

  if (target === "json") return { detail, pointer: pointerOf(path) };
  return path.length === 0 ? { detail } : { detail, parameter: path.join(".") };
}

/**
 * `validator`, but failing the way the rest of the management API fails.
 *
 * Without a hook, `hono-openapi` answers a bad body with valibot's raw issue
 * array, which is neither a problem document nor something a person reads. The
 * `detail` quotes the first issue - valibot checks entries in declaration order,
 * so it is the one furthest up the body - and every issue is listed under
 * `errors`, where a form can find the field each one belongs to.
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
    if (result.success) return;

    const issues = result.error;
    const first = issues[0] ?? { message: "invalid request" };
    throw badRequest(
      describeIssue(first),
      issues.map((issue) => fieldError(target, issue)),
    );
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
