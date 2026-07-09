-- Replication rules: copying artifacts to and from another registry.
--
-- `push` sends this project's artifacts downstream. `pull` subscribes to
-- somebody else's registry - Docker Hub, say - and copies from it.

CREATE TABLE replication_rules (
  id                    TEXT PRIMARY KEY,
  project               TEXT NOT NULL REFERENCES projects (name) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  enabled               INTEGER NOT NULL DEFAULT 1,
  direction             TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
  remote_url            TEXT NOT NULL,
  remote_username       TEXT,
  -- Sealed with AES-GCM under a key derived from a Worker secret. The registry
  -- has to present this password, so it cannot be hashed; a database that leaks
  -- yields ciphertext.
  remote_password       TEXT,
  destination_namespace TEXT NOT NULL DEFAULT '',
  -- A glob over this project's repositories, for a push rule.
  repository_filter     TEXT NOT NULL DEFAULT '*',
  -- The remote repositories a pull rule subscribes to. A remote catalog is
  -- rarely listable, and guessing at it is worse than being told.
  source_repositories   TEXT NOT NULL DEFAULT '[]',
  -- JSON: { pattern?, semver?, includePrerelease? }
  tag_filter            TEXT NOT NULL DEFAULT '{}',
  trigger               TEXT NOT NULL DEFAULT 'manual'
                        CHECK (trigger IN ('manual', 'event', 'scheduled')),
  schedule              TEXT,
  next_run_at           INTEGER,
  last_run_at           INTEGER,
  last_result           TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX idx_replication_rules_project ON replication_rules (project);
-- The event trigger's question, asked on every manifest push.
CREATE INDEX idx_replication_rules_event ON replication_rules (project, enabled, trigger);
-- The cron sweep's question.
CREATE INDEX idx_replication_rules_due ON replication_rules (enabled, next_run_at);

-- What each run copied, so a rule that quietly stopped working can be found.
CREATE TABLE replication_executions (
  id          TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL,
  project     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  repository  TEXT,
  reference   TEXT,
  manifests   INTEGER NOT NULL DEFAULT 0,
  blobs       INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_replication_executions_project ON replication_executions (project, created_at DESC);
