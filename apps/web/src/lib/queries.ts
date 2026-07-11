import type { QueryClient } from "@tanstack/react-query";

/**
 * Every query key the dashboard uses, and every invalidation edge between them.
 *
 * Concentrated here so the relationships are declared once rather than restated
 * at each call site: a token mutation refreshes both token lists, a project
 * mutation the detail and the list, a repository search shares one key family.
 * A route or component names a query by calling `keys.*`; it never writes the
 * array by hand, so a key can be renamed in one place.
 */

/** The audit log's filters form part of its key, so a changed filter is a fresh query. */
export interface AuditFilters {
  readonly resourceType?: string;
  readonly actor?: string;
  readonly project?: string;
}

/** The prefix every repository search shares, so one invalidation covers them all. */
const REPOSITORIES = "repositories";

export const keys = {
  providers: () => ["providers"] as const,
  stats: () => ["stats"] as const,
  users: () => ["users"] as const,
  projects: () => ["projects"] as const,
  project: (name: string) => ["project", name] as const,
  projectStats: (name: string) => ["project-stats", name] as const,
  repositories: (search: string) => [REPOSITORIES, search] as const,
  repository: (name: string) => ["repository", name] as const,
  manifest: (repository: string, digest: string) => ["manifest", repository, digest] as const,
  tokens: () => ["tokens"] as const,
  projectTokens: (project: string) => ["project-tokens", project] as const,
  cleanup: (project: string) => ["cleanup", project] as const,
  notifications: (project: string) => ["notifications", project] as const,
  deliveries: (project: string) => ["deliveries", project] as const,
  replication: (project: string) => ["replication", project] as const,
  executions: (project: string) => ["executions", project] as const,
  audit: (filters: AuditFilters) => ["audit", filters] as const,
};

/**
 * The invalidation edges: which cached queries a mutation makes stale.
 *
 * Each edge is the whole set a mutation touches, so a caller invalidates a
 * relationship by name and cannot forget half of it.
 */
export const invalidate = {
  /** A created, renamed, or deleted project: its detail and the list it sits in. */
  project(client: QueryClient, name: string): void {
    void client.invalidateQueries({ queryKey: keys.project(name) });
    void client.invalidateQueries({ queryKey: keys.projects() });
  },

  /** A membership change: only the detail carries the members. */
  projectMembers(client: QueryClient, name: string): void {
    void client.invalidateQueries({ queryKey: keys.project(name) });
  },

  /** A newly created project appears in the list. */
  projects(client: QueryClient): void {
    void client.invalidateQueries({ queryKey: keys.projects() });
  },

  /** A token mutation touches both the project's tokens and the account-wide list. */
  tokens(client: QueryClient, project: string): void {
    void client.invalidateQueries({ queryKey: keys.projectTokens(project) });
    void client.invalidateQueries({ queryKey: keys.tokens() });
  },

  /** An account-wide token revoked from the tokens page: only that list. */
  accountTokens(client: QueryClient): void {
    void client.invalidateQueries({ queryKey: keys.tokens() });
  },

  /** A user created, changed, or removed. */
  users(client: QueryClient): void {
    void client.invalidateQueries({ queryKey: keys.users() });
  },

  /** A deleted repository leaves every search that might have listed it, so the family is swept. */
  repositories(client: QueryClient): void {
    void client.invalidateQueries({ queryKey: [REPOSITORIES] });
  },

  /** The cleanup policy changed. */
  cleanup(client: QueryClient, project: string): void {
    void client.invalidateQueries({ queryKey: keys.cleanup(project) });
  },

  /** A webhook added or removed: the policy list and its delivery log both move. */
  notifications(client: QueryClient, project: string): void {
    void client.invalidateQueries({ queryKey: keys.notifications(project) });
    void client.invalidateQueries({ queryKey: keys.deliveries(project) });
  },

  /** A replication rule added or removed: the rule list and its run log both move. */
  replication(client: QueryClient, project: string): void {
    void client.invalidateQueries({ queryKey: keys.replication(project) });
    void client.invalidateQueries({ queryKey: keys.executions(project) });
  },

  /** A rule queued to run: only its run log will change. */
  executions(client: QueryClient, project: string): void {
    void client.invalidateQueries({ queryKey: keys.executions(project) });
  },
};
