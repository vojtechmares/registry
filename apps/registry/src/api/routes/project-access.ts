import { canAdminister } from "@registry/projects";
import { actorOf, type AuditEntry } from "../../audit/store.js";
import type { Identity } from "../../auth/principal.js";
import { principalOf, storesOf, type ApiContext, type ApiMiddleware } from "../context.js";
import { guard, requireUser } from "../guard.js";
import { forbidden } from "../problem.js";

/**
 * Who may change a project.
 *
 * An administrator, a member with the `owner` role, and the user the project is
 * named after - the last so a fresh registry needs no membership rows before
 * anyone can configure their own namespace. Never a machine token: project
 * settings are the control plane, and a token confined to `pull` on one
 * repository must not be able to turn off the signature rule that guards it.
 */
export async function requireProjectOwner(c: ApiContext, project: string): Promise<Identity> {
  const identity = requireUser(principalOf(c));
  if (identity.isAdmin) return identity;
  if (identity.username === project) return identity;

  const access = await storesOf(c).projects.get(project, identity.id);
  if (access !== null && access.role !== null && canAdminister(access.role)) return identity;

  throw forbidden(`you must own the "${project}" project to change it`);
}

/**
 * `requireProjectOwner` on the `:project` path parameter, ahead of the
 * validators. The name is taken raw: an owner is looked up by it, and a name no
 * project could have simply matches nothing.
 */
export const projectOwner: ApiMiddleware = guard(async (c) => {
  await requireProjectOwner(c, c.req.param("project") ?? "");
});

/**
 * Records a change to a project, or to something inside it.
 *
 * After the change, never before: an audit log records what happened, and a
 * refusal did not happen. A Worker that dies in between leaves a change nobody
 * is recorded as making, which D1 cannot prevent without a transaction the
 * request does not have.
 */
export async function auditProject(
  c: ApiContext,
  project: string,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const entry: AuditEntry = {
    actor: actorOf(principalOf(c)),
    action,
    resourceType: "project",
    resource: project,
    project,
    ...(detail === undefined ? {} : { detail }),
  };
  await storesOf(c).audit.record(entry);
}

/** A project must keep at least one owner, however a demotion is spelled. */
export async function isLastOwner(c: ApiContext, project: string, userId: string): Promise<boolean> {
  const owners = (await storesOf(c).projects.members(project)).filter((entry) => entry.role === "owner");
  return owners.length === 1 && owners[0]?.userId === userId;
}
