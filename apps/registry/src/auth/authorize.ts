import { denied, unauthorized } from "@registry/oci";
import type { Action, Authorize } from "@registry/registry-core";
import type { RegistryConfig } from "./config.js";
import type { Principal } from "./principal.js";
import { scopesAllow } from "./scopes.js";
import type { AuthStore } from "./store.js";

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

/**
 * A user implicitly owns everything under their own username, so `alice` may
 * push `alice/tools` without an administrator granting it first.
 */
function ownsRepository(username: string, repository: string): boolean {
  return repository === username || repository.startsWith(`${username}/`);
}

export interface AuthorizeOptions {
  readonly principal: Principal;
  readonly store: AuthStore;
  readonly config: RegistryConfig;
}

export function createAuthorize({ principal, store, config }: AuthorizeOptions): Authorize {
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

    if (principal.kind === "anonymous") {
      const readable = action === "pull" && config.allowAnonymousPull && (await isPublic(store, repository));
      if (readable) return;
      throw unauthorized("authentication required", {
        "WWW-Authenticate": challenge(config, repository, [action]),
      });
    }

    // A machine token is capped by its scopes before its owner's rights are
    // even consulted, so a narrow token stays narrow even for an administrator.
    if (principal.kind === "token" && !scopesAllow(principal.scopes, repository, action)) {
      throw denied(`this token is not scoped for ${action} on "${repository}"`);
    }

    const { identity } = principal;
    if (identity.isAdmin) return;
    if (ownsRepository(identity.username, repository)) return;

    const grants = await store.grantsFor(identity.id, repository);
    if (grants.includes(action)) return;

    if (action === "pull" && (await isPublic(store, repository))) return;

    throw denied(`insufficient permissions to ${action} "${repository}"`);
  };
}

async function isPublic(store: AuthStore, repository: string): Promise<boolean> {
  return (await store.repositoryVisibility(repository)) === "public";
}
