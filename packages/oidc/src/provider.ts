import * as oauth from "oauth4webapi";
import type { Jwk } from "./verify.js";

/** The subset of the discovery document this registry uses. */
export interface ProviderMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly userinfo_endpoint?: string;
}

export interface DiscoveryOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A factory the library calls once per request, so each gets its own timeout. */
function timeoutSignal(options: DiscoveryOptions): () => AbortSignal {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return () => AbortSignal.timeout(timeoutMs);
}

/**
 * Fetches the provider's discovery document.
 *
 * `oauth4webapi` performs the fetch and then insists the `issuer` inside the
 * document equals the one we asked about: a document that claims a different
 * issuer is served by someone who is not that issuer, and every later check -
 * which compares the ID token's `iss` against this one - would then be checking
 * against a lie. The three endpoints this registry drives are required to be
 * present before the document is trusted.
 */
export async function discover(issuer: string, options: DiscoveryOptions = {}): Promise<ProviderMetadata> {
  const issuerUrl = new URL(issuer.replace(/\/+$/, ""));

  const requestOptions: oauth.DiscoveryRequestOptions = { algorithm: "oidc", signal: timeoutSignal(options) };
  if (options.fetch !== undefined) {
    const injected = options.fetch;
    requestOptions[oauth.customFetch] = (url, init) => injected(url, init as unknown as RequestInit);
  }

  const response = await oauth.discoveryRequest(issuerUrl, requestOptions);
  const as = await oauth.processDiscoveryResponse(issuerUrl, response);

  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof as[field] !== "string") throw new Error(`OIDC discovery document lacks ${field}`);
  }

  const metadata: ProviderMetadata = {
    issuer: as.issuer,
    authorization_endpoint: as.authorization_endpoint as string,
    token_endpoint: as.token_endpoint as string,
    jwks_uri: as.jwks_uri as string,
  };
  return typeof as.userinfo_endpoint === "string"
    ? { ...metadata, userinfo_endpoint: as.userinfo_endpoint }
    : metadata;
}

export async function fetchJwks(uri: string, options: DiscoveryOptions = {}): Promise<Jwk[]> {
  const fetcher = options.fetch ?? fetch;
  const response = await fetcher(uri, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  if (!response.ok) throw new Error(`OIDC key fetch failed: ${response.status}`);

  const body = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("OIDC key set is malformed");
  // A signing key set that also holds encryption keys must not offer them here.
  return body.keys.filter((key) => key.use === undefined || key.use === "sig");
}

export interface AuthorizationUrlOptions {
  readonly metadata: ProviderMetadata;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly scope?: string;
}

export function authorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(options.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", options.scope ?? "openid profile email");
  url.searchParams.set("state", options.state);
  url.searchParams.set("nonce", options.nonce);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenResponse {
  readonly id_token: string;
  readonly access_token?: string;
  readonly token_type?: string;
}

export interface ExchangeOptions {
  readonly metadata: ProviderMetadata;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly redirectUri: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** The discovery subset, in the shape `oauth4webapi` reads its endpoints from. */
function authorizationServer(metadata: ProviderMetadata): oauth.AuthorizationServer {
  return {
    issuer: metadata.issuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    jwks_uri: metadata.jwks_uri,
  };
}

/**
 * Trades the authorization code for tokens, through `oauth4webapi`.
 *
 * The `state` is not rechecked here - the flow layer already compared it,
 * constant time, against the value in its signed cookie - so the callback is
 * validated with the state check skipped. Client authentication is
 * `client_secret_post` when a secret is configured and `none` when it is not:
 * the secret goes in the body, the form every provider accepts. The ID token in
 * the response is verified separately, by `verifyIdToken`, against the JWKS.
 */
export async function exchangeCode(options: ExchangeOptions): Promise<TokenResponse> {
  const as = authorizationServer(options.metadata);
  const client: oauth.Client = { client_id: options.clientId };
  const clientAuth =
    options.clientSecret !== null ? oauth.ClientSecretPost(options.clientSecret) : oauth.None();

  const callback = oauth.validateAuthResponse(
    as,
    client,
    new URLSearchParams({ code: options.code }),
    oauth.skipStateCheck,
  );

  const requestOptions: oauth.TokenEndpointRequestOptions = { signal: timeoutSignal(options) };
  if (options.fetch !== undefined) {
    const injected = options.fetch;
    requestOptions[oauth.customFetch] = (url, init) => injected(url, init as unknown as RequestInit);
  }

  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    callback,
    options.redirectUri,
    options.codeVerifier,
    requestOptions,
  );

  if (!response.ok) throw new Error(`OIDC token exchange failed: ${response.status}`);

  const tokens = (await response.json()) as TokenResponse;
  if (typeof tokens.id_token !== "string") throw new Error("OIDC token response carried no id_token");
  return tokens;
}
