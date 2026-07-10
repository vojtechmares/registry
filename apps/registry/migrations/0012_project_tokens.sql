-- Access tokens are managed by the project they belong to.
--
-- Every token now names a project, checked at creation and again on every
-- request. A token that named none reached every project its owner could, so
-- one leaked from a CI job that only ever pushed to `acme/api` could also
-- delete `payments/vault`.
--
-- The rows that predate the rule are deliberately left alone. They no longer
-- authenticate - `authenticateAccessToken` refuses a null project outright -
-- and an owner can see them in the project listing only once they are pinned,
-- which they never will be. They remain so that a `DELETE` still finds them,
-- and so that this migration cannot destroy a credential someone is still
-- reading the name of.
--
-- The index serves the one question the project token page asks.

CREATE INDEX idx_access_tokens_project ON access_tokens (project);
