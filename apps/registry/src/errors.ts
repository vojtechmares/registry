import { OciError, type ErrorCode } from "@registry/oci";

/**
 * Transport for OciError across the Worker/Durable Object boundary.
 *
 * A Durable Object can only answer with an HTTP response, so a structured
 * failure - and specifically the `Range` header a 416 must carry - has to be
 * carried in the body and rebuilt on the other side.
 */

interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly status: number;
  readonly detail?: unknown;
  readonly headers?: Record<string, string>;
}

const MARKER = "x-oci-error";

export function toErrorResponse(error: OciError): Response {
  const wire: WireError = {
    code: error.code,
    message: error.message,
    status: error.status,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(Object.keys(error.headers).length === 0 ? {} : { headers: error.headers }),
  };
  return new Response(JSON.stringify(wire), {
    status: error.status,
    headers: { "Content-Type": "application/json", [MARKER]: "1" },
  });
}

export async function throwIfErrorResponse(response: Response): Promise<void> {
  if (response.headers.get(MARKER) !== "1") return;

  const wire = (await response.json()) as WireError;
  throw new OciError(wire.code, wire.message, {
    status: wire.status,
    ...(wire.detail === undefined ? {} : { detail: wire.detail }),
    ...(wire.headers === undefined ? {} : { headers: wire.headers }),
  });
}
