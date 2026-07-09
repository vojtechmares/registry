-- Projects: the unit of policy.
--
-- A repository's first path segment names its project, so `myorg/myrepo`
-- belongs to `myorg`. Everything that used to be decided per repository -
-- visibility, who may push - and everything the registry could not decide at
-- all - quota, signature rules, cleanup schedules - now hangs off the project.
--
-- The project name is denormalised onto `repositories` and `repository_blobs`
-- rather than derived with `substr(name, 1, instr(name, '/') - 1)` at query
-- time. D1 cannot index an expression usefully here, and quota accounting asks
-- "does any other repository in this project link this blob?" on every push.

CREATE TABLE projects (
  name                   TEXT PRIMARY KEY,
  visibility             TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  -- NULL is unlimited. Bytes, counted once per project per distinct blob.
  quota_bytes            INTEGER,
  used_bytes             INTEGER NOT NULL DEFAULT 0,
  -- Refuse to tag a manifest that carries no signature.
  require_signature_push INTEGER NOT NULL DEFAULT 0,
  -- Refuse to serve a manifest that carries no signature.
  require_signature_pull INTEGER NOT NULL DEFAULT 0,
  description            TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

-- Four ordered roles. Each holds every action the role beneath it holds, which
-- is what lets a rank comparison stand in for a capability comparison.
CREATE TABLE project_members (
  project    TEXT NOT NULL REFERENCES projects (name) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('guest', 'developer', 'maintainer', 'owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project, user_id)
);
CREATE INDEX idx_project_members_user ON project_members (user_id);

-- Every repository that exists today gets a project, taking the visibility of
-- the least visible repository in it. Widening access during a migration would
-- publish a private repository; narrowing it only costs a login.
INSERT INTO projects (name, visibility, quota_bytes, used_bytes, created_at, updated_at)
SELECT
  CASE WHEN instr(name, '/') > 0 THEN substr(name, 1, instr(name, '/') - 1) ELSE name END,
  MIN(visibility),
  NULL,
  0,
  MIN(created_at),
  MAX(updated_at)
FROM repositories
GROUP BY 1;

-- `repositories` loses its own visibility: the project decides now, and two
-- sources of truth for "who may read this" is one too many. SQLite cannot drop
-- a column that a CHECK constraint mentions, so the table is rebuilt.
CREATE TABLE repositories_v2 (
  name       TEXT PRIMARY KEY,
  project    TEXT NOT NULL REFERENCES projects (name) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO repositories_v2 (name, project, created_at, updated_at)
SELECT
  name,
  CASE WHEN instr(name, '/') > 0 THEN substr(name, 1, instr(name, '/') - 1) ELSE name END,
  created_at,
  updated_at
FROM repositories;

DROP TABLE repositories;

ALTER TABLE repositories_v2 RENAME TO repositories;

CREATE INDEX idx_repositories_project ON repositories (project);

-- Quota accounting reads this on every blob link: "is this digest already
-- linked anywhere else in the project?" The composite index answers it without
-- touching the table.
ALTER TABLE repository_blobs ADD COLUMN project TEXT NOT NULL DEFAULT '';

UPDATE repository_blobs
SET project = CASE
  WHEN instr(repository, '/') > 0 THEN substr(repository, 1, instr(repository, '/') - 1)
  ELSE repository
END;

CREATE INDEX idx_repository_blobs_project_digest ON repository_blobs (project, digest);

-- A link's token is rewritten on every fresh insert and left alone by
-- `ON CONFLICT DO NOTHING`. Charging the quota only when the token matches the
-- one just generated is what makes a re-push of an already-linked blob free,
-- without the accounting having to read back whether the insert did anything.
ALTER TABLE repository_blobs ADD COLUMN link_token TEXT NOT NULL DEFAULT '';

-- Backfill: each project owes the total size of the distinct blobs its
-- repositories link. Deduplication is per project, so a layer shared by two of
-- its repositories is charged once.
UPDATE projects
SET used_bytes = COALESCE(
  (
    SELECT SUM(b.size)
    FROM (SELECT DISTINCT project, digest FROM repository_blobs) AS d
    JOIN blobs AS b ON b.digest = d.digest
    WHERE d.project = projects.name
  ),
  0
);

-- Per-repository grants become project memberships, keeping the strongest role
-- a user held anywhere in the project. `push` implies `pull`, and `delete`
-- implies both, so the mapping never widens what a user could already do.
INSERT OR IGNORE INTO project_members (project, user_id, role, created_at)
SELECT
  CASE WHEN instr(repository, '/') > 0 THEN substr(repository, 1, instr(repository, '/') - 1) ELSE repository END,
  user_id,
  CASE
    WHEN instr(actions, 'delete') > 0 THEN 'maintainer'
    WHEN instr(actions, 'push') > 0 THEN 'developer'
    ELSE 'guest'
  END,
  created_at
FROM repository_grants AS g
-- A grant naming a repository that was never created has no project to join,
-- and inserting it would violate the foreign key rather than migrate anything.
WHERE EXISTS (
  SELECT 1 FROM projects AS p
  WHERE p.name = CASE WHEN instr(g.repository, '/') > 0 THEN substr(g.repository, 1, instr(g.repository, '/') - 1) ELSE g.repository END
)
AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = g.user_id)
ORDER BY
  CASE
    WHEN instr(actions, 'delete') > 0 THEN 3
    WHEN instr(actions, 'push') > 0 THEN 2
    ELSE 1
  END DESC;

DROP TABLE repository_grants;

-- A token may be pinned to one project. Its scopes then confine it further, but
-- can never carry it back out: a project-scoped token with a scope of `*` still
-- only reaches its own project.
ALTER TABLE access_tokens ADD COLUMN project TEXT;
