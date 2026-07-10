-- Immutable tags, per project.
--
-- A tag in a project that sets this may not be moved to a different digest, and
-- may not be deleted. Re-pushing the digest a tag already names stays allowed:
-- a CI job that reruns must not fail, and the operation changes nothing.
--
-- Scheduled cleanup honours it too. A retention rule that would retire a tag in
-- such a project retires nothing, because "this tag will always mean what it
-- means" is worth less than nothing if a cron can quietly retract it.
--
-- Off by default, so no existing project changes behaviour.

ALTER TABLE projects ADD COLUMN immutable_tags INTEGER NOT NULL DEFAULT 0;
