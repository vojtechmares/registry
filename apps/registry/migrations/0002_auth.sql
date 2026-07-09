-- Authentication and authorization.
--
-- Two kinds of principal share one permission model: a human `user`, and a
-- machine-to-machine `token` that belongs to a user but carries its own,
-- narrower scopes.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  -- PBKDF2-HMAC-SHA256, encoded as `pbkdf2$<iterations>$<salt>$<hash>`.
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Machine-to-machine credentials. The secret is never stored, only its hash,
-- so a database leak cannot be replayed against the registry.
CREATE TABLE access_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_hash  TEXT NOT NULL,
  -- JSON array of { repository, actions }. `repository` may end in `/*`.
  scopes       TEXT NOT NULL,
  expires_at   INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_access_tokens_user ON access_tokens (user_id);

-- Per-repository permissions for a user. Admins bypass this table entirely.
CREATE TABLE repository_grants (
  repository TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Comma-separated subset of pull,push,delete.
  actions    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository, user_id)
);
CREATE INDEX idx_repository_grants_user ON repository_grants (user_id);
