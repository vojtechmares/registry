import {
  type IdTokenClaims,
  authorizationUrl,
  createAuthorizationRequest,
  discover,
  exchangeCode,
  fetchJwks,
  timingSafeEqual,
  verifyIdToken,
} from "@registry/oidc";
import type { Env } from "../env.js";
import { signJwt, verifyJwt } from "./jwt.js";
import type { RegistryConfig } from "./config.js";

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
  readonly adminGroups: readonly string[];
}

/** Null when the deployment has not configured single sign-on. */
export function readOidcConfig(env: Env, url: URL): OidcConfig | null {
  if (env.OIDC_ISSUER === undefined || env.OIDC_CLIENT_ID === undefined) return null;

  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET ?? null,
    redirectUri: env.OIDC_REDIRECT_URI ?? `${url.origin}/api/v1/auth/oidc/callback`,
    adminGroups: (env.OIDC_ADMIN_GROUPS ?? "")
      .split(",")
      .map((group) => group.trim())
      .filter((group) => group !== ""),
  };
}

/**
 * The flow's one-time values, carried between the two requests in a signed
 * cookie rather than in a table.
 *
 * There is no server-side state to expire, and a value the browser hands back
 * is only believed because we signed it. The cookie is `SameSite=Lax`: the
 * callback arrives as a top-level navigation from the provider, which `Strict`
 * would strip the cookie from, and `Lax` still refuses to send it on a
 * cross-site POST.
 */
export const OIDC_COOKIE = "registry_oidc";
const FLOW_TTL_SECONDS = 600;

interface FlowClaims {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** Where to send the browser once it is signed in. Always a path on this origin. */
  readonly next: string;
}

export async function sealFlow(flow: FlowClaims, config: RegistryConfig): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: "oidc-flow",
      name: "",
      admin: false,
      access: [],
      iss: config.issuer,
      aud: config.service,
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + FLOW_TTL_SECONDS,
      jti: crypto.randomUUID(),
      ...flow,
    } as never,
    config.jwtSecret,
  );
}

export async function openFlow(token: string, config: RegistryConfig): Promise<FlowClaims | null> {
  const claims = await verifyJwt(token, config.jwtSecret, {
    issuer: config.issuer,
    audience: config.service,
  });
  if (claims === null || claims.sub !== "oidc-flow") return null;

  const flow = claims as unknown as FlowClaims;
  if (typeof flow.state !== "string" || typeof flow.nonce !== "string" || typeof flow.verifier !== "string") {
    return null;
  }
  return flow;
}

export function flowCookie(value: string, secure: boolean, maxAge = FLOW_TTL_SECONDS): string {
  const parts = [`${OIDC_COOKIE}=${value}`, "Path=/api", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readFlowCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (header === null) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === OIDC_COOKIE) return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * Only a path on this origin, and never a scheme-relative one.
 *
 * `//evil.test` is a valid URL path to a browser and an open redirect to
 * everyone else, which is exactly the kind of thing a login flow gets used for.
 */
export function safeNext(raw: string | null): string {
  if (raw === null || raw === "") return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export interface StartedFlow {
  readonly authorizeUrl: string;
  readonly cookie: string;
}

export async function startFlow(
  config: OidcConfig,
  registry: RegistryConfig,
  next: string,
  secure: boolean,
): Promise<StartedFlow> {
  const metadata = await discover(config.issuer);
  const request = await createAuthorizationRequest();

  const cookie = await sealFlow(
    { state: request.state, nonce: request.nonce, verifier: request.codeVerifier, next },
    registry,
  );

  return {
    authorizeUrl: authorizationUrl({
      metadata,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state: request.state,
      nonce: request.nonce,
      codeChallenge: request.codeChallenge,
    }),
    cookie: flowCookie(cookie, secure),
  };
}

export class OidcError extends Error {}

/** Completes the flow, returning the provider's claims about who just signed in. */
export async function completeFlow(
  config: OidcConfig,
  registry: RegistryConfig,
  request: Request,
): Promise<{ claims: IdTokenClaims; next: string }> {
  const url = new URL(request.url);

  const error = url.searchParams.get("error");
  if (error !== null) throw new OidcError(`the identity provider refused: ${error}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) throw new OidcError("the callback carried no code");

  const sealed = readFlowCookie(request);
  if (sealed === null) throw new OidcError("no sign-in is in progress");

  const flow = await openFlow(sealed, registry);
  if (flow === null) throw new OidcError("the sign-in has expired");

  // Binds this callback to the browser that started the flow.
  if (!timingSafeEqual(state, flow.state)) throw new OidcError("state does not match");

  const metadata = await discover(config.issuer);
  const tokens = await exchangeCode({
    metadata,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    code,
    codeVerifier: flow.verifier,
  });

  const keys = await fetchJwks(metadata.jwks_uri);
  const result = await verifyIdToken(tokens.id_token, keys, {
    issuer: metadata.issuer,
    clientId: config.clientId,
    nonce: flow.nonce,
  });
  if (!result.ok) throw new OidcError(`the identity token is not valid: ${result.reason}`);

  return { claims: result.claims, next: safeNext(flow.next) };
}

/**
 * A local username for a federated identity.
 *
 * Derived from what the provider says, then squeezed into the shape a
 * repository namespace needs, since a user implicitly owns the project named
 * after them.
 */
export function usernameFor(claims: IdTokenClaims): string {
  const candidate = claims.preferred_username ?? claims.email?.split("@")[0] ?? claims.sub;
  const cleaned = candidate
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);

  return cleaned.length >= 2 ? cleaned : `user-${claims.sub.slice(0, 8).toLowerCase()}`;
}

export function isAdminByGroups(claims: IdTokenClaims, config: OidcConfig): boolean {
  if (config.adminGroups.length === 0) return false;
  const groups = Array.isArray(claims.groups) ? claims.groups : [];
  return groups.some((group) => config.adminGroups.includes(group));
}
