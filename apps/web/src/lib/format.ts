/** Presentation helpers. Pure, so the components that use them stay trivial to test. */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Container layers are measured in binary units, so `1024`, not `1000`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 10 keeps "1.5 GiB" readable without implying false precision.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** `sha256:abcdef012345…` - enough to recognise, short enough to sit in a table. */
export function shortDigest(digest: string, length = 12): string {
  const separator = digest.indexOf(":");
  if (separator === -1) return digest.slice(0, length);
  return `${digest.slice(0, separator + 1)}${digest.slice(separator + 1, separator + 1 + length)}`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  let duration = (timestamp - now) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return RELATIVE.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return new Date(timestamp).toISOString();
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * The command a visitor needs to pull this tag. The registry host is taken from
 * the page, so a deployment behind any domain prints the right thing.
 */
export function pullCommand(repository: string, reference: string, host: string): string {
  const separator = reference.startsWith("sha256:") ? "@" : ":";
  return `docker pull ${host}/${repository}${separator}${reference}`;
}
