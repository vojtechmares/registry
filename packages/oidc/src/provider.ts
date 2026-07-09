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

/**
 * Fetches the provider's discovery document.
 *
 * The `issuer` inside it must equal the issuer we asked about, exactly. A
 * document that claims a different issuer is a document served by someone who
 * is not that issuer, and every later check - which compares the ID token's
 * `iss` against this one - would then be checking against a lie.
 */
export async function discover(issuer: string, options: DiscoveryOptions = {}): Promise<ProviderMetadata> {
  const fetcher = options.fetch ?? fetch;
  const base = issuer.replace(/\/+$/, "");
  const url = `${base}/.well-known/openid-configuration`;

  const response = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);

  const metadata = (await response.json()) as ProviderMetadata;
  if (metadata.issuer !== base && metadata.issuer !== issuer) {
    throw new Error(`OIDC issuer mismatch: asked ${issuer}, document says ${metadata.issuer}`);
  }
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof metadata[field] !== "string") throw new Error(`OIDC discovery document lacks ${field}`);
  }

  return metadata;
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

/**
 * Trades the authorization code for tokens.
 *
 * The client secret goes in the body rather than in a Basic header. Both are
 * permitted; providers disagree about which they accept, and the body form is
 * the one they all do.
 */
export async function exchangeCode(options: ExchangeOptions): Promise<TokenResponse> {
  const fetcher = options.fetch ?? fetch;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  });
  if (options.clientSecret !== null) body.set("client_secret", options.clientSecret);

  const response = await fetcher(options.metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });

  if (!response.ok) throw new Error(`OIDC token exchange failed: ${response.status}`);

  const tokens = (await response.json()) as TokenResponse;
  if (typeof tokens.id_token !== "string") throw new Error("OIDC token response carried no id_token");
  return tokens;
}
