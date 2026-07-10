import type { NotificationDelivery, NotificationPolicySummary } from "@registry/api-contract";
import { isAllowedWebhookUrl } from "@registry/notifications";
import { Hono } from "hono";
import { storesOf, type ApiEnv } from "../context.js";
import { isEmailAddress } from "../email.js";
import { describe } from "../openapi.js";
import { badRequest, notFound } from "../problem.js";
import {
  CreateNotificationBody,
  CreatedNotificationPolicySchema,
  LimitQuery,
  NotificationDeliverySchema,
  NotificationPolicySchema,
  ProjectParam,
  ProjectTargetParam,
  listOf,
} from "../schemas.js";
import { jsonBody, validate } from "../validate.js";
import { auditProject, projectOwner } from "./project-access.js";

export const notifications = new Hono<ApiEnv>();

const TAGS = ["Notifications"];

notifications.get(
  "/projects/:project/notifications",
  describe({
    summary: "List a project's notification policies",
    description:
      "Without their secrets: a webhook's signing secret is shown once, when the policy is created.",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("policies", NotificationPolicySchema),
      description: "The policies.",
    },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => {
    const { project } = c.req.valid("param");

    // Annotated, so a policy shape the dashboard does not know about cannot
    // reach it without the contract being updated first.
    const policies: NotificationPolicySummary[] = await storesOf(c).notifications.list(project);
    return c.json({ policies });
  },
);

notifications.post(
  "/projects/:project/notifications",
  describe({
    summary: "Add a notification policy",
    tags: TAGS,
    ok: {
      status: 201,
      schema: CreatedNotificationPolicySchema,
      description: "The policy. A webhook's signing secret appears here and nowhere else.",
    },
    refusals: {
      400: "Malformed body, or a target that is not an https URL or an email address.",
      403: "You must own the project.",
      404: "No such project.",
    },
  }),
  projectOwner,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", CreateNotificationBody),
  async (c) => {
    const { project } = c.req.valid("param");
    const stores = storesOf(c);
    if (!(await stores.projects.exists(project))) throw notFound(`project "${project}" does not exist`);

    const body = c.req.valid("json");

    // Which target is acceptable depends on which kind it is, so the check
    // cannot live in the schema for either field alone.
    if (body.targetType === "webhook" && !isAllowedWebhookUrl(body.target)) {
      throw badRequest("target must be an https URL that does not resolve to a private address");
    }
    if (body.targetType === "email" && !isEmailAddress(body.target)) {
      throw badRequest("target must be an email address");
    }

    // A webhook with no secret cannot be authenticated by its recipient, so one
    // is minted rather than left absent. It is shown exactly once, here.
    const secret =
      body.targetType === "email"
        ? null
        : body.secret === ""
          ? crypto.randomUUID().replaceAll("-", "")
          : body.secret;

    const policy = await stores.notifications.create({
      id: crypto.randomUUID(),
      project,
      name: body.name,
      targetType: body.targetType,
      target: body.target,
      secret,
      eventTypes: body.eventTypes,
    });

    await auditProject(c, project, "notification.create", {
      id: policy.id,
      targetType: policy.targetType,
      target: policy.target,
    });
    return c.json({ ...policy, secret }, 201);
  },
);

notifications.delete(
  "/projects/:project/notifications/:id",
  describe({
    summary: "Remove a notification policy",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Removed." },
    refusals: { 403: "You must own the project.", 404: "No such policy." },
  }),
  projectOwner,
  validate("param", ProjectTargetParam),
  async (c) => {
    const { project, id } = c.req.valid("param");
    if (!(await storesOf(c).notifications.remove(project, id))) throw notFound("no such notification policy");
    await auditProject(c, project, "notification.delete", { id });
    return c.body(null, 204);
  },
);

/** What was sent and what came back, so a silently broken endpoint can be found. */
notifications.get(
  "/projects/:project/deliveries",
  describe({
    summary: "A project's notification deliveries",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("deliveries", NotificationDeliverySchema),
      description: "Attempts, newest first.",
    },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  validate("query", LimitQuery),
  async (c) => {
    const { project } = c.req.valid("param");
    const log: NotificationDelivery[] = await storesOf(c).notifications.deliveries(
      project,
      c.req.valid("query").limit,
    );
    return c.json({ deliveries: log });
  },
);
