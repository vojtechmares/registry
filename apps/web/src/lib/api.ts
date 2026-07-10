import type {
  AccessTokenSummary,
  AuthProviders,
  CleanupPolicy,
  CreatedAccessToken,
  LifecyclePolicy,
  ManifestDetail,
  NotificationDelivery,
  NotificationPolicySummary,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  RegistryStats,
  ReplicationExecution,
  ReplicationRuleSummary,
  RepositoryDetail,
  RepositorySummary,
  Role,
  SessionUser,
  TagSummary,
  UsageStats,
  UserSummary,
  Visibility,
} from "@registry/api-contract";

/**
 * The management API client.
 *
 * The dashboard is served by the same Worker that serves the API, so every
 * request is same-origin and the session cookie rides along on its own. That is
 * also why nothing here reads or writes a token: the cookie is `HttpOnly` and
 * deliberately invisible to this code.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

const BASE = "/api/v1";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // Same-origin, but stated explicitly: a stray `credentials: "omit"` default
    // would silently log the dashboard out.
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text === "" ? {} : JSON.parse(text);

  if (!response.ok) {
    const { error, message } = body as { error?: string; message?: string };
    throw new ApiError(response.status, error ?? "error", message ?? response.statusText);
  }

  return body as T;
}

/** Repository names contain slashes that must survive as path separators. */
function repoPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

export const api = {
  login: (username: string, password: string) =>
    request<SessionUser>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),

  logout: () =>
    request<void>("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } }),

  session: () => request<SessionUser>("/auth/session"),

  stats: () => request<RegistryStats>("/stats"),

  repositories: (search?: string) => {
    const query = search === undefined || search === "" ? "" : `?search=${encodeURIComponent(search)}`;
    return request<{ repositories: RepositorySummary[] }>(`/repositories${query}`).then(
      (r) => r.repositories,
    );
  },

  repository: (name: string) => request<RepositoryDetail>(`/repositories/${repoPath(name)}`),

  tags: (name: string) =>
    request<{ tags: TagSummary[] }>(`/repositories/${repoPath(name)}/tags`).then((r) => r.tags),

  manifest: (name: string, digest: string) =>
    request<ManifestDetail>(`/repositories/${repoPath(name)}/manifests/${encodeURIComponent(digest)}`),

  deleteRepository: (name: string) => request<void>(`/repositories/${repoPath(name)}`, { method: "DELETE" }),

  repositoryStats: (name: string, days = 30) =>
    request<UsageStats>(`/repositories/${repoPath(name)}/stats?days=${days}`),

  policy: (name: string) => request<LifecyclePolicy>(`/repositories/${repoPath(name)}/policy`),

  setPolicy: (policy: LifecyclePolicy) =>
    request<LifecyclePolicy>(`/repositories/${repoPath(policy.repository)}/policy`, {
      method: "PUT",
      body: JSON.stringify(policy),
    }),

  tokens: () => request<{ tokens: AccessTokenSummary[] }>("/tokens").then((r) => r.tokens),

  createToken: (input: {
    name: string;
    scopes: Array<{ repository: string; actions: string[] }>;
    expiresInDays?: number;
  }) => request<CreatedAccessToken>("/tokens", { method: "POST", body: JSON.stringify(input) }),

  revokeToken: (id: string) => request<void>(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

  users: () => request<{ users: UserSummary[] }>("/users").then((r) => r.users),

  createUser: (input: { username: string; password: string; email?: string; isAdmin?: boolean }) =>
    request<UserSummary>("/users", { method: "POST", body: JSON.stringify(input) }),

  deleteUser: (id: string) => request<void>(`/users/${encodeURIComponent(id)}`, { method: "DELETE" }),

  providers: () => request<AuthProviders>("/auth/providers"),

  projects: () => request<{ projects: ProjectSummary[] }>("/projects").then((r) => r.projects),

  project: (name: string) => request<ProjectDetail>(`/projects/${encodeURIComponent(name)}`),

  createProject: (input: {
    name: string;
    visibility?: Visibility;
    description?: string;
    quotaBytes?: number | null;
  }) => request<ProjectDetail>("/projects", { method: "POST", body: JSON.stringify(input) }),

  updateProject: (name: string, settings: ProjectSettings) =>
    request<ProjectDetail>(`/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),

  deleteProject: (name: string) =>
    request<void>(`/projects/${encodeURIComponent(name)}`, { method: "DELETE" }),

  projectStats: (name: string, days = 30) =>
    request<UsageStats>(`/projects/${encodeURIComponent(name)}/stats?days=${days}`),

  setMember: (project: string, userId: string, role: Role) =>
    request<{ project: string; userId: string; role: Role }>(
      `/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(userId)}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    ),

  /**
   * Adds a member by the name their owner knows them by.
   *
   * `setMember` needs a user id, and `users()` - the only way to turn a name
   * into one - is reserved to administrators. So the registry resolves the name
   * itself rather than leaking its user list to every project owner.
   */
  addMember: (project: string, username: string, role: Role) =>
    request<{ project: string; userId: string; username: string; role: Role }>(
      `/projects/${encodeURIComponent(project)}/members`,
      { method: "POST", body: JSON.stringify({ username, role }) },
    ),

  removeMember: (project: string, userId: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  cleanupPolicy: (project: string) =>
    request<CleanupPolicy>(`/projects/${encodeURIComponent(project)}/cleanup`),

  setCleanupPolicy: (
    project: string,
    policy: Omit<CleanupPolicy, "project" | "nextRunAt" | "lastRunAt" | "lastResult">,
  ) =>
    request<CleanupPolicy>(`/projects/${encodeURIComponent(project)}/cleanup`, {
      method: "PUT",
      body: JSON.stringify(policy),
    }),

  notifications: (project: string) =>
    request<{ policies: NotificationPolicySummary[] }>(
      `/projects/${encodeURIComponent(project)}/notifications`,
    ).then((r) => r.policies),

  /** What was sent and what came back, newest first. */
  deliveries: (project: string, limit = 50) =>
    request<{ deliveries: NotificationDelivery[] }>(
      `/projects/${encodeURIComponent(project)}/deliveries?limit=${limit}`,
    ).then((r) => r.deliveries),

  createNotification: (
    project: string,
    input: { name: string; targetType: "webhook" | "email"; target: string; eventTypes: string[] },
  ) =>
    request<{ id: string; secret?: string }>(`/projects/${encodeURIComponent(project)}/notifications`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  deleteNotification: (project: string, id: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/notifications/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  replicationRules: (project: string) =>
    request<{ rules: ReplicationRuleSummary[] }>(`/projects/${encodeURIComponent(project)}/replication`).then(
      (r) => r.rules,
    ),

  /** What each run copied, newest first. */
  executions: (project: string, limit = 50) =>
    request<{ executions: ReplicationExecution[] }>(
      `/projects/${encodeURIComponent(project)}/executions?limit=${limit}`,
    ).then((r) => r.executions),

  createReplicationRule: (project: string, input: Record<string, unknown>) =>
    request<{ id: string }>(`/projects/${encodeURIComponent(project)}/replication`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  runReplicationRule: (project: string, id: string) =>
    request<{ queued: boolean }>(
      `/projects/${encodeURIComponent(project)}/replication/${encodeURIComponent(id)}`,
      { method: "POST", body: "{}" },
    ),

  deleteReplicationRule: (project: string, id: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/replication/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
