import type { Env } from "../env.js";

export interface RegistryConfig {
  readonly jwtSecret: string;
  /** Issuer and audience of session tokens. Pinned so tokens cannot cross deployments. */
  readonly issuer: string;
  readonly service: string;
  readonly realm: string;
  readonly allowAnonymousPull: boolean;
  readonly bootstrapAdmin: { readonly username: string; readonly passwordHash: string } | null;
  readonly tokenTtlSeconds: number;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

/** A positive integer, or the fallback. Guards against a `NaN` TTL that would never expire. */
function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readConfig(env: Env, request: Request): RegistryConfig {
  const url = new URL(request.url);
  const service = env.REGISTRY_HOST ?? url.host;

  return {
    jwtSecret: env.JWT_SECRET,
    issuer: `https://${service}`,
    service,
    realm: `${url.protocol}//${url.host}/v2/token`,
    allowAnonymousPull: flag(env.ALLOW_ANONYMOUS_PULL, true),
    bootstrapAdmin:
      env.BOOTSTRAP_ADMIN_USERNAME !== undefined && env.BOOTSTRAP_ADMIN_PASSWORD_HASH !== undefined
        ? { username: env.BOOTSTRAP_ADMIN_USERNAME, passwordHash: env.BOOTSTRAP_ADMIN_PASSWORD_HASH }
        : null,
    tokenTtlSeconds: positiveInt(env.TOKEN_TTL_SECONDS, 300),
  };
}
