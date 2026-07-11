import type { CreatedAccessToken } from "@registry/api-contract";
import { projectOf, type Action } from "@registry/projects";
import { Hono } from "hono";
import { actorOf } from "../../audit/store.js";
import { formatAccessToken, generateTokenSecret, hashTokenSecret } from "../../auth/password.js";
import type { Scope } from "../../auth/scopes.js";
import { authorizeFor, principalOf, storesOf, type ApiContext, type ApiEnv } from "../context.js";
import { humanOnly, requireUser } from "../guard.js";
import { describe } from "../openapi.js";
import { badRequest, forbidden, notFound } from "../problem.js";
import {
  AccessTokenSummarySchema,
  CreateTokenBody,
  CreatedAccessTokenSchema,
  IdParam,
  ProjectAccessTokenSchema,
  ProjectParam,
  ProjectTargetParam,
  listOf,
  type ParsedCreateToken,
} from "../schemas.js";
import { jsonBody, validate } from "../validate.js";
import { projectOwner } from "./project-access.js";

export const tokens = new Hono<ApiEnv>();

const TAGS = ["Tokens"];
const DAY_MS = 24 * 60 * 60 * 1000;

async function assertAllowed(c: ApiContext, repository: string, action: Action): Promise<void> {
  try {
    await authorizeFor(c)(repository, action);
  } catch {
    throw forbidden(`you may not grant ${action} on "${repository}"`);
  }
}

/**
 * Mints an access token, pinned to a project.
 *
 * Every token names a project. A token that named none reached every project
 * its owner could, so one leaked from a CI job that only ever pushed to
 * `acme/api` could also delete `payments/vault`. The pin is checked again on
 * every request, and a scope may never carry the token out of it.
 */
async function mintToken(c: ApiContext, pinned: string | null, body: ParsedCreateToken): Promise<Response> {
  const principal = principalOf(c);
  // A machine token must not manage tokens at all, let alone mint a wider one.
  const identity = requireUser(principal);

  const named = body.project ?? null;
  if (pinned !== null && named !== null && named !== pinned) {
    throw badRequest(`the body names project "${named}", but the path names "${pinned}"`);
  }

  const project = pinned ?? named ?? "";
  if (project === "") {
    throw badRequest("project is required: an access token may not reach the whole registry");
  }
  // Whether the project exists is not disclosed here: a caller who cannot grant
  // on it is refused by the scope check below either way, and reporting "does
  // not exist" would turn this into an existence oracle for guessed names. A
  // token pinned to a project that does not exist yet reaches nothing until it
  // does.

  const authorized: Scope[] = [];
  for (const scope of body.scopes) {
    // A token may never grant what its creator does not already hold.
    //
    // A wildcard is checked against the thing it stands for. Pinned to a
    // project, `*` means "everywhere in this project", so the project name is
    // the probe and any of its owners may mint one.
    if (scope.repository === "*") {
      for (const action of scope.actions) await assertAllowed(c, project, action);
    } else {
      // A named scope outside the pinned project could never authorize anything,
      // and reads as a permission the token does not have. Refuse it outright.
      if (projectOf(scope.repository) !== project) {
        throw badRequest(`scope "${scope.repository}" lies outside the "${project}" project`);
      }
      const probe = scope.repository.endsWith("/*") ? scope.repository.slice(0, -2) : scope.repository;
      for (const action of scope.actions) await assertAllowed(c, probe, action);
    }

    authorized.push({ repository: scope.repository, actions: scope.actions });
  }

  const { admin, audit } = storesOf(c);
  if (identity.id === "bootstrap") await admin.ensureBootstrapUser(identity.username);

  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const secret = generateTokenSecret();
  const days = body.expiresInDays ?? null;
  const expiresAt = days === null ? null : Date.now() + days * DAY_MS;

  const summary = await admin.createToken({
    id,
    name: body.name,
    userId: identity.id,
    secretHash: await hashTokenSecret(secret),
    scopes: authorized,
    project,
    expiresAt,
  });

  await audit.record({
    actor: actorOf(principal),
    action: "token.create",
    resourceType: "token",
    resource: id,
    project,
    detail: { name: summary.name, scopes: summary.scopes, expiresAt },
  });

  // The only time the secret is ever visible.
  const created: CreatedAccessToken = { ...summary, secret: formatAccessToken(id, secret) };
  return c.json(created, 201);
}

tokens.get(
  "/tokens",
  describe({
    summary: "List the tokens the caller owns",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("tokens", AccessTokenSummarySchema),
      description: "Every token the caller minted, across their projects.",
    },
    refusals: { 403: "A machine token may not manage tokens." },
  }),
  humanOnly,
  async (c) => {
    const identity = requireUser(principalOf(c));
    return c.json({ tokens: await storesOf(c).admin.listTokens(identity.id) });
  },
);

/** Kept for scripts; the project now has to be named in the body. */
tokens.post(
  "/tokens",
  describe({
    summary: "Mint an access token",
    description:
      "The body must name a project: there is no such thing as a registry-wide machine credential.",
    tags: TAGS,
    ok: {
      status: 201,
      schema: CreatedAccessTokenSchema,
      description: "The token. Its secret is shown once.",
    },
    refusals: { 400: "Malformed body, or no project named.", 403: "You may not grant what you do not hold." },
  }),
  humanOnly,
  jsonBody,
  validate("json", CreateTokenBody),
  (c) => mintToken(c, null, c.req.valid("json")),
);

tokens.delete(
  "/tokens/:id",
  describe({
    summary: "Revoke one of the caller's own tokens",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Revoked." },
    refusals: { 403: "A machine token may not manage tokens.", 404: "No such token." },
  }),
  humanOnly,
  validate("param", IdParam),
  async (c) => {
    const principal = principalOf(c);
    const identity = requireUser(principal);
    const { id } = c.req.valid("param");

    const { admin, audit } = storesOf(c);
    if (!(await admin.revokeToken(identity.id, id))) throw notFound();

    await audit.record({
      actor: actorOf(principal),
      action: "token.revoke",
      resourceType: "token",
      resource: id,
    });
    return c.body(null, 204);
  },
);

/**
 * A project's tokens.
 *
 * Listing and revoking are for owners, because a project's tokens are its
 * attack surface and reading them off is how an owner audits it. Minting is for
 * any member, bounded as ever by what the member already holds: a developer who
 * may push to one repository may mint a token that pushes to that repository,
 * and nothing else.
 */
tokens.get(
  "/projects/:project/tokens",
  describe({
    summary: "List a project's tokens, whoever minted them",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("tokens", ProjectAccessTokenSchema),
      description: "Every token pinned to the project. No secrets.",
    },
    refusals: { 403: "You must own the project." },
  }),
  projectOwner,
  validate("param", ProjectParam),
  async (c) => c.json({ tokens: await storesOf(c).admin.listProjectTokens(c.req.valid("param").project) }),
);

tokens.post(
  "/projects/:project/tokens",
  describe({
    summary: "Mint a token pinned to this project",
    tags: TAGS,
    ok: {
      status: 201,
      schema: CreatedAccessTokenSchema,
      description: "The token. Its secret is shown once.",
    },
    refusals: {
      400: "Malformed body, or a scope lying outside the project.",
      403: "You may not grant what you do not hold.",
    },
  }),
  humanOnly,
  jsonBody,
  validate("param", ProjectParam),
  validate("json", CreateTokenBody),
  (c) => mintToken(c, c.req.valid("param").project, c.req.valid("json")),
);

tokens.delete(
  "/projects/:project/tokens/:id",
  describe({
    summary: "Revoke a token belonging to this project",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Revoked." },
    refusals: { 403: "You must own the project.", 404: "No such token in this project." },
  }),
  projectOwner,
  validate("param", ProjectTargetParam),
  async (c) => {
    const principal = principalOf(c);
    const { project, id } = c.req.valid("param");

    const { admin, audit } = storesOf(c);
    if (!(await admin.revokeProjectToken(project, id))) throw notFound();

    await audit.record({
      actor: actorOf(principal),
      action: "token.revoke",
      resourceType: "token",
      resource: id,
      project,
    });

    return c.body(null, 204);
  },
);
