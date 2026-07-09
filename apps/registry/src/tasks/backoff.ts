/** The first retry waits this long; each one after waits twice as long. */
const BASE_DELAY_MS = 30_000;

/** Never wait longer than this, however many attempts have failed. */
const MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * How long to wait before attempting a task again.
 *
 * Exponential, capped, and jittered. The jitter matters more than it looks: a
 * webhook endpoint that goes down takes every pending delivery with it, and
 * without jitter they all come back at the same instant and knock it over again
 * the moment it recovers.
 *
 * `random` is a parameter so the schedule can be asserted rather than sampled.
 */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(exponent, 30));
  // Full jitter over [base/2, base]: still growing, but spread out.
  return Math.round(base / 2 + random() * (base / 2));
}

export { BASE_DELAY_MS, MAX_DELAY_MS };
