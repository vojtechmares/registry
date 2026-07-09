import type {
  AccessTokenSummary,
  CreatedAccessToken,
  LifecyclePolicy,
  ManifestDetail,
  RegistryStats,
  RepositoryDetail,
  RepositorySummary,
  SessionUser,
  TagSummary,
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

  setVisibility: (name: string, visibility: Visibility) =>
    request<{ name: string; visibility: Visibility }>(`/repositories/${repoPath(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ visibility }),
    }),

  deleteRepository: (name: string) => request<void>(`/repositories/${repoPath(name)}`, { method: "DELETE" }),

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
};
