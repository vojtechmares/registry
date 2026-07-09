/** `?, ?, ?` for a bound list. SQLite has no array parameter, so `IN` needs one per value. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
