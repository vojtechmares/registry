-- Cron-scheduled cleanup, per project.
--
-- `next_run_at` is computed when the schedule is set and again after every run,
-- so the cron trigger only has to ask "what is due?" rather than parse every
-- expression it holds. It is nullable: a policy that has never been scheduled,
-- or whose expression names a date that never comes, has no next run.

CREATE TABLE cleanup_policies (
  project                  TEXT PRIMARY KEY REFERENCES projects (name) ON DELETE CASCADE,
  enabled                  INTEGER NOT NULL DEFAULT 0,
  -- A five-field cron expression, in UTC.
  schedule                 TEXT NOT NULL,
  -- JSON array of retention rules. A tag no rule governs is never touched.
  rules                    TEXT NOT NULL DEFAULT '[]',
  -- Untagged manifests, which are usually superseded images but may equally be
  -- signatures. The sweep protects anything another manifest still points at.
  untagged_older_than_days INTEGER,
  next_run_at              INTEGER,
  last_run_at              INTEGER,
  -- What the last run did, so a surprising deletion can be explained.
  last_result              TEXT,
  updated_at               INTEGER NOT NULL
);

-- The cron trigger's only question.
CREATE INDEX idx_cleanup_policies_due ON cleanup_policies (enabled, next_run_at);

-- Lifecycle events gain a project, so a project's history can be read without
-- joining through repositories that a cleanup may since have emptied.
ALTER TABLE lifecycle_events ADD COLUMN project TEXT;

UPDATE lifecycle_events
SET project = CASE
  WHEN repository IS NULL THEN NULL
  WHEN instr(repository, '/') > 0 THEN substr(repository, 1, instr(repository, '/') - 1)
  ELSE repository
END;

CREATE INDEX idx_lifecycle_events_project ON lifecycle_events (project, created_at DESC);
