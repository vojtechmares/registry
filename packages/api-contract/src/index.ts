/**
 * The management API contract, shared with the dashboard.
 *
 * These types are the single source of truth for both sides. The UI imports
 * them directly rather than restating the shapes.
 */

export type Visibility = "public" | "private";
export type Action = "pull" | "push" | "delete";
export type Role = "guest" | "developer" | "maintainer" | "owner";

export interface SessionUser {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

/**
 * A project: the first path segment of every repository inside it, and the
 * only place policy lives.
 */
export interface ProjectSummary {
  readonly name: string;
  readonly visibility: Visibility;
  readonly description: string | null;
  /** Null is unlimited. Bytes, counted once per distinct blob in the project. */
  readonly quotaBytes: number | null;
  readonly usedBytes: number;
  readonly requireSignaturePush: boolean;
  readonly requireSignaturePull: boolean;
  readonly repositories: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The caller's role, or null when they are not a member. Absent for anonymous callers. */
  readonly role: Role | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
}

export interface ProjectDetail extends ProjectSummary {
  readonly members: readonly ProjectMember[];
}

/** Everything an owner may change about a project. Every field is optional. */
export interface ProjectSettings {
  readonly visibility?: Visibility;
  readonly description?: string | null;
  readonly quotaBytes?: number | null;
  readonly requireSignaturePush?: boolean;
  readonly requireSignaturePull?: boolean;
}

export interface RegistryStats {
  readonly projects: number;
  readonly repositories: number;
  readonly tags: number;
  readonly manifests: number;
  readonly blobs: number;
  /** Everything held in the object store, including content awaiting collection. */
  readonly storageBytes: number;
  /** Distinct content at least one repository still links. */
  readonly referencedBytes: number;
  /**
   * What that content would occupy if every repository kept its own copy.
   * `logicalBytes - referencedBytes` is what deduplication saves.
   */
  readonly logicalBytes: number;
  /** Unreferenced content the next garbage collection will reclaim. */
  readonly reclaimableBytes: number;
}

export interface RepositorySummary {
  readonly name: string;
  readonly project: string;
  /** Inherited from the project. Repositories have no visibility of their own. */
  readonly visibility: Visibility;
  readonly tags: number;
  readonly manifests: number;
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

export interface TagSummary {
  readonly name: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

export interface ManifestDetail {
  readonly digest: string;
  readonly mediaType: string;
  readonly artifactType: string | null;
  readonly size: number;
  readonly subjectDigest: string | null;
  readonly annotations: Record<string, string> | null;
  readonly createdAt: number;
  readonly tags: readonly string[];
  readonly blobs: ReadonlyArray<{ digest: string; size: number }>;
  readonly referrers: ReadonlyArray<{
    digest: string;
    artifactType: string | null;
    mediaType: string;
    size: number;
    annotations: Record<string, string> | null;
  }>;
}

export interface RepositoryDetail {
  readonly name: string;
  readonly project: string;
  readonly visibility: Visibility;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tags: readonly TagSummary[];
}

export interface AccessTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly scopes: ReadonlyArray<{ repository: string; actions: readonly Action[] }>;
  /** Non-null pins the token to one project, whatever its scopes say. */
  readonly project: string | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revoked: boolean;
}

/** The plaintext secret is returned exactly once, at creation. */
export interface CreatedAccessToken extends AccessTokenSummary {
  readonly secret: string;
}

export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
  readonly isAdmin: boolean;
  readonly disabled: boolean;
  readonly createdAt: number;
}

export interface LifecyclePolicy {
  readonly repository: string;
  readonly enabled: boolean;
  readonly keepLastTags: number | null;
  readonly untaggedTtlDays: number | null;
}

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
}
