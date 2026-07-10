/**
 * Rudimentary, and knowingly so. An address is only ever handed to the mail
 * provider, which is the thing that actually knows whether it can be reached.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= 254;
}

/**
 * The form an address is stored and compared in, or null when there is none.
 *
 * `Alice@example.com` and `alice@example.com` are one mailbox. Lowercasing on
 * the way in is what makes the unique index over `users.email` mean what it
 * looks like it means.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}
