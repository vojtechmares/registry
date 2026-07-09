/** A project with no storage limit. */
export const QUOTA_UNLIMITED = null;

export interface QuotaState {
  readonly usedBytes: number;
  /** Null means unlimited. */
  readonly quotaBytes: number | null;
}

/**
 * Whether a project can take `incomingBytes` more.
 *
 * `incomingBytes` is what the write would *add*, not what it stores: a blob the
 * project already links costs nothing, because the bytes are counted once per
 * project no matter how many of its repositories point at them. That is why a
 * zero-byte write is admitted even by a project that is already over its quota -
 * refusing it would break cross-repository mounts inside a full project, which
 * consume no storage at all.
 */
export function quotaAdmits(state: QuotaState, incomingBytes: number): boolean {
  if (state.quotaBytes === QUOTA_UNLIMITED) return true;
  if (incomingBytes === 0) return true;
  return state.usedBytes + incomingBytes <= state.quotaBytes;
}

export function remainingQuota(state: QuotaState): number | null {
  if (state.quotaBytes === QUOTA_UNLIMITED) return null;
  return Math.max(0, state.quotaBytes - state.usedBytes);
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Binary units, the ones `docker` and `crane` print. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal, but never a trailing `.0`.
  const rendered = unit === 0 ? String(value) : String(Math.round(value * 10) / 10);
  return `${rendered} ${UNITS[unit]}`;
}
