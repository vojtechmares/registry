import { type Action, isAction } from "@registry/projects";
import type { Scope } from "@registry/projects";

// The scope model itself lives with the project model, because how far a token
// reaches is a project question. What stays here is the wire format: how a
// Docker client asks for a scope, how the registry stores one, and how it
// echoes one back in a token's claims.
export { ACTIONS, isAction, scopeMatchesRepository, scopesAllow } from "@registry/projects";
export type { Scope } from "@registry/projects";

/**
 * Parses a Docker token scope: `repository:<name>:<action>[,<action>]`.
 * Unknown resource types and unknown actions are dropped rather than rejected,
 * since clients routinely ask for scopes a given registry does not model.
 */
export function parseScopeParameter(raw: string): Scope[] {
  const scopes: Scope[] = [];
  for (const entry of raw.split(" ")) {
    if (entry === "") continue;
    // The name may contain colons in principle; actions are the final segment.
    const first = entry.indexOf(":");
    const last = entry.lastIndexOf(":");
    if (first === -1 || first === last) continue;

    const type = entry.slice(0, first);
    if (type !== "repository") continue;

    const repository = entry.slice(first + 1, last);
    const actions = entry
      .slice(last + 1)
      .split(",")
      .filter(isAction);
    if (repository !== "" && actions.length > 0) scopes.push({ repository, actions });
  }
  return scopes;
}

/** Reads the `scopes` column, which holds the JSON the token was created with. */
export function parseScopes(raw: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): Scope[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const { repository, actions } = entry as { repository?: unknown; actions?: unknown };
      if (typeof repository !== "string" || !Array.isArray(actions)) return [];
      const valid = actions.filter(
        (action): action is Action => typeof action === "string" && isAction(action),
      );
      return valid.length === 0 ? [] : [{ repository, actions: valid }];
    });
  } catch {
    return [];
  }
}

/** Renders scopes back into the `access` claim shape Docker clients expect. */
export function toAccessClaim(
  scopes: readonly Scope[],
): Array<{ type: string; name: string; actions: string[] }> {
  return scopes.map((scope) => ({ type: "repository", name: scope.repository, actions: [...scope.actions] }));
}
