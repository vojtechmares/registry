import type { ProjectSettings, Visibility } from "@registry/api-contract";
import { type Role, canAdminister, isRole, isValidProjectName } from "@registry/projects";
import type { Identity, Principal } from "../auth/principal.js";
import type { AuthStore } from "../auth/store.js";
import type { AdminStore, Viewer } from "../storage/admin.js";
import type { ProjectStore } from "../storage/projects.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  optionalPositive,
  readJson,
  requireUser,
} from "./support.js";

export interface ProjectContext {
  readonly request: Request;
  readonly url: URL;
  readonly principal: Principal;
  readonly projects: ProjectStore;
  readonly admin: AdminStore;
  readonly auth: AuthStore;
}

export function viewerOf(principal: Principal): Viewer | null {
  if (principal.kind === "anonymous") return null;
  const { id, username, isAdmin } = principal.identity;
  return { id, username, isAdmin };
}

function validName(name: string): string {
  if (!isValidProjectName(name)) throw badRequest(`"${name}" is not a valid project name`);
  return name;
}

/**
 * Who may change a project.
 *
 * An administrator, a member with the `owner` role, and the user the project is
 * named after - the last so a fresh registry needs no membership rows before
 * anyone can configure their own namespace. Never a machine token: project
 * settings are the control plane, and a token confined to `pull` on one
 * repository must not be able to turn off the signature rule that guards it.
 */
async function requireProjectOwner(ctx: ProjectContext, project: string): Promise<Identity> {
  const identity = requireUser(ctx.principal);
  if (identity.isAdmin) return identity;
  if (identity.username === project) return identity;

  const access = await ctx.projects.get(project, identity.id);
  if (access !== null && access.role !== null && canAdminister(access.role)) return identity;

  throw forbidden(`you must own the "${project}" project to change it`);
}

/** Whether the caller may see the project at all. Mirrors the registry's own rule. */
function canView(principal: Principal, visibility: Visibility, role: Role | null, name: string): boolean {
  if (visibility === "public") return true;
  if (principal.kind === "anonymous") return false;
  return principal.identity.isAdmin || principal.identity.username === name || role !== null;
}

/** `/api/v1/projects[/...]`. Returns null when the path is not ours. */
export async function handleProjects(ctx: ProjectContext, path: string): Promise<Response | null> {
  if (path === "/projects") {
    return ctx.request.method === "GET" ? listProjects(ctx) : createProject(ctx);
  }
  if (!path.startsWith("/projects/")) return null;

  const rest = path.slice("/projects/".length);
  const [rawName, section, target, ...extra] = rest.split("/");
  if (rawName === undefined || rawName === "" || extra.length > 0) throw notFound();

  const name = validName(rawName);

  if (section === undefined) return projectDetail(ctx, name);
  if (section === "repositories" && target === undefined) return projectRepositories(ctx, name);
  if (section === "members" && target === undefined) return listMembers(ctx, name);
  if (section === "members" && target !== undefined) return member(ctx, name, target);

  throw notFound();
}

async function listProjects(ctx: ProjectContext): Promise<Response> {
  return Response.json({ projects: await ctx.projects.list(viewerOf(ctx.principal)) });
}

async function createProject(ctx: ProjectContext): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  const identity = requireUser(ctx.principal);

  const body = await readJson<{
    name?: string;
    visibility?: Visibility;
    description?: string;
    quotaBytes?: number | null;
  }>(ctx.request);

  if (typeof body.name !== "string") throw badRequest("name is required");
  const name = validName(body.name);

  // A project is a namespace, and handing one out is a registry-wide decision.
  // The single exception is the project named after the caller, which is theirs
  // by construction and which a push would create anyway.
  if (!identity.isAdmin && identity.username !== name) {
    throw forbidden("only administrators may create a project that is not named after them");
  }

  if (body.visibility !== undefined && body.visibility !== "public" && body.visibility !== "private") {
    throw badRequest('visibility must be "public" or "private"');
  }

  const created = await ctx.projects.create({
    name,
    visibility: body.visibility ?? "private",
    description: typeof body.description === "string" && body.description !== "" ? body.description : null,
    quotaBytes: optionalPositive(body.quotaBytes, "quotaBytes"),
    ownerId: identity.id,
  });
  if (!created) throw conflict(`project "${name}" already exists`);

  const detail = await ctx.projects.get(name, identity.id);
  return Response.json(detail, { status: 201 });
}

async function projectDetail(ctx: ProjectContext, name: string): Promise<Response> {
  switch (ctx.request.method) {
    case "GET":
      return getProject(ctx, name);
    case "PATCH":
      return updateProject(ctx, name);
    case "DELETE":
      return deleteProject(ctx, name);
    default:
      throw notFound();
  }
}

async function getProject(ctx: ProjectContext, name: string): Promise<Response> {
  const viewerId = ctx.principal.kind === "anonymous" ? null : ctx.principal.identity.id;
  const detail = await ctx.projects.get(name, viewerId);

  // A private project is invisible, not forbidden: answering 403 would confirm
  // the name exists to anyone who guessed it.
  if (detail === null || !canView(ctx.principal, detail.visibility, detail.role, name)) {
    throw notFound(`project "${name}" does not exist`);
  }

  // Membership is an owner's business. A guest who can pull need not learn who
  // else has access.
  const owns =
    ctx.principal.kind !== "anonymous" && (ctx.principal.identity.isAdmin || detail.role === "owner");
  return Response.json(owns ? detail : { ...detail, members: [] });
}

async function updateProject(ctx: ProjectContext, name: string): Promise<Response> {
  const identity = await requireProjectOwner(ctx, name);
  const body = await readJson<Record<string, unknown>>(ctx.request);

  const settings: { -readonly [K in keyof ProjectSettings]: ProjectSettings[K] } = {};

  if ("visibility" in body) {
    if (body.visibility !== "public" && body.visibility !== "private") {
      throw badRequest('visibility must be "public" or "private"');
    }
    settings.visibility = body.visibility;
  }
  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      throw badRequest("description must be a string or null");
    }
    settings.description = body.description === "" ? null : body.description;
  }
  if ("quotaBytes" in body) settings.quotaBytes = optionalPositive(body.quotaBytes, "quotaBytes");
  if ("requireSignaturePush" in body) {
    if (typeof body.requireSignaturePush !== "boolean")
      throw badRequest("requireSignaturePush must be a boolean");
    settings.requireSignaturePush = body.requireSignaturePush;
  }
  if ("requireSignaturePull" in body) {
    if (typeof body.requireSignaturePull !== "boolean")
      throw badRequest("requireSignaturePull must be a boolean");
    settings.requireSignaturePull = body.requireSignaturePull;
  }

  if (!(await ctx.projects.update(name, settings))) throw notFound(`project "${name}" does not exist`);
  return Response.json(await ctx.projects.get(name, identity.id));
}

async function deleteProject(ctx: ProjectContext, name: string): Promise<Response> {
  await requireProjectOwner(ctx, name);
  if (!(await ctx.projects.remove(name))) throw notFound(`project "${name}" does not exist`);
  return new Response(null, { status: 204 });
}

async function projectRepositories(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  const repositories = await ctx.admin.listRepositories({
    search: null,
    limit: 500,
    project: name,
    visibleTo: viewerOf(ctx.principal),
  });
  return Response.json({ repositories });
}

async function listMembers(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  await requireProjectOwner(ctx, name);
  return Response.json({ members: await ctx.projects.members(name) });
}

async function member(ctx: ProjectContext, name: string, userId: string): Promise<Response> {
  if (ctx.request.method !== "PUT" && ctx.request.method !== "DELETE") throw notFound();

  await requireProjectOwner(ctx, name);
  if (!(await ctx.projects.exists(name))) throw notFound(`project "${name}" does not exist`);

  if (ctx.request.method === "DELETE") {
    if (await lastOwner(ctx, name, userId)) throw badRequest("a project must keep at least one owner");
    if (!(await ctx.projects.removeMember(name, userId))) throw notFound("no such member");
    return new Response(null, { status: 204 });
  }

  const body = await readJson<{ role?: string }>(ctx.request);
  if (typeof body.role !== "string" || !isRole(body.role)) {
    throw badRequest("role must be one of guest, developer, maintainer, owner");
  }
  if ((await ctx.auth.findUserById(userId)) === null) throw notFound("no such user");

  // Demoting the last owner would leave nobody able to administer the project
  // but a registry administrator.
  if (body.role !== "owner" && (await lastOwner(ctx, name, userId))) {
    throw badRequest("a project must keep at least one owner");
  }

  await ctx.projects.setMember(name, userId, body.role);
  return Response.json({ project: name, userId, role: body.role });
}

async function lastOwner(ctx: ProjectContext, project: string, userId: string): Promise<boolean> {
  const owners = (await ctx.projects.members(project)).filter((entry) => entry.role === "owner");
  return owners.length === 1 && owners[0]?.userId === userId;
}
