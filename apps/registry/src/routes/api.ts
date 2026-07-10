import { OciError, isValidDigest, isValidRepositoryName } from "@registry/oci";
import { isValidProjectName, projectOf } from "@registry/projects";
import type { Action, Authorize } from "@registry/registry-core";
import { AuditStore, actorOf } from "../audit/store.js";
import { createAuthorize } from "../auth/authorize.js";
import type { RegistryConfig } from "../auth/config.js";
import { formatAccessToken, generateTokenSecret, hashPassword, hashTokenSecret } from "../auth/password.js";
import { ANONYMOUS, authenticateCredentials, resolvePrincipal, type Principal } from "../auth/principal.js";
import { isAction, type Scope } from "../auth/scopes.js";
import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
  verifySessionCookie,
} from "../auth/session.js";
import {
  OidcError,
  completeFlow,
  flowCookie,
  isAdminByGroups,
  readOidcConfig,
  safeNext,
  startFlow,
  usernameFor,
} from "../auth/oidc.js";
import { AuthStore } from "../auth/store.js";
import type { Env } from "../env.js";
import { AdminStore } from "../storage/admin.js";
import { NotificationStore } from "../notifications/store.js";
import { REPLICATE_TASK } from "../replication/execute.js";
import { ReplicationStore } from "../replication/store.js";
import { TaskQueue } from "../tasks/queue.js";
import { CleanupStore } from "../storage/cleanup.js";
import { ProjectStore } from "../storage/projects.js";
import { StatsStore } from "../storage/stats.js";
import { handleProjects, requireProjectOwner, tokenProjectPin, viewerOf, windowDays } from "./projects.js";
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  isEmailAddress,
  normalizeEmail,
  notFound,
  optionalPositive,
  readJson,
  requireAdmin,
  requireIdentity,
  requireJsonBody,
  requireUser,
} from "./support.js";
import type { AuditResourceType, CreatedAccessToken, LifecyclePolicy } from "@registry/api-contract";

const PREFIX = "/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the caller for the management API.
 *
 * `Authorization` wins, so a script can drive the API with a machine token. The
 * session cookie is the fallback, and exists only for the dashboard.
 */
async function resolveApiPrincipal(
  request: Request,
  auth: AuthStore,
  config: RegistryConfig,
): Promise<Principal> {
  const fromHeader = await resolvePrincipal(request, auth, config);
  if (fromHeader.kind !== "anonymous") return fromHeader;

  const cookie = readSessionCookie(request);
  if (cookie === null) return ANONYMOUS;

  const identity = await verifySessionCookie(cookie, config);
  if (identity === null) return ANONYMOUS;

  // A session outlives a disabled account only until the cookie expires, so
  // confirm the user is still active on every request.
  if (identity.id !== "bootstrap") {
    const user = await auth.findUserById(identity.id);
    if (user === null || user.disabled) return ANONYMOUS;
    return { kind: "user", identity: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
  }
  return { kind: "user", identity };
}

export async function handleApiRequest(
  request: Request,
  env: Env,
  config: RegistryConfig,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${PREFIX}/`)) return null;

  const auth = new AuthStore(env.DB);
  const admin = new AdminStore(env.DB);
  const audit = new AuditStore(env.DB);
  const projects = new ProjectStore(env.DB);
  const usage = new StatsStore(env.DB);
  const cleanup = new CleanupStore(env.DB);
  const notifications = new NotificationStore(env.DB);
  const replication = new ReplicationStore(env.DB, env.JWT_SECRET);
  const path = url.pathname.slice(PREFIX.length);

  // A manual run is queued, never executed inline: the request that asked for it
  // must not wait on another registry's network.
  const enqueueReplication = async (ruleId: string): Promise<void> => {
    await new TaskQueue(env.DB).enqueue({ kind: REPLICATE_TASK, payload: { ruleId } });
  };
  const secure = url.protocol === "https:";

  try {
    const principal = await resolveApiPrincipal(request, auth, config);
    return await dispatch({
      request,
      url,
      path,
      principal,
      auth,
      admin,
      audit,
      projects,
      stats: usage,
      cleanup,
      notifications,
      replication,
      enqueueReplication,
      config,
      secure,
      env,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof OciError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
}

interface Context {
  request: Request;
  url: URL;
  path: string;
  principal: Principal;
  auth: AuthStore;
  admin: AdminStore;
  audit: AuditStore;
  projects: ProjectStore;
  stats: StatsStore;
  cleanup: CleanupStore;
  notifications: NotificationStore;
  replication: ReplicationStore;
  enqueueReplication: (ruleId: string) => Promise<void>;
  config: RegistryConfig;
  secure: boolean;
  env: Env;
}

async function dispatch(ctx: Context): Promise<Response> {
  const { path, request } = ctx;

  if (path === "/auth/login") return login(ctx);
  if (path === "/auth/logout") return logout(ctx);
  if (path === "/auth/session") return session(ctx);
  if (path === "/auth/providers") return providers(ctx);
  if (path === "/auth/oidc/start") return oidcStart(ctx);
  if (path === "/auth/oidc/callback") return oidcCallback(ctx);
  if (path === "/stats") return stats(ctx);
  if (path === "/audit") return auditLog(ctx);
  if (path === "/repositories") return listRepositories(ctx);
  if (path === "/tokens") return request.method === "GET" ? listTokens(ctx) : createToken(ctx);
  if (path.startsWith("/tokens/")) return revokeToken(ctx, path.slice("/tokens/".length));
  if (path === "/users") return request.method === "GET" ? listUsers(ctx) : createUser(ctx);
  if (path.startsWith("/users/")) return userRoute(ctx, path.slice("/users/".length));

  // Ahead of `handleProjects`, so that minting a token stays beside the other
  // token routes and next to `authorizeFor`, which decides what it may grant.
  const projectToken = /^\/projects\/([^/]+)\/tokens(?:\/([^/]+))?$/.exec(path);
  if (projectToken !== null) return projectTokens(ctx, projectToken[1]!, projectToken[2]);

  const project = await handleProjects(ctx, path);
  if (project !== null) return project;

  // Repository names contain slashes, so the fixed suffix decides the route.
  if (path.startsWith("/repositories/")) {
    const rest = path.slice("/repositories/".length);

    const manifest = /^(.+)\/manifests\/([^/]+)$/.exec(rest);
    if (manifest !== null) return getManifest(ctx, manifest[1]!, manifest[2]!);

    const tags = /^(.+)\/tags$/.exec(rest);
    if (tags !== null) return getTags(ctx, tags[1]!);

    const policy = /^(.+)\/policy$/.exec(rest);
    if (policy !== null) return repositoryPolicy(ctx, policy[1]!);

    const usage = /^(.+)\/stats$/.exec(rest);
    if (usage !== null) return repositoryStats(ctx, usage[1]!);

    return repository(ctx, rest);
  }

  throw notFound();
}

async function login(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  const body = await readJson<{ username?: string; password?: string }>(ctx.request);
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    throw badRequest("username and password are required");
  }

  const principal = await authenticateCredentials(body.username, body.password, ctx.auth, ctx.config);
  // A machine token authenticates through the same credential path (it may be
  // passed as the password), but it must never be exchanged for a session
  // cookie: the cookie resolves back as a `user` principal, which would strip
  // the token's scope confinement and hand it the full control plane. Rejecting
  // non-user principals here is what keeps `requireUser` on the other routes
  // meaningful.
  const identity = requireUser(principal);

  // Give the bootstrap administrator a real row so it can own access tokens.
  if (identity.id === "bootstrap") await ctx.admin.ensureBootstrapUser(identity.username);

  return Response.json(
    { id: identity.id, username: identity.username, isAdmin: identity.isAdmin },
    { headers: { "Set-Cookie": await createSessionCookie(identity, ctx.config, ctx.secure) } },
  );
}

async function logout(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  // A JSON content type a cross-site form cannot set, so a hostile page cannot
  // silently log the visitor out.
  requireJsonBody(ctx.request);
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie(ctx.secure) } });
}

async function session(ctx: Context): Promise<Response> {
  const identity = requireIdentity(ctx.principal);
  return Response.json({ id: identity.id, username: identity.username, isAdmin: identity.isAdmin });
}

/** What the sign-in page should offer. Unauthenticated: it is asked before anyone is signed in. */
async function providers(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  return Response.json({ password: true, oidc: readOidcConfig(ctx.env, ctx.url) !== null });
}

/**
 * Sends the browser to the identity provider.
 *
 * A redirect rather than a JSON body carrying a URL, so the flow works from a
 * plain link and needs no script.
 */
async function oidcStart(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();

  const config = readOidcConfig(ctx.env, ctx.url);
  if (config === null) throw notFound("single sign-on is not configured");

  const next = safeNext(ctx.url.searchParams.get("next"));
  const flow = await startFlow(config, ctx.config, next, ctx.secure);

  return new Response(null, {
    status: 302,
    headers: { Location: flow.authorizeUrl, "Set-Cookie": flow.cookie, "Cache-Control": "no-store" },
  });
}

/**
 * Where the provider sends the browser back.
 *
 * On success the flow cookie is cleared and a session cookie takes its place;
 * on failure the browser lands back on the sign-in page with a message, because
 * a JSON error body is not something a person who just clicked "Sign in" can do
 * anything with.
 */
async function oidcCallback(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();

  const config = readOidcConfig(ctx.env, ctx.url);
  if (config === null) throw notFound("single sign-on is not configured");

  let claims;
  let next: string;
  try {
    ({ claims, next } = await completeFlow(config, ctx.config, ctx.request));
  } catch (error) {
    if (!(error instanceof OidcError)) throw error;
    const message = encodeURIComponent(error.message);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?error=${message}`,
        "Set-Cookie": flowCookie("", ctx.secure, 0),
        "Cache-Control": "no-store",
      },
    });
  }

  const user = await ctx.admin.findOrCreateOidcUser({
    issuer: claims.iss,
    subject: claims.sub,
    username: usernameFor(claims),
    // Normalised on the way in, or the unique index over `users.email` would
    // let a provider's `Alice@` sit beside a local `alice@`.
    email: normalizeEmail(claims.email),
    isAdmin: isAdminByGroups(claims, config),
  });

  if (user.disabled) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=account+disabled",
        "Set-Cookie": flowCookie("", ctx.secure, 0),
      },
    });
  }

  const identity = { id: user.id, username: user.username, isAdmin: user.isAdmin };
  const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", flowCookie("", ctx.secure, 0));
  headers.append("Set-Cookie", await createSessionCookie(identity, ctx.config, ctx.secure));

  return new Response(null, { status: 302, headers });
}

async function stats(ctx: Context): Promise<Response> {
  requireAdmin(ctx.principal);
  return Response.json(await ctx.admin.stats());
}

async function listRepositories(ctx: Context): Promise<Response> {
  const search = ctx.url.searchParams.get("search");
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100") || 100, 500);

  // A pinned token is confined to its project regardless of the query it sends.
  const pin = tokenProjectPin(ctx.principal);
  const project = pin ?? ctx.url.searchParams.get("project");

  const repositories = await ctx.admin.listRepositories({
    search,
    project,
    limit,
    visibleTo: viewerOf(ctx.principal),
  });
  return Response.json({ repositories });
}

function authorizeFor(ctx: Context) {
  return createAuthorize({ principal: ctx.principal, store: ctx.auth, config: ctx.config });
}

function validName(name: string): string {
  if (!isValidRepositoryName(name)) throw badRequest(`"${name}" is not a valid repository name`);
  return name;
}

async function repository(ctx: Context, rawName: string): Promise<Response> {
  const name = validName(rawName);
  const authorize = authorizeFor(ctx);

  if (ctx.request.method === "GET") {
    await authorize(name, "pull");
    const detail = await ctx.admin.repository(name);
    if (detail === null) throw notFound(`repository "${name}" does not exist`);
    return Response.json(detail);
  }

  if (ctx.request.method === "DELETE") {
    await authorize(name, "delete");
    if (!(await ctx.admin.deleteRepository(name))) throw notFound();

    await ctx.audit.record({
      actor: actorOf(ctx.principal),
      action: "repository.delete",
      resourceType: "repository",
      resource: name,
      project: projectOf(name),
    });

    return new Response(null, { status: 204 });
  }

  // Visibility used to live here. It belongs to the project now:
  // `PATCH /api/v1/projects/<project>`.
  throw notFound();
}

async function getTags(ctx: Context, rawName: string): Promise<Response> {
  const name = validName(rawName);
  await authorizeFor(ctx)(name, "pull");
  return Response.json({ tags: await ctx.admin.tags(name) });
}

/** Activity for one image. Gated by the right to pull it: usage is information about it. */
async function repositoryStats(ctx: Context, rawName: string): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  const name = validName(rawName);
  await authorizeFor(ctx)(name, "pull");
  return Response.json(await ctx.stats.forRepository(name, windowDays(ctx.url)));
}

async function getManifest(ctx: Context, rawName: string, digest: string): Promise<Response> {
  const name = validName(rawName);
  if (!isValidDigest(digest)) throw badRequest(`"${digest}" is not a valid digest`);
  await authorizeFor(ctx)(name, "pull");

  const detail = await ctx.admin.manifest(name, digest);
  if (detail === null) throw notFound();
  return Response.json(detail);
}

async function repositoryPolicy(ctx: Context, rawName: string): Promise<Response> {
  const name = validName(rawName);
  const authorize = authorizeFor(ctx);

  if (ctx.request.method === "GET") {
    await authorize(name, "pull");
    return Response.json(
      (await ctx.admin.policy(name)) ?? {
        repository: name,
        enabled: false,
        keepLastTags: null,
        untaggedTtlDays: null,
      },
    );
  }

  if (ctx.request.method === "PUT") {
    await authorize(name, "delete");
    const body = await readJson<Partial<LifecyclePolicy>>(ctx.request);

    const keepLastTags = optionalPositive(body.keepLastTags, "keepLastTags");
    const untaggedTtlDays = optionalPositive(body.untaggedTtlDays, "untaggedTtlDays");

    const policy: LifecyclePolicy = {
      repository: name,
      enabled: body.enabled === true,
      keepLastTags,
      untaggedTtlDays,
    };
    await ctx.admin.setPolicy(policy);
    return Response.json(policy);
  }

  throw notFound();
}

async function listTokens(ctx: Context): Promise<Response> {
  const identity = requireUser(ctx.principal);
  return Response.json({ tokens: await ctx.admin.listTokens(identity.id) });
}

/**
 * `/projects/:name/tokens[/:id]` - where a project's credentials are managed.
 *
 * Listing and revoking are for owners, because a project's tokens are its
 * attack surface and reading them off is how an owner audits it. Minting is for
 * any member, bounded as ever by what the member already holds: a developer who
 * may push to one repository may mint a token that pushes to that repository,
 * and nothing else.
 */
async function projectTokens(ctx: Context, project: string, tokenId: string | undefined): Promise<Response> {
  if (tokenId !== undefined) {
    if (ctx.request.method !== "DELETE") throw notFound();
    await requireProjectOwner(ctx, project);
    if (!(await ctx.admin.revokeProjectToken(project, tokenId))) throw notFound();

    await ctx.audit.record({
      actor: actorOf(ctx.principal),
      action: "token.revoke",
      resourceType: "token",
      resource: tokenId,
      project,
    });

    return new Response(null, { status: 204 });
  }

  if (ctx.request.method === "GET") {
    await requireProjectOwner(ctx, project);
    return Response.json({ tokens: await ctx.admin.listProjectTokens(project) });
  }

  return mintToken(ctx, project);
}

/** `POST /tokens`. Kept for scripts; the project now has to be named in the body. */
async function createToken(ctx: Context): Promise<Response> {
  return mintToken(ctx, null);
}

/**
 * Mints an access token, pinned to `project`.
 *
 * Every token names a project. A token that named none reached every project
 * its owner could, so one leaked from a CI job that only ever pushed to
 * `acme/api` could also delete `payments/vault`. The pin is checked again on
 * every request, and a scope may never carry the token out of it.
 */
async function mintToken(ctx: Context, pinned: string | null): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  // A machine token must not manage tokens at all, let alone mint a wider one.
  const identity = requireUser(ctx.principal);

  const body = await readJson<{
    name?: string;
    scopes?: Array<{ repository?: string; actions?: string[] }>;
    project?: string;
    expiresInDays?: number;
  }>(ctx.request);

  if (typeof body.name !== "string" || body.name.trim() === "") throw badRequest("name is required");
  if (!Array.isArray(body.scopes) || body.scopes.length === 0)
    throw badRequest("at least one scope is required");

  if (pinned !== null && body.project !== undefined && body.project !== pinned) {
    throw badRequest(`the body names project "${body.project}", but the path names "${pinned}"`);
  }

  const project = pinned ?? body.project ?? "";
  if (project === "") {
    throw badRequest("project is required: an access token may not reach the whole registry");
  }
  // Whether the project exists is not disclosed here: a caller who cannot grant
  // on it is refused by the scope check below either way, and reporting "does
  // not exist" would turn this into an existence oracle for guessed names. A
  // token pinned to a project that does not exist yet reaches nothing until it does.
  if (!isValidProjectName(project)) throw badRequest(`"${project}" is not a valid project name`);

  const authorize = authorizeFor(ctx);
  const scopes: Scope[] = [];
  for (const scope of body.scopes) {
    if (typeof scope.repository !== "string" || scope.repository === "")
      throw badRequest("scope.repository is required");
    if (!Array.isArray(scope.actions) || scope.actions.length === 0)
      throw badRequest("scope.actions is required");

    const actions = scope.actions.filter(isAction);
    if (actions.length !== scope.actions.length)
      throw badRequest("scope.actions may only contain pull, push, delete");

    // A token may never grant what its creator does not already hold.
    //
    // A wildcard is checked against the thing it stands for. Pinned to a
    // project, `*` means "everywhere in this project", so the project name is
    // the probe and any of its owners may mint one.
    if (scope.repository === "*") {
      for (const action of actions) await assertAllowed(authorize, project, action);
    } else {
      // A named scope outside the pinned project could never authorize anything,
      // and reads as a permission the token does not have. Refuse it outright.
      if (projectOf(scope.repository) !== project) {
        throw badRequest(`scope "${scope.repository}" lies outside the "${project}" project`);
      }
      const probe = scope.repository.endsWith("/*") ? scope.repository.slice(0, -2) : scope.repository;
      for (const action of actions) await assertAllowed(authorize, probe, action);
    }

    scopes.push({ repository: scope.repository, actions });
  }

  if (identity.id === "bootstrap") await ctx.admin.ensureBootstrapUser(identity.username);

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const secret = generateTokenSecret();
  const expiresAt =
    typeof body.expiresInDays === "number" && body.expiresInDays > 0
      ? Date.now() + body.expiresInDays * DAY_MS
      : null;

  const summary = await ctx.admin.createToken({
    id,
    name: body.name.trim(),
    userId: identity.id,
    secretHash: await hashTokenSecret(secret),
    scopes,
    project,
    expiresAt,
  });

  await ctx.audit.record({
    actor: actorOf(ctx.principal),
    action: "token.create",
    resourceType: "token",
    resource: id,
    project,
    detail: { name: summary.name, scopes: summary.scopes, expiresAt },
  });

  // The only time the secret is ever visible.
  const created: CreatedAccessToken = { ...summary, secret: formatAccessToken(id, secret) };
  return Response.json(created, { status: 201 });
}

async function assertAllowed(
  authorize: ReturnType<typeof authorizeFor>,
  repositoryName: string,
  action: Action,
): Promise<void> {
  try {
    await authorize(repositoryName, action);
  } catch {
    throw forbidden(`you may not grant ${action} on "${repositoryName}"`);
  }
}

async function revokeToken(ctx: Context, id: string): Promise<Response> {
  if (ctx.request.method !== "DELETE") throw notFound();
  const identity = requireUser(ctx.principal);
  if (!(await ctx.admin.revokeToken(identity.id, id))) throw notFound();

  await ctx.audit.record({
    actor: actorOf(ctx.principal),
    action: "token.revoke",
    resourceType: "token",
    resource: id,
  });

  return new Response(null, { status: 204 });
}

const AUDIT_RESOURCE_TYPES = new Set<AuditResourceType>([
  "project",
  "repository",
  "artifact",
  "user",
  "token",
]);

function auditResourceType(raw: string | null): AuditResourceType | undefined {
  if (raw === null || raw === "") return undefined;
  if (!AUDIT_RESOURCE_TYPES.has(raw as AuditResourceType)) {
    throw badRequest(`"${raw}" is not an audited resource type`);
  }
  return raw as AuditResourceType;
}

function auditFilter(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

/**
 * `GET /audit` - who changed what.
 *
 * Administrators only. The log spans every project, and a project owner who
 * could read it would learn the names of repositories in projects they cannot
 * see. Scoping a per-project view is a larger change than the audit itself.
 */
async function auditLog(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "GET") throw notFound();
  requireAdmin(ctx.principal);

  const raw = Number(ctx.url.searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(raw) && raw >= 1 ? Math.min(raw, 200) : 50;

  const page = await ctx.audit.list({
    resourceType: auditResourceType(ctx.url.searchParams.get("resourceType")),
    project: auditFilter(ctx.url, "project"),
    actor: auditFilter(ctx.url, "actor"),
    action: auditFilter(ctx.url, "action"),
    cursor: auditFilter(ctx.url, "cursor"),
    limit,
  });

  return Response.json(page);
}

async function listUsers(ctx: Context): Promise<Response> {
  requireAdmin(ctx.principal);
  return Response.json({ users: await ctx.admin.listUsers() });
}

async function createUser(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  requireAdmin(ctx.principal);

  const body = await readJson<{ username?: string; password?: string; email?: string; isAdmin?: boolean }>(
    ctx.request,
  );
  if (typeof body.username !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(body.username)) {
    throw badRequest("username must be 2-64 lowercase characters, starting alphanumeric");
  }
  if (typeof body.password !== "string" || body.password.length < 12) {
    throw badRequest("password must be at least 12 characters");
  }

  const email = await requireFreeEmail(ctx, body.email, null);

  if ((await ctx.auth.findUserByUsername(body.username)) !== null) {
    throw conflict(`user "${body.username}" already exists`);
  }

  const user = await ctx.admin.createUser({
    id: crypto.randomUUID(),
    username: body.username,
    email,
    passwordHash: await hashPassword(body.password),
    isAdmin: body.isAdmin === true,
  });

  await ctx.audit.record({
    actor: actorOf(ctx.principal),
    action: "user.create",
    resourceType: "user",
    resource: user.id,
    detail: { username: user.username, email: user.email, isAdmin: user.isAdmin },
  });

  return Response.json(user, { status: 201 });
}

/**
 * A valid address that no other account holds.
 *
 * `owner` is the account the address is being assigned to, so that saving a
 * user without changing their email is not a conflict with themselves. The
 * check races the unique index, which is the thing that actually decides;
 * losing the race gives a 500 rather than a 409, and no duplicate.
 */
async function requireFreeEmail(ctx: Context, raw: unknown, owner: string | null): Promise<string> {
  const email = normalizeEmail(raw);
  if (email === null) throw badRequest("email is required");
  if (!isEmailAddress(email)) throw badRequest(`"${email}" is not an email address`);

  const holder = await ctx.admin.findUserIdByEmail(email);
  if (holder !== null && holder !== owner) throw conflict(`"${email}" is already in use`);
  return email;
}

/** `/users/:id`. `DELETE` removes the account; `PATCH` changes its address. */
async function userRoute(ctx: Context, id: string): Promise<Response> {
  if (ctx.request.method === "PATCH") return updateUser(ctx, id);
  if (ctx.request.method !== "DELETE") throw notFound();

  const identity = requireAdmin(ctx.principal);
  if (identity.id === id) throw badRequest("you cannot delete your own account");
  if (id === "bootstrap") throw badRequest("the bootstrap administrator cannot be deleted");

  // Read before the delete, so the row can name whom it was. There is no
  // foreign key from `audit_events` to `users`, precisely so this survives.
  const doomed = await ctx.auth.findUserById(id);
  if (!(await ctx.admin.deleteUser(id))) throw notFound();

  await ctx.audit.record({
    actor: actorOf(ctx.principal),
    action: "user.delete",
    resourceType: "user",
    resource: id,
    detail: { username: doomed?.username ?? null },
  });

  return new Response(null, { status: 204 });
}

/** An administrator may change any address; anyone else may change only their own. */
async function updateUser(ctx: Context, id: string): Promise<Response> {
  const identity = requireUser(ctx.principal);
  if (!identity.isAdmin && identity.id !== id) {
    throw forbidden("you may only change your own email address");
  }

  const body = await readJson<{ email?: unknown }>(ctx.request);
  if (!("email" in body)) throw badRequest("email is required");

  const email = await requireFreeEmail(ctx, body.email, id);
  const user = await ctx.admin.setUserEmail(id, email);
  if (user === null) throw notFound(`user "${id}" does not exist`);

  await ctx.audit.record({
    actor: actorOf(ctx.principal),
    action: "user.update",
    resourceType: "user",
    resource: id,
    detail: { username: user.username, email },
  });

  return Response.json(user);
}

/** `GET /v2/_catalog` - the Docker catalog endpoint, outside the OCI spec but widely used. */
export async function handleCatalog(
  request: Request,
  env: Env,
  principal: Principal,
  authorize: Authorize,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  // Registry-scope authorization. When anonymous pull is disabled this
  // challenges an anonymous caller rather than quietly listing public names.
  await authorize("", "pull");

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("n") ?? "100") || 100, 1000);
  const last = url.searchParams.get("last");

  const admin = new AdminStore(env.DB);
  const page = await admin.catalog(limit, last, viewerOf(principal), tokenProjectPin(principal));

  const headers = new Headers({ "Content-Type": "application/json" });
  if (page.hasMore && page.names.length > 0) {
    const next = new URLSearchParams({ n: String(limit), last: page.names[page.names.length - 1]! });
    headers.set("Link", `</v2/_catalog?${next.toString()}>; rel="next"`);
  }

  return new Response(JSON.stringify({ repositories: page.names }), { headers });
}
