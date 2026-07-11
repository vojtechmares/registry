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
  /**
   * A tag in this project may not be moved to another digest, nor deleted, nor
   * retired by a cleanup rule. Re-pushing the digest a tag already names is
   * still allowed: it changes nothing, and CI reruns.
   */
  readonly immutableTags: boolean;
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
  readonly immutableTags?: boolean;
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
  /**
   * The one project this token reaches, whatever its scopes say.
   *
   * Null only for a token minted before every token had to name a project.
   * Such a token no longer authenticates, and exists to be revoked.
   */
  readonly project: string | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revoked: boolean;
}

/** A project's token, as its owner sees it: whose it is, and what it reaches. */
export interface ProjectAccessToken extends AccessTokenSummary {
  readonly username: string;
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

/**
 * One field a validator refused, as RFC 9457's own worked example spells it.
 *
 * `pointer` is a JSON Pointer into the request body, where `""` names the body
 * itself. A fault in the query string or the path has no document to point
 * into, so it names the parameter instead. Never both, and neither when the
 * validator could not say which field it meant.
 */
export interface ProblemFieldError {
  readonly detail: string;
  readonly pointer?: string;
  readonly parameter?: string;
}

/**
 * Every refusal the management API makes, as an RFC 9457 problem document,
 * served as `application/problem+json`.
 *
 * `type` identifies the problem and is the thing to branch on: it is a URI, but
 * an identifier rather than an address, and it is the same string whichever host
 * serves the API. `title` summarises that type and never varies. `detail`
 * describes this one occurrence and is the sentence a person is shown.
 * `instance` is the path that produced it.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  /** Present when a body, query or path failed validation. One entry per field. */
  readonly errors?: readonly ProblemFieldError[];
  /**
   * The distribution-spec error code, when the refusal came from the
   * authorization code the two planes share. It is what `/v2` would have
   * answered with for the same refusal.
   */
  readonly code?: string;
}

/** The kinds of thing an audit event can be about. */
export type AuditResourceType = "project" | "repository" | "artifact" | "user" | "token";

/** `user` acted directly, `token` through a machine credential, `system` is a cron. */
export type AuditActorKind = "user" | "token" | "system" | "anonymous";

/**
 * One change, and who made it.
 *
 * Pulls are not recorded: one `docker pull` reaches the manifest endpoint many
 * times, and `UsageStats` already counts them. Pushes and deletes are.
 */
export interface AuditEvent {
  readonly id: string;
  /** Null when the actor was anonymous or a cron. */
  readonly actorId: string | null;
  /** The username as it was, so the row still reads once the account is deleted. */
  readonly actorName: string;
  readonly actorKind: AuditActorKind;
  /** Which machine credential, when one was used. */
  readonly actorTokenId: string | null;
  /** `noun.verb`: `project.update`, `member.add`, `artifact.push`. */
  readonly action: string;
  readonly resourceType: AuditResourceType;
  /** A project name, a repository name, `repo:tag`, a user id. */
  readonly resource: string;
  /** Null for a change to a user, which belongs to no project. */
  readonly project: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly createdAt: number;
}

/** `cursor` is opaque; pass it back as `?cursor=` for the next page. Null at the end. */
export interface AuditPage {
  readonly events: readonly AuditEvent[];
  readonly cursor: string | null;
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

/**
 * Which tags a rule applies to. Every criterion that is set must hold.
 *
 * `pattern` is an anchored glob; `regex` is a searched regular expression, so
 * `rc` finds `v1-rc1` and `^rc$` does not. The registry matches it with an
 * engine that cannot backtrack, and rejects lookaround and backreferences.
 */
export interface TagCriteria {
  readonly pattern?: string;
  readonly semver?: string;
  readonly regex?: string;
  readonly includePrerelease?: boolean;
}

/**
 * Which tags a cleanup rule governs, and how many of them it keeps. `kind` is
 * absent in rows written before the untagged kind existed, so an absent `kind`
 * means a tags rule.
 */
export interface TagsRule {
  readonly kind?: "tags";
  /** A glob over repository names within the project. `*` for all of them. */
  readonly repositories: string;
  readonly tags: TagCriteria;
  readonly keepLast: number | null;
  readonly keepWithinDays: number | null;
  /** How "newest" is decided when keeping the last `keepLast`. Defaults to update time. */
  readonly keepBy?: "updated" | "semver";
}

/**
 * Retires untagged manifests older than a TTL in the repositories its glob
 * matches. Scoped by repository so enabling it for one repository cannot sweep
 * untagged manifests in siblings that never opted in.
 */
export interface UntaggedRule {
  readonly kind: "untagged";
  readonly repositories: string;
  readonly olderThanDays: number;
}

/** One entry in a cleanup policy: either a tags rule or an untagged rule. */
export type CleanupRule = TagsRule | UntaggedRule;

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
    readonly regex?: string | undefined;
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

/** The acknowledgement that a rule was queued to run, and which rule it was. */
export interface QueuedReplication {
  readonly queued: boolean;
  readonly rule: string;
}

/**
 * A notification policy as it comes back from creation, with its signing secret.
 *
 * The secret signs a webhook's payload and is shown exactly here, once. A
 * webhook with none gets one minted; an email target has no secret at all.
 */
export interface CreatedNotificationPolicy extends NotificationPolicySummary {
  readonly secret: string | null;
}

/**
 * The membership a grant established. `username` accompanies a fresh grant and
 * is absent when only an existing member's role changed.
 */
export interface MemberGrant {
  readonly project: string;
  readonly userId: string;
  readonly username?: string;
  readonly role: Role;
}

/** One retirement in a project's cleanup history. */
export interface CleanupEvent {
  readonly repository: string | null;
  readonly action: string;
  readonly subject: string;
  readonly reason: string;
  readonly createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* Request inputs                                                             */
/*                                                                            */
/* Hand-written, never inferred from the valibot schemas (ADR-0001: the       */
/* contract stays runtime-free). Each is pinned to its schema by a            */
/* bidirectional guard in apps/registry/src/api/schemas.ts, so either side    */
/* drifting fails to compile. A field the caller may omit is optional; a      */
/* field it may send absent or as null carries `| null | undefined`, matching */
/* the schema's nullish default. Arrays are mutable because that is what the  */
/* schema accepts and the guard is exact.                                     */
/* -------------------------------------------------------------------------- */

export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export interface CreateUserInput {
  readonly username: string;
  readonly password: string;
  readonly email: string;
  readonly isAdmin?: boolean | null | undefined;
}

export interface UpdateUserInput {
  readonly email: string;
}

export interface ScopeInput {
  readonly repository: string;
  readonly actions: readonly Action[];
}

export interface CreateTokenInput {
  readonly name: string;
  readonly scopes: readonly ScopeInput[];
  readonly project?: string | null | undefined;
  readonly expiresInDays?: number | null | undefined;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly visibility?: Visibility | null | undefined;
  readonly description?: string | null | undefined;
  readonly quotaBytes?: number | null | undefined;
}

export interface AddMemberInput {
  readonly username: string;
  readonly role: Role;
}

export interface SetMemberInput {
  readonly role: Role;
}

export interface LifecyclePolicyInput {
  readonly enabled?: boolean | null | undefined;
  readonly keepLastTags?: number | null | undefined;
  readonly untaggedTtlDays?: number | null | undefined;
}

export interface TagsRuleInput {
  readonly kind?: "tags";
  readonly repositories: string;
  readonly tags?: TagCriteria | null | undefined;
  readonly keepLast?: number | null | undefined;
  readonly keepWithinDays?: number | null | undefined;
  readonly keepBy?: "updated" | "semver";
}

export interface UntaggedRuleInput {
  readonly kind: "untagged";
  readonly repositories: string;
  readonly olderThanDays: number;
}

export type CleanupRuleInput = TagsRuleInput | UntaggedRuleInput;

export interface CleanupPolicyInput {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly rules: readonly CleanupRuleInput[];
  readonly untaggedOlderThanDays?: number | null | undefined;
}

export interface CreateNotificationInput {
  readonly name: string;
  readonly targetType: NotificationTargetType;
  readonly target: string;
  readonly secret?: string | null | undefined;
  readonly eventTypes: readonly NotificationEventType[];
}

export interface CreateReplicationRuleInput {
  readonly name: string;
  readonly direction: ReplicationDirection;
  readonly remoteUrl: string;
  readonly trigger?: ReplicationTrigger | null | undefined;
  readonly schedule?: string | null | undefined;
  readonly sourceRepositories?: readonly string[] | null | undefined;
  readonly repositoryFilter?: string | null | undefined;
  readonly destinationNamespace?: string | null | undefined;
  readonly tagFilter?: TagCriteria | null | undefined;
  readonly remoteUsername?: string | undefined;
  readonly remotePassword?: string | undefined;
}
