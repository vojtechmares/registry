-- Who did what, to what, and when.
--
-- `lifecycle_events` records what the crons retired, and `stats_daily` counts
-- what happened, but neither says who. This table does, for every change a
-- person or a credential makes to a project, a repository, an artifact, a user,
-- or a token.
--
-- Pulls are deliberately absent. One `docker pull` reaches the manifest endpoint
-- repeatedly and a row per pull would dominate the table; `stats_daily` already
-- counts them. Pushes and deletes are recorded, because "who deleted this
-- image" is the first question anybody asks of an audit log.

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,

  -- Who. There is deliberately no foreign key to `users`: deleting a user must
  -- not delete the record of what they did, and `actor_name` is stored as it
  -- was at the time so the row still reads once the account is gone.
  actor_id       TEXT,
  actor_name     TEXT NOT NULL,
  -- `user` acted directly, `token` through a machine credential, `system` is a
  -- cron, `anonymous` had no credentials at all.
  actor_kind     TEXT NOT NULL CHECK (actor_kind IN ('user', 'token', 'system', 'anonymous')),
  -- Which credential, when one was used. "Whose token" and "which token" are
  -- different questions, and revoking answers only the second.
  actor_token_id TEXT,

  -- What was done, as `noun.verb`: `project.update`, `artifact.push`.
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL CHECK (
    resource_type IN ('project', 'repository', 'artifact', 'user', 'token')
  ),
  -- The thing itself: a project name, a repository name, `repo:tag`, a user id.
  resource       TEXT NOT NULL,
  -- The project the change belongs to, for scoping a read. Null for a change to
  -- a user, which belongs to no project.
  project        TEXT,

  -- JSON, and free-form: the settings that changed, the digest that was pushed.
  detail         TEXT,
  created_at     INTEGER NOT NULL
);

-- The four questions the audit page asks. Each is answered by a keyset scan
-- over `created_at DESC`, which is also the order the page reads in.
CREATE INDEX idx_audit_events_created ON audit_events (created_at DESC, id DESC);
CREATE INDEX idx_audit_events_project ON audit_events (project, created_at DESC, id DESC);
CREATE INDEX idx_audit_events_resource ON audit_events (resource_type, created_at DESC, id DESC);
CREATE INDEX idx_audit_events_actor ON audit_events (actor_id, created_at DESC, id DESC);
