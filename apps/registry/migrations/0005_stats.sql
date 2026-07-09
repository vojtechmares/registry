-- Pull, push and delete counters, bucketed by day.
--
-- One row per repository per day, and a project's numbers are the sum of its
-- repositories'. Storing the roll-up as well would make the two disagree the
-- first time a repository moved, and a project has few enough repositories that
-- summing them is a single indexed scan.
--
-- `day` is whole days since the Unix epoch in UTC, which sorts, ranges and
-- subtracts as an integer. A date string would do none of those without a
-- function call on every row.

CREATE TABLE stats_daily (
  day        INTEGER NOT NULL,
  project    TEXT NOT NULL,
  repository TEXT NOT NULL,
  pulls      INTEGER NOT NULL DEFAULT 0,
  pushes     INTEGER NOT NULL DEFAULT 0,
  deletes    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project, repository)
);

-- Serves "the last 30 days of this project", the dashboard's default question.
CREATE INDEX idx_stats_daily_project_day ON stats_daily (project, day);
-- Serves the same question about one repository, and the per-image breakdown.
CREATE INDEX idx_stats_daily_repository_day ON stats_daily (repository, day);
