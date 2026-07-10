import { OciError, unauthorized } from "@registry/oci";
import type { RegistryConfig } from "./config.js";
import { verifyJwt } from "./jwt.js";
import { hashTokenSecret, parseAccessToken, timingSafeEqualString, verifyPassword } from "./password.js";
import type { Scope } from "./scopes.js";
import { AuthStore } from "./store.js";

export interface Identity {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

export type Principal =
  | { readonly kind: "anonymous" }
  /** A human, authenticated by password or by a session JWT. Full user permissions. */
  | { readonly kind: "user"; readonly identity: Identity }
  /**
   * A machine credential. It acts as its owning user but is additionally
   * confined to `scopes`, so it can never exceed the user who created it.
   */
  | {
      readonly kind: "token";
      readonly identity: Identity;
      readonly scopes: readonly Scope[];
      /** Non-null pins the token to one project, whatever its scopes say. */
      readonly project: string | null;
      readonly tokenId: string;
    };

export const ANONYMOUS: Principal = { kind: "anonymous" };

export function identityOf(principal: Principal): Identity | null {
  return principal.kind === "anonymous" ? null : principal.identity;
}

function decodeBasic(value: string): { username: string; password: string } | null {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Resolves the caller from `Authorization`.
 *
 * Bad credentials are a 401, never a silent downgrade to anonymous: a client
 * that mistyped a password must be told, not quietly served the public subset.
 */
export async function resolvePrincipal(
  request: Request,
  store: AuthStore,
  config: RegistryConfig,
): Promise<Principal> {
  const header = request.headers.get("Authorization");
  if (header === null) return ANONYMOUS;

  const space = header.indexOf(" ");
  if (space === -1) throw unauthorized("malformed Authorization header");
  const scheme = header.slice(0, space).toLowerCase();
  const credentials = header.slice(space + 1).trim();

  if (scheme === "basic") {
    const parsed = decodeBasic(credentials);
    if (parsed === null) throw unauthorized("malformed Basic credentials");
    return authenticateCredentials(parsed.username, parsed.password, store, config);
  }

  if (scheme === "bearer") {
    return authenticateBearer(credentials, store, config);
  }

  throw unauthorized(`unsupported authentication scheme "${scheme}"`);
}

/**
 * Username and password, from a Basic header or from the body of an OAuth2
 * password grant. Both carry the same credentials and must resolve identically.
 */
export async function authenticateCredentials(
  username: string,
  password: string,
  store: AuthStore,
  config: RegistryConfig,
): Promise<Principal> {
  // A machine token is recognisable on sight, so it never has to be tried as a
  // password (which would cost a needless PBKDF2 derivation).
  const token = parseAccessToken(password);
  if (token !== null) return authenticateAccessToken(token.id, token.secret, store);

  // Bootstrap administrator, held in a secret rather than the database. This is
  // how the first user is created on a fresh deployment.
  if (config.bootstrapAdmin !== null && timingSafeEqualString(username, config.bootstrapAdmin.username)) {
    if (await verifyPassword(password, config.bootstrapAdmin.passwordHash)) {
      return { kind: "user", identity: { id: "bootstrap", username, isAdmin: true } };
    }
    throw unauthorized("invalid credentials");
  }

  const user = await store.findUserByUsername(username);
  if (user === null || user.disabled) {
    // Still derive a hash so a missing user and a wrong password take the same
    // time, and username enumeration gains nothing.
    await verifyPassword(password, DUMMY_HASH);
    throw unauthorized("invalid credentials");
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized("invalid credentials");

  return { kind: "user", identity: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
}

/**
 * A token that names no project reaches every project its owner can, which is
 * the blast radius a leaked CI credential should never have. Tokens are pinned
 * at creation now, so the only rows that are not are the ones minted before
 * that rule existed. They authenticate nothing.
 *
 * 401 rather than 403: the credential is not acceptable, and the remedy is to
 * present a different one.
 */
const UNPINNED_TOKEN =
  "this access token is not scoped to a project and is no longer accepted; issue a new one from the project";

async function authenticateAccessToken(id: string, secret: string, store: AuthStore): Promise<Principal> {
  const token = await store.findAccessToken(id);
  if (token === null || token.revoked) throw unauthorized("invalid or revoked access token");
  if (token.expiresAt !== null && token.expiresAt <= Date.now())
    throw unauthorized("access token has expired");

  if (!timingSafeEqualString(await hashTokenSecret(secret), token.secretHash)) {
    throw unauthorized("invalid or revoked access token");
  }

  // After the secret is verified, so that the message cannot be used to sort
  // guessed token ids into "exists but unpinned" and "does not exist".
  if (token.project === null) throw unauthorized(UNPINNED_TOKEN);

  const user = await store.findUserById(token.userId);
  if (user === null || user.disabled) throw unauthorized("the token's owner is no longer active");

  return {
    kind: "token",
    tokenId: token.id,
    identity: { id: user.id, username: user.username, isAdmin: user.isAdmin },
    scopes: token.scopes,
    project: token.project,
  };
}

async function authenticateBearer(
  token: string,
  store: AuthStore,
  config: RegistryConfig,
): Promise<Principal> {
  const claims = await verifyJwt(token, config.jwtSecret, {
    issuer: config.issuer,
    audience: config.service,
  });
  if (claims === null) throw unauthorized("invalid or expired token");

  // An anonymous token carries no identity, so it must not present one. Were it
  // treated as a principal, a request it cannot satisfy would be answered 403
  // "forbidden" - which tells the client to give up - instead of 401, which
  // tells it to come back with credentials. Docker fetches an anonymous token
  // before it ever offers a password, so the difference decides whether a push
  // can start at all.
  if (claims.sub === "anonymous") return ANONYMOUS;

  const identity: Identity = { id: claims.sub, username: claims.name, isAdmin: claims.admin };

  // A JWT minted from a machine token inherits that token's confinement - both
  // halves of it. Dropping the project here would let a token scoped to one
  // project trade itself, at `/v2/token`, for a bearer token that reaches every
  // project its owner can.
  const confined = claims as { scopes?: Scope[]; project?: string | null };
  if (confined.scopes !== undefined) {
    // A bearer minted from an unpinned access token before pinning was required.
    // Its parent no longer authenticates, and neither may it.
    const project = confined.project ?? null;
    if (project === null) throw unauthorized(UNPINNED_TOKEN);

    return { kind: "token", tokenId: claims.jti, identity, scopes: confined.scopes, project };
  }

  // Session tokens for the bootstrap admin never touch the database.
  if (claims.sub === "bootstrap") return { kind: "user", identity };

  const user = await store.findUserById(claims.sub);
  if (user === null || user.disabled) throw unauthorized("the token's subject is no longer active");
  return { kind: "user", identity: { id: user.id, username: user.username, isAdmin: user.isAdmin } };
}

export function isOciError(error: unknown): error is OciError {
  return error instanceof OciError;
}

/** A real PBKDF2 hash of a random password, used only to equalise timing. */
const DUMMY_HASH = "pbkdf2$100000$hXncAldFBm8bhU0jklAJiw==$9ueXPCz+2qMqCW8uytg6jJndROgP9/eWbwuLdnzv24A=";
