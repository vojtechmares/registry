-- Core registry metadata.
--
-- Repositories are keyed by name rather than a surrogate id. D1 round trips
-- dominate request latency, and a name-keyed schema removes one lookup from
-- every blob, manifest and tag operation. Repository names never change.

CREATE TABLE repositories (
  name       TEXT PRIMARY KEY,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Blob content, deduplicated across the whole registry: identical bytes are
-- stored once, no matter how many repositories reference them.
CREATE TABLE blobs (
  digest      TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  -- Not derivable from the digest. A chunked upload commits to its key before
  -- the digest is known, so it keeps a staging key forever.
  storage_key TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Which repositories may serve which blobs. `DELETE /v2/<name>/blobs/<digest>`
-- removes a row here; the content survives for whoever still links it.
CREATE TABLE repository_blobs (
  repository TEXT NOT NULL,
  digest     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository, digest)
);
CREATE INDEX idx_repository_blobs_digest ON repository_blobs (digest);

CREATE TABLE manifests (
  repository     TEXT NOT NULL,
  digest         TEXT NOT NULL,
  media_type     TEXT NOT NULL,
  -- Resolved at push time per the spec's fallback rules, so the referrers API
  -- never has to re-parse a manifest body.
  artifact_type  TEXT,
  size           INTEGER NOT NULL,
  subject_digest TEXT,
  annotations    TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (repository, digest)
);
-- Serves GET /v2/<name>/referrers/<digest>.
CREATE INDEX idx_manifests_subject ON manifests (repository, subject_digest);
-- Lets garbage collection ask whether any repository still holds a manifest.
CREATE INDEX idx_manifests_digest ON manifests (digest);

-- What a manifest points at, recorded so garbage collection can walk the graph.
CREATE TABLE manifest_blobs (
  repository      TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  blob_digest     TEXT NOT NULL,
  PRIMARY KEY (repository, manifest_digest, blob_digest)
);
CREATE INDEX idx_manifest_blobs_blob ON manifest_blobs (blob_digest);

CREATE TABLE manifest_children (
  repository      TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  child_digest    TEXT NOT NULL,
  PRIMARY KEY (repository, manifest_digest, child_digest)
);
CREATE INDEX idx_manifest_children_child ON manifest_children (child_digest);

CREATE TABLE tags (
  repository      TEXT NOT NULL,
  name            TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (repository, name)
);
-- Deleting a manifest by digest must take every tag pointing at it.
CREATE INDEX idx_tags_manifest ON tags (repository, manifest_digest);
