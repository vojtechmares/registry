import type { ProblemFieldError } from "@registry/api-contract";
import { ApiError } from "@/lib/api";

/**
 * The one place a client error becomes something to show a person.
 *
 * A refusal the API named carries a `detail` sentence written for a reader; any
 * other thrown value - a dropped connection, a bug - has none, so the caller's
 * fallback stands in.
 */
export function presentError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * The field faults of a validation refusal, keyed by the form field each names.
 *
 * A `parameter` names its field directly; a `pointer` names it by the body key
 * its first segment holds (`/username` is the `username` field). A fault that
 * points at the body itself belongs to no single field, so it is left out. Only
 * the first message per field survives, since a field shows one line.
 */
export function fieldErrorsOf(error: unknown): Map<string, string> {
  const byField = new Map<string, string>();
  if (!(error instanceof ApiError)) return byField;

  for (const fault of error.fieldErrors) {
    const field = fieldNameOf(fault);
    if (field !== null && !byField.has(field)) byField.set(field, fault.detail);
  }
  return byField;
}

function fieldNameOf(fault: ProblemFieldError): string | null {
  if (typeof fault.parameter === "string" && fault.parameter !== "") return fault.parameter;
  if (typeof fault.pointer === "string" && fault.pointer !== "") return fault.pointer.split("/")[1] ?? null;
  return null;
}

/**
 * The final segment of the problem's `type`, the name to branch on regardless of
 * which host serves the API. Anything that is not a named refusal has none.
 */
export function problemNameOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.type.split("/").pop() ?? null) : null;
}
