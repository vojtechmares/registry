import type { ProjectSettings } from "@registry/api-contract";
import { Hono } from "hono";
import { tokenProjectPin, viewerOf } from "../../auth/principal.js";
import { principalOf, storesOf, type ApiEnv } from "../context.js";
import { humanOnly, requireUser } from "../guard.js";
import { describe } from "../openapi.js";
import { badRequest, conflict, forbidden, notFound } from "../problem.js";
import {
  AddMemberBody,
  CleanupEventSchema,
  CleanupPolicyBody,
  CleanupPolicySchema,
  CreateProjectBody,
  LimitQuery,
  MemberGrantSchema,
  ProjectDetailSchema,
  ProjectMemberSchema,
  ProjectParam,
  ProjectMemberParam,
  ProjectSummarySchema,
  RepositorySummarySchema,
  SetMemberBody,
  UpdateProjectBody,
  UsageStatsSchema,
  WindowQuery,
  listOf,
} from "../schemas.js";
import { jsonBody, validate } from "../validate.js";
import { auditProject, canView, isLastOwner, projectOwner } from "./project-access.js";

export const projects = new Hono<ApiEnv>();

const TAGS = ["Projects"];

projects.get(
  "/projects",
  describe({
    summary: "List the projects the caller can see",
    tags: TAGS,
    ok: { status: 200, schema: listOf("projects", ProjectSummarySchema), description: "Visible projects." },
    public: true,
  }),
  async (c) => {
    const principal = principalOf(c);
    const all = await storesOf(c).projects.list(viewerOf(principal));

    // A pinned token sees only its own project, whatever its owner can see.
    const pin = tokenProjectPin(principal);
    return c.json({ projects: pin === null ? all : all.filter((project) => project.name === pin) });
  },
);

projects.post(
  "/projects",
  describe({
    summary: "Create a project",
    description: "A project is a namespace, so handing one out is a registry-wide decision.",
    tags: TAGS,
    ok: { status: 201, schema: ProjectDetailSchema, description: "The project that was created." },
    refusals: {
      400: "Malformed body.",
      403: "Only administrators may create a project not named after them.",
      409: "The project already exists.",
    },
  }),
  humanOnly,
  jsonBody,
  validate("json", CreateProjectBody),
  async (c) => {
    const identity = requireUser(principalOf(c));
    const body = c.req.valid("json");

    // The single exception to the rule above is the project named after the
    // caller, which is theirs by construction and which a push would create
    // anyway.
    if (!identity.isAdmin && identity.username !== body.name) {
      throw forbidden("only administrators may create a project that is not named after them");
    }

    const store = storesOf(c).projects;
    const created = await store.create({
      name: body.name,
      visibility: body.visibility,
      // A project with no description has none, not an empty one.
      description: body.description === "" ? null : body.description,
      quotaBytes: body.quotaBytes,
      ownerId: identity.id,
    });
    if (!created) throw conflict(`project "${body.name}" already exists`);

    const detail = await store.get(body.name, identity.id);
    await auditProject(c, body.name, "project.create", { visibility: detail?.visibility ?? null });
    return c.json(detail, 201);
  },
);

projects.get(
  "/projects/:project",
  describe({
    summary: "Read a project",
    tags: TAGS,
    ok: {
      status: 200,
      schema: ProjectDetailSchema,
      description: "The project. Members only for its owners.",
    },
    refusals: { 404: "No such project, or none the caller may see." },
    public: true,
  }),
  validate("param", ProjectParam),
  async (c) => {
    const principal = principalOf(c);
    const { project } = c.req.valid("param");

    const viewerId = principal.kind === "anonymous" ? null : principal.identity.id;
    const detail = await storesOf(c).projects.get(project, viewerId);

    // A private project is invisible, not forbidden: answering 403 would confirm
    // the name exists to anyone who guessed it.
    if (detail === null || !canView(principal, detail.visibility, detail.role, project)) {
      throw notFound(`project "${project}" does not exist`);
    }

    // Membership is an owner's business. A guest who can pull need not learn who
    // else has access.
    const owns = principal.kind !== "anonymous" && (principal.identity.isAdmin || detail.role === "owner");
    return c.json(owns ? detail : { ...detail, members: [] });
  },
);

projects.patch(
  "/projects/:project",
  describe({
    summary: "Change a project's settings",
    description: "Absent fields are left alone. Every applied setting is recorded in the audit log.",
    tags: TAGS,
    ok: { status: 200, schema: ProjectDetailSchema, description: "The project as it now stands." },
    refusals: { 400: "Malformed body.", 403: "You must own the project.", 404: "No such project." },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", UpdateProjectBody),
  async (c) => {
    const { project } = c.req.valid("param");
    const identity = requireUser(principalOf(c));
    const body = c.req.valid("json");

    const settings: { -readonly [K in keyof ProjectSettings]: ProjectSettings[K] } = {
      ...body,
      // An empty description clears it rather than storing a blank string.
      ...(body.description === "" ? { description: null } : {}),
    };

    const store = storesOf(c).projects;
    if (!(await store.update(project, settings))) throw notFound(`project "${project}" does not exist`);

    // The settings that were applied, so the row answers "who raised the quota"
    // rather than merely "who touched the project".
    await auditProject(c, project, "project.update", { ...settings });
    return c.json(await store.get(project, identity.id));
  },
);

projects.delete(
  "/projects/:project",
  describe({
    summary: "Delete a project",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Deleted." },
    refusals: { 403: "You must own the project.", 404: "No such project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => {
    const { project } = c.req.valid("param");
    if (!(await storesOf(c).projects.remove(project))) throw notFound(`project "${project}" does not exist`);
    await auditProject(c, project, "project.delete");
    return c.body(null, 204);
  },
);

projects.get(
  "/projects/:project/repositories",
  describe({
    summary: "List a project's repositories",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("repositories", RepositorySummarySchema),
      description: "The repositories the caller may see.",
    },
    public: true,
  }),
  validate("param", ProjectParam),
  async (c) => {
    const principal = principalOf(c);
    const { project } = c.req.valid("param");

    // A pinned token sees nothing outside its project, whatever its owner can
    // see. Without this, a token scoped to one project could name another and
    // read back every repository an administrator who owns it can see.
    const pin = tokenProjectPin(principal);
    if (pin !== null && pin !== project) return c.json({ repositories: [] });

    const repositories = await storesOf(c).admin.listRepositories({
      search: null,
      limit: 500,
      project,
      visibleTo: viewerOf(principal),
    });
    return c.json({ repositories });
  },
);

/**
 * Activity for a project, and for each image inside it.
 *
 * Gated by the same rule that decides whether the project is visible at all:
 * pull counts disclose how a private project is used, and a project nobody may
 * see must not answer questions about itself.
 */
projects.get(
  "/projects/:project/stats",
  describe({
    summary: "A project's pulls, pushes and storage",
    tags: TAGS,
    ok: { status: 200, schema: UsageStatsSchema, description: "Usage, with a per-image breakdown." },
    refusals: { 404: "No such project, or none the caller may see." },
    public: true,
  }),
  validate("param", ProjectParam),
  validate("query", WindowQuery),
  async (c) => {
    const principal = principalOf(c);
    const { project } = c.req.valid("param");
    const { days } = c.req.valid("query");

    const viewerId = principal.kind === "anonymous" ? null : principal.identity.id;
    const detail = await storesOf(c).projects.get(project, viewerId);
    if (detail === null || !canView(principal, detail.visibility, detail.role, project)) {
      throw notFound(`project "${project}" does not exist`);
    }

    return c.json(await storesOf(c).stats.forProject(project, days));
  },
);

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

projects.get(
  "/projects/:project/members",
  describe({
    summary: "List a project's members",
    tags: TAGS,
    ok: { status: 200, schema: listOf("members", ProjectMemberSchema), description: "The members." },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => c.json({ members: await storesOf(c).projects.members(c.req.valid("param").project) }),
);

/**
 * Grants a role to a user named by username rather than by id.
 *
 * The `PUT` form of this route needs a user id, and the only route that turns a
 * name into one - `GET /users` - is reserved to administrators. Resolving the
 * name here lets an owner who is not an administrator add somebody to their own
 * project without the registry handing over the list it resolved against.
 */
projects.post(
  "/projects/:project/members",
  describe({
    summary: "Add a member by username",
    tags: TAGS,
    ok: { status: 201, schema: MemberGrantSchema, description: "The grant that was made." },
    refusals: {
      400: "Malformed body, or the last owner would be demoted.",
      403: "You must own the project.",
      404: "No such project, or no such user.",
    },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", AddMemberBody),
  async (c) => {
    const { project } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    const { username, role } = c.req.valid("json");
    const user = await stores.auth.findUserByUsername(username);
    if (user === null) throw notFound("no such user");

    // Re-granting a role is how a member is demoted, so the guard that protects
    // the last owner on `PUT` has to hold here too.
    if (role !== "owner" && (await isLastOwner(c, project, user.id))) {
      throw badRequestLastOwner();
    }

    await stores.projects.setMember(project, user.id, role);
    await auditProject(c, project, "member.add", { username: user.username, role });
    return c.json({ project, userId: user.id, username: user.username, role }, 201);
  },
);

projects.put(
  "/projects/:project/members/:userId",
  describe({
    summary: "Change a member's role",
    tags: TAGS,
    ok: { status: 200, schema: MemberGrantSchema, description: "The grant as it now stands." },
    refusals: {
      400: "Malformed body, or the last owner would be demoted.",
      403: "You must own the project.",
      404: "No such project, or no such user.",
    },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectMemberParam),
  validate("json", SetMemberBody),
  async (c) => {
    const { project, userId } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    const { role } = c.req.valid("json");
    if ((await stores.auth.findUserById(userId)) === null) throw notFound("no such user");

    // Demoting the last owner would leave nobody able to administer the project
    // but a registry administrator.
    if (role !== "owner" && (await isLastOwner(c, project, userId))) throw badRequestLastOwner();

    await stores.projects.setMember(project, userId, role);
    await auditProject(c, project, "member.update", { userId, role });
    return c.json({ project, userId, role });
  },
);

projects.delete(
  "/projects/:project/members/:userId",
  describe({
    summary: "Remove a member",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Removed." },
    refusals: {
      400: "The last owner cannot be removed.",
      403: "You must own the project.",
      404: "No such project, or no such member.",
    },
  }),
  projectOwner,
  validate("param", ProjectMemberParam),
  async (c) => {
    const { project, userId } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    if (await isLastOwner(c, project, userId)) throw badRequestLastOwner();
    if (!(await stores.projects.removeMember(project, userId))) throw notFound("no such member");

    await auditProject(c, project, "member.remove", { userId });
    return c.body(null, 204);
  },
);

/* -------------------------------------------------------------------------- */
/* Cleanup                                                                     */
/* -------------------------------------------------------------------------- */

/** Owners only: these rules delete images. */
projects.get(
  "/projects/:project/cleanup",
  describe({
    summary: "Read a project's cleanup policy",
    tags: TAGS,
    ok: { status: 200, schema: CleanupPolicySchema, description: "The policy, or an empty disabled one." },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => {
    const { project } = c.req.valid("param");
    const policy = await storesOf(c).cleanup.get(project);
    return c.json(
      policy ?? {
        project,
        enabled: false,
        schedule: "0 3 * * *",
        rules: [],
        untaggedOlderThanDays: null,
        nextRunAt: null,
        lastRunAt: null,
        lastResult: null,
      },
    );
  },
);

projects.put(
  "/projects/:project/cleanup",
  describe({
    summary: "Replace a project's cleanup policy",
    description:
      "Every rule is compiled here rather than at three in the morning, so a range that will not parse or a " +
      "regular expression a backtracking engine could not run safely is refused as it is typed.",
    tags: TAGS,
    ok: {
      status: 200,
      schema: CleanupPolicySchema,
      description: "The stored policy, and when it next runs.",
    },
    refusals: { 400: "Malformed policy.", 403: "You must own the project.", 404: "No such project." },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", CleanupPolicyBody),
  async (c) => {
    const { project } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    const input = c.req.valid("json");
    const policy = await stores.cleanup.put(project, input);

    await auditProject(c, project, "cleanup.update", {
      enabled: input.enabled,
      schedule: input.schedule,
      rules: input.rules.length,
    });
    return c.json(policy);
  },
);

/** What maintenance removed, so a surprising deletion can be explained after the fact. */
projects.get(
  "/projects/:project/events",
  describe({
    summary: "What a project's cleanup removed",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("events", CleanupEventSchema),
      description: "Retirements, newest first.",
    },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  validate("query", LimitQuery),
  async (c) => {
    const { project } = c.req.valid("param");
    return c.json({ events: await storesOf(c).cleanup.events(project, c.req.valid("query").limit) });
  },
);

/** Demoting or removing the last owner would leave nobody able to administer the project. */
function badRequestLastOwner(): never {
  throw badRequest("a project must keep at least one owner");
}
