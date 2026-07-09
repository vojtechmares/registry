import { OciError } from "@registry/oci";
import { type Action, decideAccess } from "@registry/projects";
import { accessPrincipal, challenge } from "../auth/authorize.js";
import type { RegistryConfig } from "../auth/config.js";
import { signJwt, type RegistryClaims } from "../auth/jwt.js";
import { authenticateCredentials, type Principal } from "../auth/principal.js";
import { parseScopeParameter, toAccessClaim, type Scope } from "../auth/scopes.js";
import type { AuthStore } from "../auth/store.js";

/**
 * `/v2/token` - where a client goes after a 401 to trade credentials for a bearer token.
 *
 * Two shapes exist and clients pick between them without asking.
 *
 * `GET` is the original Docker flow: credentials in an `Authorization: Basic`
 * header, scope in the query string.
 *
 * `POST` is the OAuth2 flow, and it is what the Docker CLI actually uses. The
 * credentials arrive in a form-encoded body, *not* in a header, so a handler
 * that only inspects `Authorization` sees an anonymous request and hands back a
 * token that grants nothing.
 *
 * The issued JWT identifies the principal rather than freezing a scope set: the
 * registry re-evaluates permissions per request against the live membership
 * table, so revoking access takes effect within the token's short lifetime
 * rather than only at expiry. A machine token is the exception - its
 * confinement is copied into the JWT so exchanging it can never widen it.
 */
export async function handleToken(
  request: Request,
  principal: Principal,
  store: AuthStore,
  config: RegistryConfig,
): Promise<Response> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const scopes = parseScopeParameter(url.searchParams.getAll("scope").join(" "));
    return issueFor(principal, scopes, store, config);
  }

  if (request.method === "POST") return oauthGrant(request, principal, store, config);

  return new Response("method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
}

async function oauthGrant(
  request: Request,
  principal: Principal,
  store: AuthStore,
  config: RegistryConfig,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "expected a form-encoded body");
  }

  const grantType = form.get("grant_type");
  const scopes = parseScopeParameter(form.getAll("scope").join(" "));

  // An Authorization header still wins if one was sent; otherwise the password
  // grant carries the credentials in the body.
  let resolved = principal;
  if (resolved.kind === "anonymous" && grantType === "password") {
    const username = form.get("username");
    const password = form.get("password");
    if (typeof username !== "string" || typeof password !== "string" || username === "") {
      return oauthError("invalid_request", "the password grant requires username and password");
    }
    resolved = await authenticateCredentials(username, password, store, config);
  } else if (resolved.kind === "anonymous" && grantType !== null && grantType !== "password") {
    // `refresh_token` and the rest are deliberately unsupported: this registry
    // issues short-lived tokens and expects the client to re-present its
    // credentials, which the Docker CLI does without complaint.
    return oauthError("unsupported_grant_type", `unsupported grant_type "${String(grantType)}"`);
  }

  return issueFor(resolved, scopes, store, config);
}

function oauthError(code: string, description: string): Response {
  return Response.json({ error: code, error_description: description }, { status: 400 });
}

async function issueFor(
  principal: Principal,
  requested: readonly Scope[],
  store: AuthStore,
  config: RegistryConfig,
): Promise<Response> {
  if (principal.kind === "anonymous" && !config.allowAnonymousPull) {
    return new Response(
      JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }),
      {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": challenge(config) },
      },
    );
  }

  const granted = await grant(principal, requested, store, config);

  if (principal.kind === "anonymous") {
    // A token that names no subject. It grants exactly what an unauthenticated
    // request already gets, and exists only so clients that insist on the token
    // flow can complete it.
    return issue(config, { id: "anonymous", username: "", isAdmin: false }, granted, true);
  }

  return issue(
    config,
    principal.identity,
    granted,
    false,
    principal.kind === "token" ? { scopes: principal.scopes, project: principal.project } : undefined,
  );
}

/**
 * The subset of the requested scopes the caller actually holds, decided by the
 * very rules that gate the registry itself. Any second implementation of
 * "may this caller push here" would eventually disagree with the first, and the
 * disagreement would be a token minted for access the request path refuses -
 * or, far worse, one it does not.
 */
async function grant(
  principal: Principal,
  requested: readonly Scope[],
  store: AuthStore,
  config: RegistryConfig,
): Promise<Scope[]> {
  const caller = accessPrincipal(principal);
  const userId = principal.kind === "anonymous" ? null : principal.identity.id;

  const granted: Scope[] = [];
  for (const scope of requested) {
    const project = await store.projectAccess(scope.repository, userId);
    const actions: Action[] = [];

    for (const action of scope.actions) {
      const decision = decideAccess({
        repository: scope.repository,
        action,
        principal: caller,
        project,
        allowAnonymousPull: config.allowAnonymousPull,
      });
      if (decision.kind === "allow") actions.push(action);
    }

    if (actions.length > 0) granted.push({ repository: scope.repository, actions });
  }
  return granted;
}

function scopeString(scopes: readonly Scope[]): string {
  return scopes.map((scope) => `repository:${scope.repository}:${scope.actions.join(",")}`).join(" ");
}

/** What a machine token's JWT must carry forward, so exchanging it cannot widen it. */
interface Confinement {
  readonly scopes: readonly Scope[];
  readonly project: string | null;
}

async function issue(
  config: RegistryConfig,
  identity: { id: string; username: string; isAdmin: boolean },
  access: readonly Scope[],
  anonymous: boolean,
  confinement?: Confinement,
): Promise<Response> {
  if (config.jwtSecret === "")
    throw new OciError("UNSUPPORTED", "token issuance is not configured", { status: 500 });

  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: RegistryClaims & Partial<Confinement> = {
    sub: anonymous ? "anonymous" : identity.id,
    name: identity.username,
    admin: !anonymous && identity.isAdmin,
    access: toAccessClaim(access),
    iss: config.issuer,
    aud: config.service,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + config.tokenTtlSeconds,
    jti: crypto.randomUUID(),
    ...(confinement === undefined ? {} : { scopes: confinement.scopes, project: confinement.project }),
  };

  const token = await signJwt(claims as RegistryClaims, config.jwtSecret);
  return Response.json({
    // `token` for the classic flow, `access_token` for OAuth2. Clients read one
    // or the other and it costs nothing to answer both.
    token,
    access_token: token,
    scope: scopeString(access),
    expires_in: config.tokenTtlSeconds,
    issued_at: new Date(issuedAt * 1000).toISOString(),
  });
}
