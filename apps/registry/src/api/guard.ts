import { principalOf, type ApiContext, type ApiMiddleware } from "./context.js";
import { requireAdmin, requireIdentity, requireUser } from "./errors.js";

/**
 * Authorization, as middleware, so it runs before the validators.
 *
 * The order matters. A validator placed ahead of an authorization check answers
 * a caller who may not act at all with `400 email is required` - telling them
 * what the body should have looked like, and burying the refusal that mattered.
 * A guard is registered before `jsonBody` and `validate`, so the only callers
 * who ever learn the shape of a request are the ones entitled to make it.
 *
 * The exception is a path parameter that the check itself needs: a repository
 * cannot be authorized until its name is known to be a repository name. Those
 * routes validate the parameter, then guard, then read the body.
 */
export const guard = (check: (c: ApiContext) => void | Promise<void>): ApiMiddleware => {
  return async (c, next) => {
    await check(c);
    await next();
  };
};

/** Anyone signed in, human or machine. */
export const signedIn = guard((c) => void requireIdentity(principalOf(c)));

/** A signed-in human. The control plane is closed to machine tokens. */
export const humanOnly = guard((c) => void requireUser(principalOf(c)));

export const adminOnly = guard((c) => void requireAdmin(principalOf(c)));
