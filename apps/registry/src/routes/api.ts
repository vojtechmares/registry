import { OciError, isValidDigest, isValidRepositoryName } from "@registry/oci";
import type { Action, Authorize } from "@registry/registry-core";
import { createAuthorize } from "../auth/authorize.js";
import type { RegistryConfig } from "../auth/config.js";
import { formatAccessToken, generateTokenSecret, hashPassword, hashTokenSecret } from "../auth/password.js";
import {
  ANONYMOUS,
  authenticateCredentials,
  resolvePrincipal,
  type Identity,
  type Principal,
} from "../auth/principal.js";
import { isAction, type Scope } from "../auth/scopes.js";
import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
  verifySessionCookie,
} from "../auth/session.js";
import { AuthStore } from "../auth/store.js";
import type { Env } from "../env.js";
import { AdminStore } from "../storage/admin.js";
import type { CreatedAccessToken, LifecyclePolicy, Visibility } from "@registry/api-contract";

const PREFIX = "/api/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const badRequest = (message: string) => new ApiError(400, "invalid_request", message);
const notFound = (message = "not found") => new ApiError(404, "not_found", message);
const forbidden = (message = "forbidden") => new ApiError(403, "forbidden", message);
const unauthenticated = (message = "authentication required") => new ApiError(401, "unauthorized", message);

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

function requireIdentity(principal: Principal): Identity {
  if (principal.kind === "anonymous") throw unauthenticated();
  return principal.identity;
}

/**
 * The control plane - accounts, tokens, registry stats - is reachable only by a
 * signed-in human, never by a machine token.
 *
 * A machine token is a data-plane credential: it exists to pull and push within
 * a declared set of scopes. Were the control-plane guards to check only
 * `isAdmin`, a narrow token minted by an administrator could create a fresh
 * admin user and escalate straight past its own confinement. Repository
 * management (visibility, deletion, policy) stays open to tokens because those
 * routes re-check the token's scopes through `authorize`; the identity-gated
 * routes below do not, so they must exclude tokens outright.
 */
function requireUser(principal: Principal): Identity {
  const identity = requireIdentity(principal);
  if (principal.kind === "token") throw forbidden("access tokens may not manage accounts or other tokens");
  return identity;
}

function requireAdmin(principal: Principal): Identity {
  const identity = requireUser(principal);
  if (!identity.isAdmin) throw forbidden("administrator privileges are required");
  return identity;
}

/**
 * A cross-site form post cannot set this header, and `SameSite=Strict` already
 * stops the cookie from riding along. Requiring it makes state-changing calls
 * unreachable from another origin.
 */
function requireJsonBody(request: Request): void {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("application/json")) {
    throw badRequest("mutations must send a JSON body");
  }
}

async function readJson<T>(request: Request): Promise<T> {
  requireJsonBody(request);
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest("body is not valid JSON");
  }
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
  const path = url.pathname.slice(PREFIX.length);
  const secure = url.protocol === "https:";

  try {
    const principal = await resolveApiPrincipal(request, auth, config);
    return await dispatch({ request, url, path, principal, auth, admin, config, secure, env });
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
  config: RegistryConfig;
  secure: boolean;
  env: Env;
}

async function dispatch(ctx: Context): Promise<Response> {
  const { path, request } = ctx;

  if (path === "/auth/login") return login(ctx);
  if (path === "/auth/logout") return logout(ctx);
  if (path === "/auth/session") return session(ctx);
  if (path === "/stats") return stats(ctx);
  if (path === "/repositories") return listRepositories(ctx);
  if (path === "/tokens") return request.method === "GET" ? listTokens(ctx) : createToken(ctx);
  if (path.startsWith("/tokens/")) return revokeToken(ctx, path.slice("/tokens/".length));
  if (path === "/users") return request.method === "GET" ? listUsers(ctx) : createUser(ctx);
  if (path.startsWith("/users/")) return deleteUser(ctx, path.slice("/users/".length));

  // Repository names contain slashes, so the fixed suffix decides the route.
  if (path.startsWith("/repositories/")) {
    const rest = path.slice("/repositories/".length);

    const manifest = /^(.+)\/manifests\/([^/]+)$/.exec(rest);
    if (manifest !== null) return getManifest(ctx, manifest[1]!, manifest[2]!);

    const tags = /^(.+)\/tags$/.exec(rest);
    if (tags !== null) return getTags(ctx, tags[1]!);

    const policy = /^(.+)\/policy$/.exec(rest);
    if (policy !== null) return repositoryPolicy(ctx, policy[1]!);

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

async function stats(ctx: Context): Promise<Response> {
  requireAdmin(ctx.principal);
  return Response.json(await ctx.admin.stats());
}

async function listRepositories(ctx: Context): Promise<Response> {
  const search = ctx.url.searchParams.get("search");
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "100") || 100, 500);

  const visibleTo =
    ctx.principal.kind === "anonymous"
      ? null
      : { username: ctx.principal.identity.username, isAdmin: ctx.principal.identity.isAdmin };

  return Response.json({ repositories: await ctx.admin.listRepositories({ search, limit, visibleTo }) });
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

  if (ctx.request.method === "PATCH") {
    await authorize(name, "delete");
    const body = await readJson<{ visibility?: Visibility }>(ctx.request);
    if (body.visibility !== "public" && body.visibility !== "private") {
      throw badRequest('visibility must be "public" or "private"');
    }
    if (!(await ctx.admin.setVisibility(name, body.visibility))) throw notFound();
    return Response.json({ name, visibility: body.visibility });
  }

  if (ctx.request.method === "DELETE") {
    await authorize(name, "delete");
    if (!(await ctx.admin.deleteRepository(name))) throw notFound();
    return new Response(null, { status: 204 });
  }

  throw notFound();
}

async function getTags(ctx: Context, rawName: string): Promise<Response> {
  const name = validName(rawName);
  await authorizeFor(ctx)(name, "pull");
  return Response.json({ tags: await ctx.admin.tags(name) });
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

function optionalPositive(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${field} must be a positive integer or null`);
  }
  return value;
}

async function listTokens(ctx: Context): Promise<Response> {
  const identity = requireUser(ctx.principal);
  return Response.json({ tokens: await ctx.admin.listTokens(identity.id) });
}

async function createToken(ctx: Context): Promise<Response> {
  if (ctx.request.method !== "POST") throw notFound();
  // A machine token must not manage tokens at all, let alone mint a wider one.
  const identity = requireUser(ctx.principal);

  const body = await readJson<{
    name?: string;
    scopes?: Array<{ repository?: string; actions?: string[] }>;
    expiresInDays?: number;
  }>(ctx.request);

  if (typeof body.name !== "string" || body.name.trim() === "") throw badRequest("name is required");
  if (!Array.isArray(body.scopes) || body.scopes.length === 0)
    throw badRequest("at least one scope is required");

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

    // A token may never grant what its creator does not already hold. Wildcards
    // are checked against their literal prefix, which an administrator alone owns.
    const probe = scope.repository.endsWith("/*") ? scope.repository.slice(0, -2) : scope.repository;
    if (scope.repository === "*" && !identity.isAdmin)
      throw forbidden("only administrators may scope a token to `*`");
    if (scope.repository !== "*") {
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
    expiresAt,
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
  return new Response(null, { status: 204 });
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

  if ((await ctx.auth.findUserByUsername(body.username)) !== null) {
    throw new ApiError(409, "conflict", `user "${body.username}" already exists`);
  }

  const user = await ctx.admin.createUser({
    id: crypto.randomUUID(),
    username: body.username,
    email: typeof body.email === "string" && body.email !== "" ? body.email : null,
    passwordHash: await hashPassword(body.password),
    isAdmin: body.isAdmin === true,
  });

  return Response.json(user, { status: 201 });
}

async function deleteUser(ctx: Context, id: string): Promise<Response> {
  if (ctx.request.method !== "DELETE") throw notFound();
  const identity = requireAdmin(ctx.principal);
  if (identity.id === id) throw badRequest("you cannot delete your own account");
  if (id === "bootstrap") throw badRequest("the bootstrap administrator cannot be deleted");
  if (!(await ctx.admin.deleteUser(id))) throw notFound();
  return new Response(null, { status: 204 });
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
  const viewer =
    principal.kind === "anonymous"
      ? null
      : { username: principal.identity.username, isAdmin: principal.identity.isAdmin };
  const page = await admin.catalog(limit, last, viewer);

  const headers = new Headers({ "Content-Type": "application/json" });
  if (page.hasMore && page.names.length > 0) {
    const next = new URLSearchParams({ n: String(limit), last: page.names[page.names.length - 1]! });
    headers.set("Link", `</v2/_catalog?${next.toString()}>; rel="next"`);
  }

  return new Response(JSON.stringify({ repositories: page.names }), { headers });
}
