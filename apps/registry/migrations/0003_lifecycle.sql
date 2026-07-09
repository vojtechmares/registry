-- Lifecycle policies, evaluated by the nightly cron trigger.

CREATE TABLE lifecycle_policies (
  repository         TEXT PRIMARY KEY,
  enabled            INTEGER NOT NULL DEFAULT 1,
  -- Keep only the N most recently updated tags; older tags are removed.
  -- NULL disables tag retention.
  keep_last_tags     INTEGER,
  -- Retire untagged manifests older than this. NULL falls back to the
  -- registry-wide default.
  untagged_ttl_days  INTEGER,
  updated_at         INTEGER NOT NULL
);

-- An append-only record of what maintenance removed, so a surprising deletion
-- can be explained after the fact.
CREATE TABLE lifecycle_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT,
  action     TEXT NOT NULL,
  subject    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_lifecycle_events_created ON lifecycle_events (created_at DESC);
