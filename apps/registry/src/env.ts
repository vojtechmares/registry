import { DEFAULT_CONFIG, type RegistryConfig as CoreConfig } from "@registry/registry-core";
import type { RateLimiterObject } from "./durable-objects/rate-limiter.js";
import type { UploadSessionObject } from "./durable-objects/upload-session.js";

export interface Env {
  readonly BUCKET: R2Bucket;
  readonly DB: D1Database;
  readonly UPLOAD_SESSION: DurableObjectNamespace<UploadSessionObject>;
  readonly RATE_LIMITER: DurableObjectNamespace<RateLimiterObject>;
  /** The built dashboard. Absent in tests, which never ask for a page. */
  readonly ASSETS?: Fetcher;

  /** Secret. Signs the bearer tokens handed out by `/v2/token`. */
  readonly JWT_SECRET: string;
  /** Secret. Together these bootstrap the first administrator. */
  readonly BOOTSTRAP_ADMIN_USERNAME?: string;
  readonly BOOTSTRAP_ADMIN_PASSWORD_HASH?: string;

  readonly REGISTRY_HOST?: string;
  readonly ALLOW_ANONYMOUS_PULL?: string;
  readonly ENABLE_DELETES?: string;
  readonly VALIDATE_BLOB_REFERENCES?: string;
  readonly VALIDATE_MANIFEST_REFERENCES?: string;
  readonly AUTOMATIC_CROSS_MOUNT?: string;
  readonly MAX_MANIFEST_SIZE?: string;
  readonly TOKEN_TTL_SECONDS?: string;

  /** Charged per source address, before credentials are checked. */
  readonly RATE_LIMIT_IP_RPM?: string;
  /** Charged per authenticated principal, across every address it uses. */
  readonly RATE_LIMIT_USER_RPM?: string;
  readonly RATE_LIMIT_ENABLED?: string;

  /** Untagged manifests older than this are swept by the lifecycle job. */
  readonly UNTAGGED_MANIFEST_TTL_DAYS?: string;

  /**
   * How long an audit event is kept, in days. `0` keeps everything, for a
   * registry under a retention obligation. Defaults to a year.
   */
  readonly AUDIT_RETENTION_DAYS?: string;

  /**
   * Email notifications, sent through any provider that accepts
   * `{from, to, subject, text}` as JSON with a bearer token. All three or none:
   * a half-configured provider is a permanent delivery failure, and says so.
   */
  readonly EMAIL_PROVIDER_URL?: string;
  /** Secret. */
  readonly EMAIL_API_KEY?: string;
  readonly EMAIL_FROM?: string;

  /** Single sign-on. All of issuer, client id and secret, or none of them. */
  readonly OIDC_ISSUER?: string;
  readonly OIDC_CLIENT_ID?: string;
  /** Secret. */
  readonly OIDC_CLIENT_SECRET?: string;
  /** Defaults to `<this origin>/api/v1/auth/oidc/callback`. */
  readonly OIDC_REDIRECT_URI?: string;
  /** A user whose `groups` claim contains one of these is an administrator. */
  readonly OIDC_ADMIN_GROUPS?: string;
}

export function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readCoreConfig(env: Env): CoreConfig {
  return {
    maxManifestSize: integer(env.MAX_MANIFEST_SIZE, DEFAULT_CONFIG.maxManifestSize),
    validateBlobReferences: flag(env.VALIDATE_BLOB_REFERENCES, DEFAULT_CONFIG.validateBlobReferences),
    validateManifestReferences: flag(
      env.VALIDATE_MANIFEST_REFERENCES,
      DEFAULT_CONFIG.validateManifestReferences,
    ),
    automaticCrossMount: flag(env.AUTOMATIC_CROSS_MOUNT, DEFAULT_CONFIG.automaticCrossMount),
    defaultTagPageSize: DEFAULT_CONFIG.defaultTagPageSize,
    enableDeletes: flag(env.ENABLE_DELETES, DEFAULT_CONFIG.enableDeletes),
  };
}
