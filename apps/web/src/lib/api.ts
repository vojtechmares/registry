import type {
  AccessTokenSummary,
  AuditPage,
  AuditResourceType,
  AuthProviders,
  CleanupPolicy,
  CleanupPolicyInput,
  CreatedAccessToken,
  CreatedNotificationPolicy,
  CreateNotificationInput,
  CreateProjectInput,
  CreateReplicationRuleInput,
  CreateTokenInput,
  CreateUserInput,
  LifecyclePolicy,
  LifecyclePolicyInput,
  ManifestDetail,
  MemberGrant,
  NotificationDelivery,
  NotificationPolicySummary,
  ProblemDetails,
  ProjectAccessToken,
  ProjectDetail,
  ProjectSettings,
  ProjectSummary,
  QueuedReplication,
  RegistryStats,
  ReplicationExecution,
  ReplicationRuleSummary,
  RepositoryDetail,
  RepositorySummary,
  Role,
  SessionUser,
  TagSummary,
  UpdateUserInput,
  UsageStats,
  UserSummary,
} from "@registry/api-contract";

/**
 * The management API client.
 *
 * The dashboard is served by the same Worker that serves the API, so every
 * request is same-origin and the session cookie rides along on its own. That is
 * also why nothing here reads or writes a token: the cookie is `HttpOnly` and
 * deliberately invisible to this code.
 */

/**
 * A refusal, read out of the RFC 9457 problem document the API answers with.
 *
 * `message` is the problem's `detail`: the sentence about this one occurrence,
 * and the only part meant for a person. `type` is the stable identifier to
 * branch on, though the status usually says enough.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;

  constructor(status: number, type: string, title: string, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.title = title;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

const BASE = "/api/v1";

/**
 * The problem document, as far as it can be trusted.
 *
 * A refusal that never reached the Worker - a proxy's HTML error page, an empty
 * body from a dropped connection - is still a refusal the dashboard has to
 * report, so a body that is not a problem document yields nothing rather than
 * throwing over it. The status is what the dashboard acts on either way.
 */
function problemOf(text: string): Partial<ProblemDetails> {
  let parsed: unknown;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};

  const { type, title, detail } = parsed as Record<string, unknown>;
  return {
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
  };
}

function errorOf(response: Response, text: string): ApiError {
  const problem = problemOf(text);
  const fallback =
    response.statusText === "" ? `Request failed with status ${response.status}` : response.statusText;

  return new ApiError(
    response.status,
    problem.type ?? "about:blank",
    problem.title ?? fallback,
    problem.detail ?? fallback,
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    // Same-origin, but stated explicitly: a stray `credentials: "omit"` default
    // would silently log the dashboard out.
    credentials: "same-origin",
    headers: {
      Accept: "application/json, application/problem+json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!response.ok) throw errorOf(response, text);

  return (text === "" ? {} : JSON.parse(text)) as T;
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

  /** Who changed what. Administrators only; `cursor` pages backwards in time. */
  audit: (query: {
    resourceType?: AuditResourceType;
    project?: string;
    actor?: string;
    action?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const search = params.toString();
    return request<AuditPage>(`/audit${search === "" ? "" : `?${search}`}`);
  },

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

  setPolicy: (repository: string, input: LifecyclePolicyInput) =>
    request<LifecyclePolicy>(`/repositories/${repoPath(repository)}/policy`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  /** Every token the caller owns, across the projects they belong to. */
  tokens: () => request<{ tokens: AccessTokenSummary[] }>("/tokens").then((r) => r.tokens),

  /** A project's tokens, whoever minted them. Owners only. */
  projectTokens: (project: string) =>
    request<{ tokens: ProjectAccessToken[] }>(`/projects/${encodeURIComponent(project)}/tokens`).then(
      (r) => r.tokens,
    ),

  /** A token always names a project; there is no registry-wide credential. */
  createProjectToken: (project: string, input: CreateTokenInput) =>
    request<CreatedAccessToken>(`/projects/${encodeURIComponent(project)}/tokens`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  revokeProjectToken: (project: string, id: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  revokeToken: (id: string) => request<void>(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

  users: () => request<{ users: UserSummary[] }>("/users").then((r) => r.users),

  createUser: (input: CreateUserInput) =>
    request<UserSummary>("/users", { method: "POST", body: JSON.stringify(input) }),

  /** An administrator may change any address; anyone else may change only their own. */
  updateUser: (id: string, input: UpdateUserInput) =>
    request<UserSummary>(`/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  deleteUser: (id: string) => request<void>(`/users/${encodeURIComponent(id)}`, { method: "DELETE" }),

  providers: () => request<AuthProviders>("/auth/providers"),

  projects: () => request<{ projects: ProjectSummary[] }>("/projects").then((r) => r.projects),

  project: (name: string) => request<ProjectDetail>(`/projects/${encodeURIComponent(name)}`),

  createProject: (input: CreateProjectInput) =>
    request<ProjectDetail>("/projects", { method: "POST", body: JSON.stringify(input) }),

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
    request<MemberGrant>(`/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(userId)}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),

  /**
   * Adds a member by the name their owner knows them by.
   *
   * `setMember` needs a user id, and `users()` - the only way to turn a name
   * into one - is reserved to administrators. So the registry resolves the name
   * itself rather than leaking its user list to every project owner.
   */
  addMember: (project: string, username: string, role: Role) =>
    request<MemberGrant>(`/projects/${encodeURIComponent(project)}/members`, {
      method: "POST",
      body: JSON.stringify({ username, role }),
    }),

  removeMember: (project: string, userId: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  cleanupPolicy: (project: string) =>
    request<CleanupPolicy>(`/projects/${encodeURIComponent(project)}/cleanup`),

  setCleanupPolicy: (project: string, policy: CleanupPolicyInput) =>
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

  createNotification: (project: string, input: CreateNotificationInput) =>
    request<CreatedNotificationPolicy>(`/projects/${encodeURIComponent(project)}/notifications`, {
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

  createReplicationRule: (project: string, input: CreateReplicationRuleInput) =>
    request<ReplicationRuleSummary>(`/projects/${encodeURIComponent(project)}/replication`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  runReplicationRule: (project: string, id: string) =>
    request<QueuedReplication>(
      `/projects/${encodeURIComponent(project)}/replication/${encodeURIComponent(id)}`,
      { method: "POST", body: "{}" },
    ),

  deleteReplicationRule: (project: string, id: string) =>
    request<void>(`/projects/${encodeURIComponent(project)}/replication/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};
