-- Where a project sends news of itself.
--
-- A policy is enabled and lists the event types it wants; an empty list wants
-- nothing. The opposite default would turn a half-configured policy into a
-- firehose pointed at somebody's inbox.

CREATE TABLE notification_policies (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL REFERENCES projects (name) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  target_type TEXT NOT NULL CHECK (target_type IN ('webhook', 'email')),
  -- An https URL, or an email address.
  target      TEXT NOT NULL,
  -- The HMAC key a recipient uses to prove the payload came from this registry.
  -- Never returned by the API once set.
  secret      TEXT,
  -- JSON array of event types.
  event_types TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_notification_policies_project ON notification_policies (project);

-- An append-only record of what was sent and what came back, so an endpoint that
-- silently stopped accepting deliveries can be found without reading the queue.
CREATE TABLE notification_deliveries (
  id              TEXT PRIMARY KEY,
  policy_id       TEXT NOT NULL,
  project         TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('delivered', 'failed')),
  response_status INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_notification_deliveries_project ON notification_deliveries (project, created_at DESC);
