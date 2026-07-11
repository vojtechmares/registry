-- Throttles the quota-exceeded notification per project.
--
-- A project that is full refuses every push against it, and a CI retry loop can
-- refuse dozens a minute. One event per project per cooldown window turns that
-- storm into a single piece of news. One row per project holds when its last
-- event went out; the row is claimed atomically so two concurrent refusals
-- cannot both win.

CREATE TABLE quota_event_cooldowns (
  project         TEXT PRIMARY KEY REFERENCES projects (name) ON DELETE CASCADE,
  last_emitted_at INTEGER NOT NULL
);
