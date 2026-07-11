/** How long after a project's quota-exceeded event before another may be sent. */
export const QUOTA_EVENT_COOLDOWN_MS = 15 * 60_000;

/**
 * Claims the quota-exceeded cooldown window for a project.
 *
 * Returns true when the caller may emit the event - the first refusal, or the
 * first past the cooldown - and false when a recent event already covers this
 * one, so a CI retry loop that hammers a full project cannot become a webhook
 * storm. The claim is one atomic upsert whose `DO UPDATE` only fires once the
 * window has passed, so two concurrent refusals cannot both win it.
 */
export async function claimQuotaWindow(db: D1Database, project: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO quota_event_cooldowns (project, last_emitted_at)
       VALUES (?, ?)
       ON CONFLICT (project) DO UPDATE SET last_emitted_at = ?
       WHERE quota_event_cooldowns.last_emitted_at <= ?`,
    )
    .bind(project, now, now, now - QUOTA_EVENT_COOLDOWN_MS)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
