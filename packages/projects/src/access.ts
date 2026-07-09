import { projectOf } from "./name.js";
import { type Action, type Role, roleAllows } from "./roles.js";
import { type Scope, scopesAllow, tokenReaches } from "./scopes.js";

export type Visibility = "public" | "private";

/**
 * The caller, reduced to what an access decision actually needs. Deliberately
 * not the Worker's `Principal`: this module must be decidable without a
 * database, so everything it needs has to have been fetched already.
 */
export type AccessPrincipal =
  | { readonly kind: "anonymous" }
  | { readonly kind: "user"; readonly username: string; readonly isAdmin: boolean }
  | {
      readonly kind: "token";
      readonly username: string;
      readonly isAdmin: boolean;
      readonly scopes: readonly Scope[];
      /** Non-null pins the token to one project, whatever its scopes say. */
      readonly project: string | null;
    };

export interface ProjectAccess {
  readonly name: string;
  readonly visibility: Visibility;
  /** The caller's role in this project, or null when they are not a member. */
  readonly role: Role | null;
}

export interface AccessRequest {
  readonly repository: string;
  readonly action: Action;
  readonly principal: AccessPrincipal;
  /** Null when the project does not exist. A push may still create it. */
  readonly project: ProjectAccess | null;
  readonly allowAnonymousPull: boolean;
}

/**
 * The distinction between `challenge` and `deny` is the whole reason this
 * returns three cases rather than a boolean.
 *
 * `challenge` becomes a 401 and tells the client to present credentials, which
 * is how `docker login` discovers the token endpoint. `deny` becomes a 403 and
 * tells it to stop. Answering 403 where 401 was meant breaks `docker push`
 * before it starts; answering 401 where 403 was meant makes an authenticated
 * client retry forever.
 */
export type Decision =
  | { readonly kind: "allow" }
  | { readonly kind: "challenge"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string };

const ALLOW: Decision = { kind: "allow" };

function refuse(principal: AccessPrincipal, reason: string): Decision {
  // Only an anonymous caller has a better credential to offer.
  return principal.kind === "anonymous" ? { kind: "challenge", reason } : { kind: "deny", reason };
}

/**
 * A user implicitly owns the project named after them, without a membership
 * row, so `alice` can push `alice/tools` on a fresh registry. Compared against
 * the project segment rather than a string prefix: `alicebob` is not `alice`.
 */
function ownsPersonalProject(principal: AccessPrincipal, repository: string): boolean {
  return principal.kind !== "anonymous" && projectOf(repository) === principal.username;
}

export function decideAccess(request: AccessRequest): Decision {
  const { principal, repository, action, project } = request;

  if (principal.kind === "anonymous") {
    const readable = action === "pull" && request.allowAnonymousPull && project?.visibility === "public";
    return readable ? ALLOW : { kind: "challenge", reason: "authentication required" };
  }

  // A machine token is capped before its owner's rights are consulted, so a
  // narrow token stays narrow even when an administrator minted it.
  if (principal.kind === "token") {
    if (!tokenReaches(principal.project, repository)) {
      return { kind: "deny", reason: `this token is confined to the "${principal.project!}" project` };
    }
    if (!scopesAllow(principal.scopes, repository, action)) {
      return { kind: "deny", reason: `this token is not scoped for ${action} on "${repository}"` };
    }
  }

  if (principal.isAdmin) return ALLOW;
  if (ownsPersonalProject(principal, repository)) return ALLOW;

  if (project === null) {
    // Nothing to read, and nobody but an administrator or the namesake may
    // create it. Refusing rather than 404ing keeps the project's existence secret.
    return refuse(principal, `insufficient permissions to ${action} "${repository}"`);
  }

  if (project.role !== null && roleAllows(project.role, action)) return ALLOW;
  if (action === "pull" && project.visibility === "public") return ALLOW;

  return refuse(principal, `insufficient permissions to ${action} "${repository}"`);
}

/** Whether a push may bring the project into being. Mirrors `decideAccess`'s creation rule. */
export function mayCreateProject(principal: AccessPrincipal, projectName: string): boolean {
  if (principal.kind === "anonymous") return false;
  if (principal.kind === "token" && !tokenReaches(principal.project, projectName)) return false;
  return principal.isAdmin || principal.username === projectName;
}

export type { Action, Role, Scope };
