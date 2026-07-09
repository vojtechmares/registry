-- A durable work queue in D1.
--
-- Cloudflare Queues would be the obvious tool, and it would also be a second
-- piece of infrastructure to provision before the Worker could deploy at all.
-- This table is enough: work is claimed under a lease, retried with backoff,
-- and swept by the same cron trigger that runs cleanup policies. A task is
-- executed immediately after it is enqueued, from `waitUntil`, so the sweep is
-- a safety net rather than the primary path.

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  -- JSON. What the handler needs, and nothing it can look up itself.
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  -- Not before this instant. Backoff moves it forward after a failure.
  run_after    INTEGER NOT NULL,
  -- A claim expires, so a task whose Worker died is picked up again rather than
  -- being lost. Nothing else recovers it: there is no process to notice.
  lease_until  INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The claim query's only question: what is runnable, oldest first.
CREATE INDEX idx_tasks_claim ON tasks (status, run_after);
-- Reclaiming an expired lease.
CREATE INDEX idx_tasks_lease ON tasks (status, lease_until);
-- Reading a project's failures without scanning the queue.
CREATE INDEX idx_tasks_kind_created ON tasks (kind, created_at DESC);
