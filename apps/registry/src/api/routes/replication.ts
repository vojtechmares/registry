import type { ReplicationExecution, ReplicationRuleSummary } from "@registry/api-contract";
import { Hono } from "hono";
import { enqueueReplication, storesOf, type ApiEnv } from "../context.js";
import { describe } from "../openapi.js";
import { badRequest, notFound } from "../problem.js";
import {
  CreateReplicationRuleBody,
  LimitQuery,
  ProjectParam,
  ProjectTargetParam,
  QueuedReplicationSchema,
  ReplicationExecutionSchema,
  ReplicationRuleSchema,
  listOf,
} from "../schemas.js";
import { jsonBody, validate } from "../validate.js";
import { auditProject, projectOwner } from "./project-access.js";

export const replication = new Hono<ApiEnv>();

const TAGS = ["Replication"];

replication.get(
  "/projects/:project/replication",
  describe({
    summary: "List a project's replication rules",
    description:
      "The remote username identifies the rule's account; the password is sealed at rest, never returned.",
    tags: TAGS,
    ok: { status: 200, schema: listOf("rules", ReplicationRuleSchema), description: "The rules." },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => {
    const { project } = c.req.valid("param");

    // Annotated, so a rule shape the dashboard does not know about cannot reach
    // it without the contract being updated first.
    const rules: ReplicationRuleSummary[] = await storesOf(c).replication.list(project);
    return c.json({ rules });
  },
);

replication.post(
  "/projects/:project/replication",
  describe({
    summary: "Add a replication rule",
    description:
      "A `push` rule mirrors this project outward; a `pull` rule subscribes to somebody else's registry. " +
      "The remote must be an https URL that does not resolve to a private address.",
    tags: TAGS,
    ok: {
      status: 201,
      schema: ReplicationRuleSchema,
      description: "The rule. The remote password is not echoed.",
    },
    refusals: { 400: "Malformed rule.", 403: "You must own the project.", 404: "No such project." },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", CreateReplicationRuleBody),
  async (c) => {
    const { project } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    const body = c.req.valid("json");

    const schedule = body.schedule ?? null;

    // A pull rule is a subscription to somebody else's registry. Nothing that
    // happens here can make it run, so it has no event trigger.
    if (body.direction === "pull" && body.trigger === "event") {
      throw badRequest("a pull rule cannot be triggered by a push to this registry");
    }
    if (body.trigger === "scheduled" && schedule === null) {
      throw badRequest("a scheduled rule needs a five-field cron expression, in UTC");
    }
    if (body.direction === "pull" && body.sourceRepositories.length === 0) {
      throw badRequest("a pull rule must name the remote repositories it subscribes to");
    }

    if ((body.remoteUsername === undefined) !== (body.remotePassword === undefined)) {
      throw badRequest("remoteUsername and remotePassword must be given together");
    }
    const credentials =
      body.remoteUsername === undefined || body.remotePassword === undefined
        ? null
        : { username: body.remoteUsername, password: body.remotePassword };

    const rule = await stores.replication.create({
      id: crypto.randomUUID(),
      project,
      name: body.name,
      direction: body.direction,
      remoteUrl: body.remoteUrl,
      credentials,
      destinationNamespace: body.destinationNamespace,
      repositoryFilter: body.repositoryFilter,
      // A push rule subscribes to nothing, so it names no source repositories -
      // whatever the caller sent. Storing them would describe a rule that is not
      // the rule the evaluator runs.
      sourceRepositories: body.direction === "pull" ? body.sourceRepositories : [],
      tagFilter: body.tagFilter,
      trigger: body.trigger,
      schedule: body.trigger === "scheduled" ? schedule : null,
    });

    await auditProject(c, project, "replication.create", {
      id: rule.id,
      direction: rule.direction,
      remoteUrl: rule.remoteUrl,
    });
    return c.json(rule, 201);
  },
);

replication.delete(
  "/projects/:project/replication/:id",
  describe({
    summary: "Remove a replication rule",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Removed." },
    refusals: { 403: "You must own the project.", 404: "No such rule." },
  }),
  projectOwner,
  validate("param", ProjectTargetParam),
  async (c) => {
    const { project, id } = c.req.valid("param");
    if (!(await storesOf(c).replication.remove(project, id))) throw notFound("no such replication rule");
    await auditProject(c, project, "replication.delete", { id });
    return c.body(null, 204);
  },
);

replication.post(
  "/projects/:project/replication/:id",
  describe({
    summary: "Run a replication rule now",
    description: "Queued rather than run inline: the request must not wait on another registry's network.",
    tags: TAGS,
    ok: { status: 202, schema: QueuedReplicationSchema, description: "Queued." },
    refusals: { 400: "Not a JSON request.", 403: "You must own the project.", 404: "No such rule." },
  }),
  projectOwner,
  // No body is read, so no validator. The dashboard sends `{}` with a JSON
  // content type, which is what puts this mutation out of a hostile page's reach.
  jsonBody,
  validate("param", ProjectTargetParam),
  async (c) => {
    const { project, id } = c.req.valid("param");
    const rule = await storesOf(c).replication.get(id);
    if (rule === null || rule.project !== project) throw notFound("no such replication rule");

    await enqueueReplication(c, id);
    return c.json({ queued: true, rule: id }, 202);
  },
);

/** What each run copied, so a rule that quietly stopped working can be found. */
replication.get(
  "/projects/:project/executions",
  describe({
    summary: "A project's replication runs",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("executions", ReplicationExecutionSchema),
      description: "Runs, newest first.",
    },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  validate("query", LimitQuery),
  async (c) => {
    const { project } = c.req.valid("param");
    const history: ReplicationExecution[] = await storesOf(c).replication.executions(
      project,
      c.req.valid("query").limit,
    );
    return c.json({ executions: history });
  },
);
