/**
 * The error codes defined by the distribution spec, and the HTTP statuses the
 * registry answers with for each.
 * https://github.com/opencontainers/distribution-spec/blob/main/spec.md#error-codes
 */

export const ERROR_CODES = [
  "BLOB_UNKNOWN",
  "BLOB_UPLOAD_INVALID",
  "BLOB_UPLOAD_UNKNOWN",
  "DIGEST_INVALID",
  "MANIFEST_BLOB_UNKNOWN",
  "MANIFEST_INVALID",
  "MANIFEST_UNKNOWN",
  "NAME_INVALID",
  "NAME_UNKNOWN",
  "SIZE_INVALID",
  "UNAUTHORIZED",
  "DENIED",
  "UNSUPPORTED",
  "TOOMANYREQUESTS",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  BLOB_UNKNOWN: 404,
  BLOB_UPLOAD_INVALID: 400,
  BLOB_UPLOAD_UNKNOWN: 404,
  DIGEST_INVALID: 400,
  MANIFEST_BLOB_UNKNOWN: 400,
  MANIFEST_INVALID: 400,
  MANIFEST_UNKNOWN: 404,
  NAME_INVALID: 400,
  NAME_UNKNOWN: 404,
  SIZE_INVALID: 400,
  UNAUTHORIZED: 401,
  DENIED: 403,
  UNSUPPORTED: 400,
  TOOMANYREQUESTS: 429,
};

export interface ErrorBody {
  readonly errors: ReadonlyArray<{
    readonly code: ErrorCode;
    readonly message: string;
    readonly detail?: unknown;
  }>;
}

export class OciError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: unknown;
  /** Extra response headers the spec mandates alongside a given failure. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { detail?: unknown; status?: number; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "OciError";
    this.code = code;
    this.status = options.status ?? STATUS[code];
    this.detail = options.detail;
    this.headers = options.headers ?? {};
  }

  toBody(): ErrorBody {
    return {
      errors: [
        this.detail === undefined
          ? { code: this.code, message: this.message }
          : { code: this.code, message: this.message, detail: this.detail },
      ],
    };
  }
}

export const blobUnknown = (digest?: string) =>
  new OciError(
    "BLOB_UNKNOWN",
    "blob unknown to registry",
    digest === undefined ? {} : { detail: { digest } },
  );

export const blobUploadInvalid = (message = "blob upload invalid") =>
  new OciError("BLOB_UPLOAD_INVALID", message);

export const blobUploadUnknown = () => new OciError("BLOB_UPLOAD_UNKNOWN", "blob upload unknown to registry");

export const digestInvalid = (message = "provided digest did not match uploaded content", detail?: unknown) =>
  new OciError("DIGEST_INVALID", message, detail === undefined ? {} : { detail });

export const manifestBlobUnknown = (digest: string) =>
  new OciError("MANIFEST_BLOB_UNKNOWN", "manifest references a manifest or blob unknown to registry", {
    detail: { digest },
  });

export const manifestInvalid = (message = "manifest invalid", detail?: unknown) =>
  new OciError("MANIFEST_INVALID", message, detail === undefined ? {} : { detail });

export const manifestUnknown = (reference?: string) =>
  new OciError(
    "MANIFEST_UNKNOWN",
    "manifest unknown to registry",
    reference === undefined ? {} : { detail: { reference } },
  );

export const nameInvalid = (name?: string) =>
  new OciError("NAME_INVALID", "invalid repository name", name === undefined ? {} : { detail: { name } });

export const nameUnknown = (name?: string) =>
  new OciError(
    "NAME_UNKNOWN",
    "repository name not known to registry",
    name === undefined ? {} : { detail: { name } },
  );

export const sizeInvalid = (message = "provided length did not match content length") =>
  new OciError("SIZE_INVALID", message);

export const unauthorized = (message = "authentication required", headers?: Record<string, string>) =>
  new OciError("UNAUTHORIZED", message, headers === undefined ? {} : { headers });

export const denied = (message = "requested access to the resource is denied") =>
  new OciError("DENIED", message);

export const unsupported = (message = "the operation is unsupported") => new OciError("UNSUPPORTED", message);

export const tooManyRequests = (retryAfterSeconds: number) =>
  new OciError("TOOMANYREQUESTS", "too many requests", {
    headers: { "Retry-After": String(retryAfterSeconds) },
  });

/** 413, which sits outside the spec's error table but is mandated for oversized manifests. */
export const manifestTooLarge = (limit: number) =>
  new OciError("MANIFEST_INVALID", `manifest exceeds the maximum size of ${limit} bytes`, {
    status: 413,
    detail: { limit },
  });
