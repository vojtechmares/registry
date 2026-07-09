import { denied, unauthorized } from "@registry/oci";
import { type AccessPrincipal, decideAccess, projectOf } from "@registry/projects";
import type { Action, Authorize } from "@registry/registry-core";
import type { RegistryConfig } from "./config.js";
import type { Principal } from "./principal.js";
import type { AuthStore, ProjectAccessRecord } from "./store.js";

/**
 * The `WWW-Authenticate` challenge. Clients read `realm` to learn where to
 * exchange credentials for a bearer token, and `scope` to learn what to ask for.
 */
export function challenge(config: RegistryConfig, repository?: string, actions?: readonly Action[]): string {
  const parts = [`realm="${config.realm}"`, `service="${config.service}"`];
  if (repository !== undefined && repository !== "" && actions !== undefined) {
    parts.push(`scope="repository:${repository}:${actions.join(",")}"`);
  }
  return `Bearer ${parts.join(",")}`;
}

/** The Worker's principal, reduced to what an access decision needs. */
export function accessPrincipal(principal: Principal): AccessPrincipal {
  switch (principal.kind) {
    case "anonymous":
      return { kind: "anonymous" };
    case "user":
      return { kind: "user", username: principal.identity.username, isAdmin: principal.identity.isAdmin };
    case "token":
      return {
        kind: "token",
        username: principal.identity.username,
        isAdmin: principal.identity.isAdmin,
        scopes: principal.scopes,
        project: principal.project,
      };
  }
}

export interface AuthorizeOptions {
  readonly principal: Principal;
  readonly store: AuthStore;
  readonly config: RegistryConfig;
}

/**
 * Turns the pure decision in `@registry/projects` into the two HTTP answers the
 * distribution spec distinguishes. Every rule lives there, where it is decided
 * without a database and tested exhaustively; what lives here is the fetch of
 * the project row and the mapping of a refusal onto 401 or 403.
 */
export function createAuthorize({ principal, store, config }: AuthorizeOptions): Authorize {
  const caller = accessPrincipal(principal);
  const userId = principal.kind === "anonymous" ? null : principal.identity.id;

  // A single request authorizes several times: once per handler, and once per
  // candidate repository when an automatic cross-mount hunts for a source. Those
  // land in a handful of projects at most, so each project is fetched once
  // rather than once per call.
  const projects = new Map<string, Promise<ProjectAccessRecord | null>>();
  const projectFor = (repository: string): Promise<ProjectAccessRecord | null> => {
    const name = projectOf(repository);
    let pending = projects.get(name);
    if (pending === undefined) {
      pending = store.projectAccess(repository, userId);
      projects.set(name, pending);
    }
    return pending;
  };

  return async (repository: string, action: Action): Promise<void> => {
    // Registry scope: the `GET /v2/` probe. Any authenticated caller passes.
    // An anonymous one is challenged, which is how `docker login` discovers the
    // realm, and how an anonymous client learns to fetch a public-read token.
    if (repository === "") {
      if (principal.kind === "anonymous" && !config.allowAnonymousPull) {
        throw unauthorized("authentication required", { "WWW-Authenticate": challenge(config) });
      }
      return;
    }

    const decision = decideAccess({
      repository,
      action,
      principal: caller,
      project: await projectFor(repository),
      allowAnonymousPull: config.allowAnonymousPull,
    });

    switch (decision.kind) {
      case "allow":
        return;
      case "challenge":
        throw unauthorized(decision.reason, {
          "WWW-Authenticate": challenge(config, repository, [action]),
        });
      case "deny":
        throw denied(decision.reason);
    }
  };
}
