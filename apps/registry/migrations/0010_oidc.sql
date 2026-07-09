-- Federated identity.
--
-- A user provisioned by an identity provider has no password: `password_hash`
-- holds a marker that no PBKDF2 verification can ever match, so an OIDC account
-- cannot also be reached by guessing a password it does not have.

ALTER TABLE users ADD COLUMN oidc_subject TEXT;
ALTER TABLE users ADD COLUMN oidc_issuer TEXT;

-- One local account per (issuer, subject). A subject is unique only within its
-- issuer, so keying on the subject alone would let a second provider claim an
-- account by minting a token for the same subject string.
CREATE UNIQUE INDEX idx_users_oidc ON users (oidc_issuer, oidc_subject)
  WHERE oidc_subject IS NOT NULL;
