-- The audit page filters by the actor's name, not by their id.
--
-- `actor_name` is what the row records and what the dashboard displays: an
-- account may be deleted, and the id it left behind names nothing a person can
-- type. `0014` indexed `actor_id`, which the read path never filters on, so
-- "everything alice did" walked the whole table.
--
-- Ordered like the other audit indexes, because the read that uses it is always
-- the same read: newest first, keyed on `(created_at, id)`.

CREATE INDEX idx_audit_events_actor_name ON audit_events (actor_name, created_at DESC, id DESC);
