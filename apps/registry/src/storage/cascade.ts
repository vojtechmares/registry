/**
 * The one description of what is filed under a repository, and how a project's
 * quota settles once links are gone.
 *
 * Deleting a repository and deleting a whole project remove the same content
 * tables - only the predicate differs - so the list lives here rather than being
 * kept equal by hand in two stores. Adding a table that references a repository
 * means adding it here, once, and both deletion paths pick it up.
 */

/** Everything keyed to a repository, ordered so a delete never precedes what it depends on. */
export const REPOSITORY_CONTENT_TABLES = [
  "tags",
  "manifest_blobs",
  "manifest_children",
  "manifests",
  "repository_blobs",
  "lifecycle_policies",
] as const;

/** Statements that delete one repository's content, but not the `repositories` row itself. */
export function deleteRepositoryContent(db: D1Database, repository: string): D1PreparedStatement[] {
  return REPOSITORY_CONTENT_TABLES.map((table) =>
    db.prepare(`DELETE FROM ${table} WHERE repository = ?`).bind(repository),
  );
}

/**
 * Statements that delete the content of every repository in a project. The
 * repositories still exist when these run, so each resolves the set through
 * them; the `repositories` rows themselves are removed afterwards by the caller.
 */
export function deleteProjectContent(db: D1Database, project: string): D1PreparedStatement[] {
  return REPOSITORY_CONTENT_TABLES.map((table) =>
    db
      .prepare(`DELETE FROM ${table} WHERE repository IN (SELECT name FROM repositories WHERE project = ?)`)
      .bind(project),
  );
}

/**
 * Recomputes a project's `used_bytes` from the links that remain.
 *
 * The incremental accounting on the push path is exact, but it only ever sees
 * one blob at a time. Anything that removes many links at once - dropping a
 * repository, collecting garbage - settles up with this instead.
 */
export function recomputeUsage(db: D1Database, project: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE projects
          SET used_bytes = COALESCE((
                SELECT SUM(b.size)
                FROM (SELECT DISTINCT digest FROM repository_blobs WHERE project = ?1) AS d
                JOIN blobs AS b ON b.digest = d.digest
              ), 0)
        WHERE name = ?1`,
    )
    .bind(project);
}
