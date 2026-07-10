-- Every user has an email address, and no two users share one.
--
-- The column has existed since 0002, but nothing required it, validated it, or
-- stopped two accounts from claiming the same address. An address that
-- identifies two people identifies neither, which is the whole point of holding
-- one.
--
-- Addresses are stored lowercase. `Alice@example.com` and `alice@example.com`
-- are one mailbox, and a unique index over the raw text would not know that.

UPDATE users SET email = lower(trim(email)) WHERE email IS NOT NULL;
UPDATE users SET email = NULL WHERE email = '';

-- Where two accounts already claim one address, the earliest keeps it. Failing
-- the migration instead would leave the registry unable to deploy at all, and
-- an administrator can give the loser of the collision a new address. Rows that
-- lose their email are exactly the rows that already had a duplicate one.
UPDATE users SET email = NULL
WHERE email IS NOT NULL
  AND rowid NOT IN (SELECT MIN(rowid) FROM users WHERE email IS NOT NULL GROUP BY email);

-- Partial, so that the accounts predating this migration - the bootstrap
-- administrator, and any federated account whose provider sent no address -
-- may go on having no email without colliding with each other.
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE email IS NOT NULL;
