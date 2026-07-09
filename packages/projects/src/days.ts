/**
 * Whole days since the Unix epoch, in UTC.
 *
 * Activity counters bucket by day, and the bucket key has to sort, range and
 * subtract without a function call on every row. An integer does; a date string
 * does not. UTC and not the viewer's timezone, because the registry writes the
 * bucket and the dashboard only reads it, and a bucket that moves with the
 * reader is a bucket two readers disagree about.
 */

const MS_PER_DAY = 86_400_000;

export function dayNumber(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_DAY);
}

export function dayToIso(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export interface DayCounts {
  readonly pulls: number;
  readonly pushes: number;
  readonly deletes: number;
}

export interface DayPoint extends DayCounts {
  readonly day: string;
}

/**
 * A dense series ending on `lastDay`, `days` long, oldest first.
 *
 * The table holds no row for a day nothing happened, and a chart that skips
 * those days lies about the shape of the traffic. Filling the gaps here rather
 * than in SQL keeps the query a plain range scan.
 */
export function fillSeries(
  lastDay: number,
  days: number,
  counts: ReadonlyMap<number, DayCounts>,
): DayPoint[] {
  const series: DayPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = lastDay - offset;
    const found = counts.get(day);
    series.push({
      day: dayToIso(day),
      pulls: found?.pulls ?? 0,
      pushes: found?.pushes ?? 0,
      deletes: found?.deletes ?? 0,
    });
  }
  return series;
}
