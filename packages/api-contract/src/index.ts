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

/** One day of activity. `day` is an ISO calendar date in UTC. */
export interface UsagePoint {
  readonly day: string;
  readonly pulls: number;
  readonly pushes: number;
  readonly deletes: number;
}

export interface UsageTotals {
  readonly pulls: number;
  readonly pushes: number;
  readonly deletes: number;
}

/** A repository's share of a project's activity, for the per-image breakdown. */
export interface RepositoryUsage extends UsageTotals {
  readonly repository: string;
  readonly sizeBytes: number;
}

export interface UsageStats {
  /** The project or repository these numbers describe. */
  readonly scope: string;
  readonly days: number;
  readonly totals: UsageTotals;
  /** Bytes stored, counted once per distinct blob within the scope. */
  readonly storageBytes: number;
  /** One point per day in the window, including the days with no activity. */
  readonly series: readonly UsagePoint[];
  /** Present for a project, absent for a single repository. */
  readonly repositories?: readonly RepositoryUsage[];
}

/** Which tags a cleanup rule governs, and how many of them it keeps. */
export interface CleanupRule {
  /** A glob over repository names within the project. `*` for all of them. */
  readonly repositories: string;
  readonly tags: {
    readonly pattern?: string;
    readonly semver?: string;
    readonly includePrerelease?: boolean;
  };
  readonly keepLast: number | null;
  readonly keepWithinDays: number | null;
  readonly keepBy?: "updated" | "semver";
}

export interface CleanupPolicy {
  readonly project: string;
  readonly enabled: boolean;
  /** A five-field cron expression, in UTC. */
  readonly schedule: string;
  readonly rules: readonly CleanupRule[];
  readonly untaggedOlderThanDays: number | null;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastResult: { tagsRemoved: number; untaggedRemoved: number } | null;
}

export interface AuthProviders {
  readonly password: boolean;
  readonly oidc: boolean;
}

/** What the registry tells an outside listener about. */
export type NotificationEventType =
  | "PUSH_ARTIFACT"
  | "PULL_ARTIFACT"
  | "DELETE_ARTIFACT"
  | "QUOTA_EXCEEDED"
  | "REPLICATION"
  | "CLEANUP";

export type NotificationTargetType = "webhook" | "email";

/**
 * A notification policy as the dashboard sees it.
 *
 * Without its secret, deliberately: the secret that signs a webhook's payload
 * is shown once, in the response that creates the policy, and is never listed.
 */
export interface NotificationPolicySummary {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly targetType: NotificationTargetType;
  /** A URL for a webhook, an address for an email. */
  readonly target: string;
  readonly eventTypes: readonly NotificationEventType[];
}

/** One attempt at delivering one event, so a silently broken endpoint can be found. */
export interface NotificationDelivery {
  readonly id: string;
  readonly policyId: string;
  /** Recorded as it was sent. A policy since retyped leaves its old rows behind. */
  readonly eventType: string;
  readonly status: "delivered" | "failed";
  readonly responseStatus: number | null;
  readonly error: string | null;
  readonly createdAt: number;
}

export type ReplicationDirection = "push" | "pull";

/** `event` fires on every push; `scheduled` on a cron; `manual` only when asked. */
export type ReplicationTrigger = "manual" | "event" | "scheduled";

/**
 * A replication rule as the dashboard sees it. The remote username identifies
 * the rule's account; the password is sealed at rest and never returned.
 */
export interface ReplicationRuleSummary {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly direction: ReplicationDirection;
  readonly remoteUrl: string;
  readonly destinationNamespace: string;
  readonly repositoryFilter: string;
  readonly sourceRepositories: readonly string[];
  readonly tagFilter: {
    readonly pattern?: string | undefined;
    readonly semver?: string | undefined;
    readonly includePrerelease?: boolean | undefined;
  };
  readonly trigger: ReplicationTrigger;
  readonly schedule: string | null;
  readonly remoteUsername: string | null;
  readonly nextRunAt: number | null;
  readonly lastRunAt: number | null;
  readonly lastResult: string | null;
}

/** What one run of a rule copied, so a rule that quietly stopped working can be found. */
export interface ReplicationExecution {
  readonly id: string;
  readonly ruleId: string;
  readonly status: "succeeded" | "failed";
  readonly repository: string | null;
  readonly reference: string | null;
  readonly manifests: number;
  readonly blobs: number;
  readonly error: string | null;
  readonly createdAt: number;
}
