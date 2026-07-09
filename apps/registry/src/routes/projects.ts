import type { CleanupRule, ProjectSettings, Visibility } from "@registry/api-contract";
import { isValidCron } from "@registry/cron";
import { EVENT_TYPES, type EventType, isAllowedWebhookUrl, isEventType } from "@registry/notifications";
import { type Role, canAdminister, isRole, isValidProjectName } from "@registry/projects";
import { parseRange } from "@registry/semver";
import type { Identity, Principal } from "../auth/principal.js";
import type { AuthStore } from "../auth/store.js";
import type { AdminStore, Viewer } from "../storage/admin.js";
import type { NotificationStore } from "../notifications/store.js";
import type { CleanupPolicyInput, CleanupStore } from "../storage/cleanup.js";
import type { ProjectStore } from "../storage/projects.js";
import type { StatsStore } from "../storage/stats.js";
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
  readonly stats: StatsStore;
  readonly cleanup: CleanupStore;
  readonly notifications: NotificationStore;
}

/** `?days=` bounded to something a chart can hold and the table can still serve. */
export function windowDays(url: URL): number {
  const raw = Number(url.searchParams.get("days") ?? "30");
  if (!Number.isSafeInteger(raw) || raw < 1) return 30;
  return Math.min(raw, 365);
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
  if (section === "stats" && target === undefined) return projectStats(ctx, name);
  if (section === "cleanup" && target === undefined) return cleanupPolicy(ctx, name);
  if (section === "events" && target === undefined) return cleanupEvents(ctx, name);
  if (section === "members" && target === undefined) return listMembers(ctx, name);
  if (section === "members" && target !== undefined) return member(ctx, name, target);
  if (section === "notifications" && target === undefined) return notificationPolicies(ctx, name);
  if (section === "notifications" && target !== undefined) return removeNotification(ctx, name, target);
  if (section === "deliveries" && target === undefined) return deliveries(ctx, name);

  throw notFound();
}

/**
 * Rudimentary, and knowingly so. An address is only ever handed to the mail
 * provider, which is the thing that actually knows whether it can be reached.
 */
function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= 254;
}

async function notificationPolicies(ctx: ProjectContext, name: string): Promise<Response> {
  await requireProjectOwner(ctx, name);

  if (ctx.request.method === "GET") {
    return Response.json({ policies: await ctx.notifications.list(name) });
  }
  if (ctx.request.method !== "POST") throw notFound();
  if (!(await ctx.projects.exists(name))) throw notFound(`project "${name}" does not exist`);

  const body = await readJson<{
    name?: string;
    targetType?: string;
    target?: string;
    secret?: string;
    eventTypes?: string[];
  }>(ctx.request);

  if (typeof body.name !== "string" || body.name.trim() === "") throw badRequest("name is required");
  if (body.targetType !== "webhook" && body.targetType !== "email") {
    throw badRequest('targetType must be "webhook" or "email"');
  }
  if (typeof body.target !== "string" || body.target === "") throw badRequest("target is required");

  if (body.targetType === "webhook" && !isAllowedWebhookUrl(body.target)) {
    throw badRequest("target must be an https URL that does not resolve to a private address");
  }
  if (body.targetType === "email" && !isEmailAddress(body.target)) {
    throw badRequest("target must be an email address");
  }

  if (!Array.isArray(body.eventTypes) || body.eventTypes.length === 0) {
    throw badRequest(`eventTypes must list at least one of: ${EVENT_TYPES.join(", ")}`);
  }
  const eventTypes: EventType[] = [];
  for (const type of body.eventTypes) {
    if (typeof type !== "string" || !isEventType(type))
      throw badRequest(`unknown event type "${String(type)}"`);
    eventTypes.push(type);
  }

  // A webhook with no secret cannot be authenticated by its recipient, so one is
  // minted rather than left absent. It is shown exactly once, here.
  const secret =
    body.targetType === "email"
      ? null
      : typeof body.secret === "string" && body.secret !== ""
        ? body.secret
        : crypto.randomUUID().replaceAll("-", "");

  const policy = await ctx.notifications.create({
    id: crypto.randomUUID(),
    project: name,
    name: body.name.trim(),
    targetType: body.targetType,
    target: body.target,
    secret,
    eventTypes,
  });

  return Response.json({ ...policy, secret }, { status: 201 });
}

async function removeNotification(ctx: ProjectContext, name: string, id: string): Promise<Response> {
  if (ctx.request.method !== "DELETE") throw notFound();
  await requireProjectOwner(ctx, name);
  if (!(await ctx.notifications.remove(name, id))) throw notFound("no such notification policy");
  return new Response(null, { status: 204 });
}

/** What was sent and what came back, so a silently broken endpoint can be found. */
async function deliveries(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  await requireProjectOwner(ctx, name);

  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100") || 100, 500);
  return Response.json({ deliveries: await ctx.notifications.deliveries(name, limit) });
}

/**
 * Validates one retention rule.
 *
 * Strictly, because these rules delete images. A range that does not parse, or
 * a repository glob that is empty, would each be a rule whose effect nobody
 * intended; the evaluator already refuses to act on them, and refusing them
 * here means the operator finds out at the moment they typed it rather than at
 * three in the morning.
 */
function validateRule(raw: unknown, index: number): CleanupRule {
  const fail = (message: string): never => {
    throw badRequest(`rules[${index}]: ${message}`);
  };

  if (typeof raw !== "object" || raw === null) return fail("must be an object");
  const rule = raw as Record<string, unknown>;

  const repositories = rule.repositories;
  if (typeof repositories !== "string" || repositories === "") {
    return fail("repositories must be a non-empty glob");
  }

  const tags = (rule.tags ?? {}) as Record<string, unknown>;
  if (typeof tags !== "object" || tags === null) return fail("tags must be an object");

  const pattern = tags.pattern;
  if (pattern !== undefined && typeof pattern !== "string") return fail("tags.pattern must be a string");

  const semver = tags.semver;
  if (semver !== undefined) {
    if (typeof semver !== "string") return fail("tags.semver must be a string");
    if (semver !== "" && parseRange(semver) === null) return fail(`"${semver}" is not a valid semver range`);
  }

  const includePrerelease = tags.includePrerelease;
  if (includePrerelease !== undefined && typeof includePrerelease !== "boolean") {
    return fail("tags.includePrerelease must be a boolean");
  }

  const keepBy = rule.keepBy;
  if (keepBy !== undefined && keepBy !== "updated" && keepBy !== "semver") {
    return fail('keepBy must be "updated" or "semver"');
  }

  const keepLast = nonNegative(rule.keepLast, `rules[${index}].keepLast`);
  const keepWithinDays = nonNegative(rule.keepWithinDays, `rules[${index}].keepWithinDays`);

  return {
    repositories,
    tags: {
      ...(pattern === undefined ? {} : { pattern }),
      ...(semver === undefined ? {} : { semver }),
      ...(includePrerelease === undefined ? {} : { includePrerelease }),
    },
    keepLast,
    keepWithinDays,
    ...(keepBy === undefined ? {} : { keepBy }),
  };
}

function nonNegative(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw badRequest(`${field} must be a non-negative integer or null`);
  }
  return value;
}

/** `GET` reads the policy; `PUT` replaces it. Owners only: these rules delete images. */
async function cleanupPolicy(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method === "GET") {
    await requireProjectOwner(ctx, name);
    const policy = await ctx.cleanup.get(name);
    return Response.json(
      policy ?? {
        project: name,
        enabled: false,
        schedule: "0 3 * * *",
        rules: [],
        untaggedOlderThanDays: null,
        nextRunAt: null,
        lastRunAt: null,
        lastResult: null,
      },
    );
  }

  if (ctx.request.method !== "PUT") throw notFound();
  await requireProjectOwner(ctx, name);
  if (!(await ctx.projects.exists(name))) throw notFound(`project "${name}" does not exist`);

  const body = await readJson<Record<string, unknown>>(ctx.request);

  const schedule = body.schedule;
  if (typeof schedule !== "string" || !isValidCron(schedule)) {
    throw badRequest("schedule must be a five-field cron expression, in UTC");
  }
  if (!Array.isArray(body.rules)) throw badRequest("rules must be an array");
  if (typeof body.enabled !== "boolean") throw badRequest("enabled must be a boolean");

  const input: CleanupPolicyInput = {
    enabled: body.enabled,
    schedule,
    rules: body.rules.map(validateRule),
    untaggedOlderThanDays: nonNegative(body.untaggedOlderThanDays, "untaggedOlderThanDays"),
  };

  return Response.json(await ctx.cleanup.put(name, input));
}

/** What maintenance removed, so a surprising deletion can be explained after the fact. */
async function cleanupEvents(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  await requireProjectOwner(ctx, name);

  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100") || 100, 500);
  return Response.json({ events: await ctx.cleanup.events(name, limit) });
}

/**
 * Activity for a project, and for each image inside it.
 *
 * Gated by the same rule that decides whether the project is visible at all:
 * pull counts disclose how a private project is used, and a project nobody may
 * see must not answer questions about itself.
 */
async function projectStats(ctx: ProjectContext, name: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();

  const viewerId = ctx.principal.kind === "anonymous" ? null : ctx.principal.identity.id;
  const project = await ctx.projects.get(name, viewerId);
  if (project === null || !canView(ctx.principal, project.visibility, project.role, name)) {
    throw notFound(`project "${name}" does not exist`);
  }

  return Response.json(await ctx.stats.forProject(name, windowDays(ctx.url)));
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
