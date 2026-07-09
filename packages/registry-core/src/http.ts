import { OciError } from "@registry/oci";

/** Advertised by registries since the Docker v2 protocol; some clients still probe for it. */
export const API_VERSION_HEADER = "Docker-Distribution-API-Version";
export const API_VERSION = "registry/2.0";

/**
 * 416 for an out-of-order chunk. The spec assigns no error code to this case,
 * so we answer with the closest one and let the status carry the meaning.
 */
export function rangeNotSatisfiable(offset: number): OciError {
  return new OciError("BLOB_UPLOAD_INVALID", "requested range not satisfiable", {
    status: 416,
    detail: { offset },
    headers: { Range: uploadRange(offset) },
  });
}

/**
 * The `Range` header of an upload session: `0-<last accepted byte>`, inclusive.
 * An empty session has no last byte; registries conventionally report `0-0`.
 */
export function uploadRange(offset: number): string {
  return offset === 0 ? "0-0" : `0-${offset - 1}`;
}

export function errorResponse(error: OciError): Response {
  return new Response(JSON.stringify(error.toBody()), {
    status: error.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...error.headers,
    },
  });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/**
 * Parses a `Content-Range` from a chunked blob upload. The spec pins the format
 * to `^[0-9]+-[0-9]+$` - note this is *not* the `bytes=` form used by `Range`.
 */
export function parseContentRange(value: string): { start: number; end: number } | null {
  const match = /^([0-9]+)-([0-9]+)$/.exec(value.trim());
  if (match === null) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

export type RangeRequest =
  | { readonly kind: "full" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

/**
 * Parses an RFC 9110 `Range` header against a known object size.
 *
 * Only a single byte range is honoured. A syntactically invalid header is
 * ignored (RFC 9110 §14.2), which is why that path returns `full` rather than
 * an error; a syntactically valid but unreachable range yields 416.
 */
export function parseRangeHeader(value: string | null, size: number): RangeRequest {
  if (value === null) return { kind: "full" };

  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null) return { kind: "full" };

  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "full" };

  let start: number;
  let end: number;

  if (rawStart === "") {
    // `bytes=-N`: the final N bytes. A zero-length suffix cannot be satisfied.
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix)) return { kind: "full" };
    if (suffix === 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    const last = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return { kind: "full" };
    // A last-byte-pos below first-byte-pos makes the range specifier invalid,
    // and RFC 9110 requires an invalid `Range` to be ignored rather than
    // refused. Clamping first would turn it into a spurious 416.
    if (last < start) return { kind: "full" };
    end = Math.min(last, size - 1);
  }

  if (start >= size) return { kind: "unsatisfiable" };
  if (start === 0 && end === size - 1) return { kind: "full" };
  return { kind: "range", start, end };
}

/** Reads a request body into memory, refusing to exceed `limit` bytes. */
export async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > limit) {
      throw new OciError("MANIFEST_INVALID", `body exceeds the maximum size of ${limit} bytes`, {
        status: 413,
      });
    }
  }

  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new OciError("MANIFEST_INVALID", `body exceeds the maximum size of ${limit} bytes`, {
        status: 413,
      });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** An empty stream, so a body-less PUT can flow through the same code path as one with a body. */
export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Builds an RFC 5988 `Link` header advertising the next page of a listing. */
export function nextLink(path: string, parameters: Record<string, string>): string {
  const query = new URLSearchParams(parameters).toString();
  return `<${path}?${query}>; rel="next"`;
}
