/**
 * Every shape the management API accepts, and every shape it returns.
 *
 * The request schemas are the validation: nothing reaches a handler without
 * passing through one. The response schemas exist so the published OpenAPI
 * document describes what the dashboard actually receives, and each is pinned
 * to the corresponding type in `@registry/api-contract` by an assignability
 * check at the bottom of this file - so a field renamed there fails to compile
 * here rather than quietly disappearing from the documentation.
 *
 * A message is written as a predicate ("must be a positive integer"), never
 * naming its own field. `describeIssue` prepends the field's path, so the same
 * check reads as `quotaBytes: must be a positive integer or null` at the top
 * level and `rules.0.keepLast: ...` nested inside an array.
 */

import type {
  AccessTokenSummary,
  AuditEvent,
  AuditPage,
  AuthProviders,
  CleanupPolicy,
  CreatedAccessToken,
  LifecyclePolicy,
  ManifestDetail,
  NotificationDelivery,
  NotificationPolicySummary,
  ProjectDetail,
  ProjectSummary,
  RegistryStats,
  ReplicationExecution,
  ReplicationRuleSummary,
  RepositoryDetail,
  RepositorySummary,
  SessionUser,
  TagSummary,
  UsageStats,
  UserSummary,
} from "@registry/api-contract";
import { isValidCron } from "@registry/cron";
import { EVENT_TYPES, isPublicHttpsUrl } from "@registry/notifications";
import { isValidDigest, isValidRepositoryName } from "@registry/oci";
import { ACTIONS, ROLES, isValidProjectName } from "@registry/projects";
import { RegexSyntaxError, compileRegex } from "@registry/regex";
import { parseRange } from "@registry/semver";
import * as v from "valibot";
import { isEmailAddress } from "./email.js";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A positive integer, or null. Used for quotas, retention counts and TTLs.
 *
 * `safeInteger`, not `integer`: a quota of 2^53 + 1 is a number JavaScript
 * cannot tell from its neighbour, and SQLite would store what it was handed.
 */
const positiveOrNull = v.nullable(
  v.pipe(
    v.number("must be a positive integer or null"),
    v.safeInteger("must be a positive integer or null"),
    v.minValue(1, "must be a positive integer or null"),
  ),
);

/** Zero is meaningful here: `keepLast: 0` retires every tag the rule governs. */
const nonNegativeOrNull = v.nullable(
  v.pipe(
    v.number("must be a non-negative integer or null"),
    v.safeInteger("must be a non-negative integer or null"),
    v.minValue(0, "must be a non-negative integer or null"),
  ),
);

const nonEmpty = (message: string) => v.pipe(v.string(message), v.trim(), v.minLength(1, message));

/**
 * A field the caller may leave out - by omitting it, or by sending `null`.
 *
 * Some clients serialise an absent value as `null` rather than dropping the key,
 * and the router this replaced read both the same way (`body.x ?? fallback`).
 * `null` still means "clear this" where a field genuinely holds one, which is
 * why `PATCH /projects` spells that with `nullable` instead.
 */
const unset = <const Schema extends v.GenericSchema, const Fallback extends v.InferInput<Schema>>(
  schema: Schema,
  fallback: Fallback,
) => v.nullish(schema, fallback);

const projectName = v.pipe(
  v.string("must be a project name"),
  v.check(isValidProjectName, "is not a valid project name"),
);

const repositoryName = v.pipe(
  v.string("must be a repository name"),
  v.check(isValidRepositoryName, "is not a valid repository name"),
);

const digest = v.pipe(v.string("must be a digest"), v.check(isValidDigest, "is not a valid digest"));

const email = v.pipe(
  v.string("must be an email address"),
  v.trim(),
  v.toLowerCase(),
  v.check(isEmailAddress, "is not an email address"),
);

const cron = v.pipe(
  v.string("must be a five-field cron expression, in UTC"),
  v.check(isValidCron, "must be a five-field cron expression, in UTC"),
);

const visibility = v.picklist(["public", "private"] as const, 'must be "public" or "private"');
const role = v.picklist(ROLES, `must be one of ${ROLES.join(", ")}`);
const action = v.picklist(ACTIONS, `must be one of ${ACTIONS.join(", ")}`);

/**
 * Why the pattern will not compile, or null.
 *
 * A regular expression is refused at the moment an operator types it rather
 * than ignored by the evaluator hours later. The engine's message names the
 * offset, and the reason - `a**`, a backreference, lookaround - is the reason
 * a backtracking engine would have been unsafe.
 */
function regexError(source: string): string | null {
  if (source === "") return null;
  try {
    compileRegex(source);
    return null;
  } catch (error) {
    return error instanceof RegexSyntaxError ? error.message : "it will not compile";
  }
}

const semverRange = v.pipe(
  v.string("must be a semver range"),
  v.check(
    (raw) => raw === "" || parseRange(raw) !== null,
    (issue) => `"${issue.input}" is not a valid semver range`,
  ),
);

const safeRegex = v.pipe(
  v.string("must be a regular expression"),
  v.check(
    (raw) => regexError(raw) === null,
    (issue) => `is not a valid regular expression: ${regexError(issue.input) ?? ""}`,
  ),
);

/**
 * Which tags a rule applies to. Every criterion that is set must hold.
 *
 * `exactOptional` rather than `optional` throughout: an absent criterion and one
 * explicitly set to `undefined` are the same thing over JSON, and only the
 * former survives `exactOptionalPropertyTypes` when the parsed rule is handed
 * back to the `TagCriteria` the contract declares.
 */
export const TagCriteriaSchema = v.object({
  pattern: v.exactOptional(v.string("must be a glob")),
  semver: v.exactOptional(semverRange),
  regex: v.exactOptional(safeRegex),
  includePrerelease: v.exactOptional(v.boolean("must be a boolean")),
});

/**
 * A window of days, clamped rather than refused.
 *
 * A dashboard that asks for a decade of history should get the longest window
 * the table can still serve, not an error it has no way to act on.
 */
const windowDays = v.pipe(
  v.optional(v.string(), "30"),
  v.transform((raw) => {
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return 30;
    return Math.min(parsed, 365);
  }),
);

/** A page size, clamped the same way. A negative one used to mean "no limit" to SQLite. */
const pageLimit = (fallback: number, max: number) =>
  v.pipe(
    v.optional(v.string(), String(fallback)),
    v.transform((raw) => {
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
      return Math.min(parsed, max);
    }),
  );

/** An absent or empty query parameter is no filter at all, not a filter on `""`. */
const filter = v.pipe(
  v.optional(v.string(), ""),
  v.transform((raw) => (raw === "" ? undefined : raw)),
);

/* -------------------------------------------------------------------------- */
/* Path and query parameters                                                   */
/* -------------------------------------------------------------------------- */

export const ProjectParam = v.object({ project: projectName });
export const ProjectTargetParam = v.object({ project: projectName, id: v.string() });
export const ProjectMemberParam = v.object({ project: projectName, userId: v.string() });
export const RepositoryParam = v.object({ name: repositoryName });
export const ManifestParam = v.object({ name: repositoryName, digest });
export const IdParam = v.object({ id: v.string() });

export const WindowQuery = v.object({ days: windowDays });
export const LimitQuery = v.object({ limit: pageLimit(100, 500) });

export const RepositoryListQuery = v.object({
  search: v.optional(v.string()),
  project: v.optional(v.string()),
  limit: pageLimit(100, 500),
});

const AUDIT_RESOURCE_TYPES = ["project", "repository", "artifact", "user", "token"] as const;
const auditResourceType = v.picklist(AUDIT_RESOURCE_TYPES, "is not an audited resource type");

/** `?resourceType=` with nothing after it is no filter at all, not a filter on `""`. */
const auditResourceTypeFilter = v.pipe(
  v.optional(v.picklist(["", ...AUDIT_RESOURCE_TYPES], "is not an audited resource type"), ""),
  v.transform((raw) => (raw === "" ? undefined : raw)),
);

export const AuditQuery = v.object({
  resourceType: auditResourceTypeFilter,
  project: filter,
  actor: filter,
  action: filter,
  cursor: filter,
  limit: pageLimit(50, 200),
});

export const OidcStartQuery = v.object({ next: v.optional(v.string()) });

/* -------------------------------------------------------------------------- */
/* Request bodies                                                              */
/* -------------------------------------------------------------------------- */

export const LoginBody = v.object({
  username: v.string("must be a username"),
  password: v.string("must be a password"),
});

export const CreateUserBody = v.object({
  username: v.pipe(
    v.string("must be a username"),
    v.regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "must be 2-64 lowercase characters, starting alphanumeric"),
  ),
  password: v.pipe(v.string("must be a password"), v.minLength(12, "must be at least 12 characters")),
  email,
  isAdmin: unset(v.boolean("must be a boolean"), false),
});

export const UpdateUserBody = v.object({ email });

export const ScopeBody = v.object({
  repository: nonEmpty("is required"),
  actions: v.pipe(v.array(action), v.minLength(1, "must name at least one action")),
});

export const CreateTokenBody = v.object({
  name: nonEmpty("is required"),
  scopes: v.pipe(v.array(ScopeBody), v.minLength(1, "must name at least one scope")),
  project: v.nullish(projectName),
  // A token that expires in no days is a token that never expires, which is not
  // what anybody who typed a number meant. The old router read `0` that way.
  expiresInDays: v.nullish(
    v.pipe(
      v.number("must be a whole number of days"),
      v.safeInteger("must be a whole number of days"),
      v.minValue(1, "must be at least a day"),
    ),
  ),
});

export const CreateProjectBody = v.object({
  name: projectName,
  visibility: unset(visibility, "private"),
  description: unset(v.string("must be a string"), ""),
  quotaBytes: v.optional(positiveOrNull, null),
});

/**
 * Everything an owner may change. Every field is optional, and an absent field
 * is left alone rather than cleared - which is why `exactOptional` is
 * load-bearing: valibot leaves an absent key off the parsed object entirely, so
 * the settings handed to the store name only what the caller actually sent.
 */
export const UpdateProjectBody = v.object({
  visibility: v.exactOptional(visibility),
  description: v.exactOptional(v.nullable(v.string("must be a string or null"))),
  quotaBytes: v.exactOptional(positiveOrNull),
  requireSignaturePush: v.exactOptional(v.boolean("must be a boolean")),
  requireSignaturePull: v.exactOptional(v.boolean("must be a boolean")),
  immutableTags: v.exactOptional(v.boolean("must be a boolean")),
});

export const AddMemberBody = v.object({ username: nonEmpty("is required"), role });
export const SetMemberBody = v.object({ role });

export const LifecyclePolicyBody = v.object({
  enabled: unset(v.boolean("must be a boolean"), false),
  keepLastTags: v.optional(positiveOrNull, null),
  untaggedTtlDays: v.optional(positiveOrNull, null),
});

/** Bounds the work one scheduled cleanup can be asked to do. */
export const MAX_CLEANUP_RULES = 32;

export const CleanupRuleBody = v.object({
  repositories: nonEmpty("must be a non-empty glob"),
  tags: unset(TagCriteriaSchema, {}),
  keepLast: v.optional(nonNegativeOrNull, null),
  keepWithinDays: v.optional(nonNegativeOrNull, null),
  keepBy: v.exactOptional(v.picklist(["updated", "semver"] as const, 'must be "updated" or "semver"')),
});

export const CleanupPolicyBody = v.object({
  enabled: v.boolean("must be a boolean"),
  schedule: cron,
  // Every rule is compiled and then evaluated against every tag in the project,
  // on a cron that shares a Worker's CPU budget with everything else. A policy
  // that needs more than this many rules is expressing something else.
  rules: v.pipe(
    v.array(CleanupRuleBody),
    v.maxLength(MAX_CLEANUP_RULES, `a policy may hold at most ${MAX_CLEANUP_RULES} rules`),
  ),
  untaggedOlderThanDays: v.optional(nonNegativeOrNull, null),
});

const eventType = v.picklist(EVENT_TYPES, `must be one of ${EVENT_TYPES.join(", ")}`);

export const CreateNotificationBody = v.object({
  name: nonEmpty("is required"),
  targetType: v.picklist(["webhook", "email"] as const, 'must be "webhook" or "email"'),
  target: nonEmpty("is required"),
  secret: unset(v.string("must be a string"), ""),
  eventTypes: v.pipe(v.array(eventType), v.minLength(1, "must name at least one event type")),
});

/**
 * A rule sends credentials to this URL and pulls content back from it, so it is
 * held to the same standard as a webhook target: https, and never an address
 * that only the registry can reach. The runtime client re-checks the base, its
 * redirects, and the token realm, but refusing a bad URL here means the owner
 * finds out when they type it.
 */
const remoteUrl = v.pipe(
  v.string("must be a URL"),
  v.transform((raw) => {
    try {
      return new URL(raw).origin;
    } catch {
      return "";
    }
  }),
  v.check(isPublicHttpsUrl, "must be an https URL that does not resolve to a private address"),
);

export const CreateReplicationRuleBody = v.object({
  name: nonEmpty("is required"),
  direction: v.picklist(["push", "pull"] as const, 'must be "push" or "pull"'),
  remoteUrl,
  trigger: unset(
    v.picklist(["manual", "event", "scheduled"] as const, 'must be "manual", "event" or "scheduled"'),
    "manual",
  ),
  schedule: v.nullish(cron),
  sourceRepositories: unset(v.array(repositoryName), []),
  repositoryFilter: unset(nonEmpty("must be a non-empty glob"), "*"),
  destinationNamespace: unset(v.string("must be a string"), ""),
  tagFilter: unset(TagCriteriaSchema, {}),
  remoteUsername: v.optional(v.string("must be a string")),
  remotePassword: v.optional(v.string("must be a string")),
});

/** The parsed shapes, for the handlers that pass a body on to a helper. */
export type CreateTokenInput = v.InferOutput<typeof CreateTokenBody>;
export type CleanupPolicyInputBody = v.InferOutput<typeof CleanupPolicyBody>;
export type CreateReplicationRuleInput = v.InferOutput<typeof CreateReplicationRuleBody>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

const timestamp = v.number();

export const ApiErrorSchema = v.object({ error: v.string(), message: v.string() });

export const SessionUserSchema = v.object({
  id: v.string(),
  username: v.string(),
  isAdmin: v.boolean(),
});

export const AuthProvidersSchema = v.object({ password: v.boolean(), oidc: v.boolean() });

export const RegistryStatsSchema = v.object({
  projects: v.number(),
  repositories: v.number(),
  tags: v.number(),
  manifests: v.number(),
  blobs: v.number(),
  storageBytes: v.number(),
  referencedBytes: v.number(),
  logicalBytes: v.number(),
  reclaimableBytes: v.number(),
});

export const ProjectSummarySchema = v.object({
  name: v.string(),
  visibility,
  description: v.nullable(v.string()),
  quotaBytes: v.nullable(v.number()),
  usedBytes: v.number(),
  requireSignaturePush: v.boolean(),
  requireSignaturePull: v.boolean(),
  immutableTags: v.boolean(),
  repositories: v.number(),
  createdAt: timestamp,
  updatedAt: timestamp,
  role: v.nullable(role),
});

export const ProjectMemberSchema = v.object({
  userId: v.string(),
  username: v.string(),
  role,
  createdAt: timestamp,
});

export const ProjectDetailSchema = v.object({
  ...ProjectSummarySchema.entries,
  members: v.array(ProjectMemberSchema),
});

export const RepositorySummarySchema = v.object({
  name: v.string(),
  project: v.string(),
  visibility,
  tags: v.number(),
  manifests: v.number(),
  sizeBytes: v.number(),
  updatedAt: timestamp,
});

export const TagSummarySchema = v.object({
  name: v.string(),
  digest: v.string(),
  mediaType: v.string(),
  sizeBytes: v.number(),
  updatedAt: timestamp,
});

export const RepositoryDetailSchema = v.object({
  name: v.string(),
  project: v.string(),
  visibility,
  sizeBytes: v.number(),
  createdAt: timestamp,
  updatedAt: timestamp,
  tags: v.array(TagSummarySchema),
});

export const ManifestDetailSchema = v.object({
  digest: v.string(),
  mediaType: v.string(),
  artifactType: v.nullable(v.string()),
  size: v.number(),
  subjectDigest: v.nullable(v.string()),
  annotations: v.nullable(v.record(v.string(), v.string())),
  createdAt: timestamp,
  tags: v.array(v.string()),
  blobs: v.array(v.object({ digest: v.string(), size: v.number() })),
  referrers: v.array(
    v.object({
      digest: v.string(),
      artifactType: v.nullable(v.string()),
      mediaType: v.string(),
      size: v.number(),
      annotations: v.nullable(v.record(v.string(), v.string())),
    }),
  ),
});

export const AccessTokenSummarySchema = v.object({
  id: v.string(),
  name: v.string(),
  scopes: v.array(v.object({ repository: v.string(), actions: v.array(action) })),
  project: v.nullable(v.string()),
  expiresAt: v.nullable(timestamp),
  createdAt: timestamp,
  lastUsedAt: v.nullable(timestamp),
  revoked: v.boolean(),
});

export const ProjectAccessTokenSchema = v.object({
  ...AccessTokenSummarySchema.entries,
  username: v.string(),
});

/** The plaintext secret is returned exactly once, at creation. */
export const CreatedAccessTokenSchema = v.object({
  ...AccessTokenSummarySchema.entries,
  secret: v.string(),
});

export const UserSummarySchema = v.object({
  id: v.string(),
  username: v.string(),
  email: v.nullable(v.string()),
  isAdmin: v.boolean(),
  disabled: v.boolean(),
  createdAt: timestamp,
});

export const LifecyclePolicySchema = v.object({
  repository: v.string(),
  enabled: v.boolean(),
  keepLastTags: v.nullable(v.number()),
  untaggedTtlDays: v.nullable(v.number()),
});

export const AuditEventSchema = v.object({
  id: v.string(),
  actorId: v.nullable(v.string()),
  actorName: v.string(),
  actorKind: v.picklist(["user", "token", "system", "anonymous"] as const),
  actorTokenId: v.nullable(v.string()),
  action: v.string(),
  resourceType: auditResourceType,
  resource: v.string(),
  project: v.nullable(v.string()),
  detail: v.nullable(v.record(v.string(), v.unknown())),
  createdAt: timestamp,
});

export const AuditPageSchema = v.object({
  events: v.array(AuditEventSchema),
  cursor: v.nullable(v.string()),
});

const usageTotals = v.object({ pulls: v.number(), pushes: v.number(), deletes: v.number() });

export const UsageStatsSchema = v.object({
  scope: v.string(),
  days: v.number(),
  totals: usageTotals,
  storageBytes: v.number(),
  series: v.array(v.object({ day: v.string(), ...usageTotals.entries })),
  /** Present for a project, absent for a single repository. */
  repositories: v.exactOptional(
    v.array(v.object({ repository: v.string(), sizeBytes: v.number(), ...usageTotals.entries })),
  ),
});

export const CleanupPolicySchema = v.object({
  project: v.string(),
  enabled: v.boolean(),
  schedule: v.string(),
  rules: v.array(
    v.object({
      repositories: v.string(),
      tags: TagCriteriaSchema,
      keepLast: v.nullable(v.number()),
      keepWithinDays: v.nullable(v.number()),
      keepBy: v.exactOptional(v.picklist(["updated", "semver"] as const)),
    }),
  ),
  untaggedOlderThanDays: v.nullable(v.number()),
  nextRunAt: v.nullable(timestamp),
  lastRunAt: v.nullable(timestamp),
  lastResult: v.nullable(v.object({ tagsRemoved: v.number(), untaggedRemoved: v.number() })),
});

export const CleanupEventSchema = v.object({
  repository: v.nullable(v.string()),
  action: v.string(),
  subject: v.string(),
  reason: v.string(),
  createdAt: timestamp,
});

export const NotificationPolicySchema = v.object({
  id: v.string(),
  project: v.string(),
  name: v.string(),
  enabled: v.boolean(),
  targetType: v.picklist(["webhook", "email"] as const),
  target: v.string(),
  eventTypes: v.array(v.picklist(EVENT_TYPES)),
});

/** The signing secret is shown once, in the response that creates the policy. */
export const CreatedNotificationPolicySchema = v.object({
  ...NotificationPolicySchema.entries,
  secret: v.nullable(v.string()),
});

export const NotificationDeliverySchema = v.object({
  id: v.string(),
  policyId: v.string(),
  eventType: v.string(),
  status: v.picklist(["delivered", "failed"] as const),
  responseStatus: v.nullable(v.number()),
  error: v.nullable(v.string()),
  createdAt: timestamp,
});

export const ReplicationRuleSchema = v.object({
  id: v.string(),
  project: v.string(),
  name: v.string(),
  enabled: v.boolean(),
  direction: v.picklist(["push", "pull"] as const),
  remoteUrl: v.string(),
  destinationNamespace: v.string(),
  repositoryFilter: v.string(),
  sourceRepositories: v.array(v.string()),
  tagFilter: TagCriteriaSchema,
  trigger: v.picklist(["manual", "event", "scheduled"] as const),
  schedule: v.nullable(v.string()),
  remoteUsername: v.nullable(v.string()),
  nextRunAt: v.nullable(timestamp),
  lastRunAt: v.nullable(timestamp),
  lastResult: v.nullable(v.string()),
});

export const ReplicationExecutionSchema = v.object({
  id: v.string(),
  ruleId: v.string(),
  status: v.picklist(["succeeded", "failed"] as const),
  repository: v.nullable(v.string()),
  reference: v.nullable(v.string()),
  manifests: v.number(),
  blobs: v.number(),
  error: v.nullable(v.string()),
  createdAt: timestamp,
});

export const QueuedReplicationSchema = v.object({ queued: v.boolean(), rule: v.string() });
export const MemberGrantSchema = v.object({
  project: v.string(),
  userId: v.string(),
  username: v.optional(v.string()),
  role,
});

/** `{ repositories: [...] }` and its siblings, which is how every list is wrapped. */
export const listOf = <const Key extends string, Item extends v.GenericSchema>(key: Key, item: Item) =>
  v.object({ [key]: v.array(item) } as { [K in Key]: v.ArraySchema<Item, undefined> });

/* -------------------------------------------------------------------------- */
/* Drift guards                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Each response schema must still describe the type the dashboard imports.
 *
 * Erased at build time, and checked at compile time: `Assert` only accepts
 * `true`, so a field renamed in `@registry/api-contract` and not here stops the
 * Worker compiling rather than quietly vanishing from the OpenAPI document.
 */
type Describes<Schema extends v.GenericSchema, Contract> =
  v.InferOutput<Schema> extends Contract ? true : false;

type Assert<Check extends true> = Check;

export type ContractChecks = [
  Assert<Describes<typeof SessionUserSchema, SessionUser>>,
  Assert<Describes<typeof AuthProvidersSchema, AuthProviders>>,
  Assert<Describes<typeof RegistryStatsSchema, RegistryStats>>,
  Assert<Describes<typeof ProjectSummarySchema, ProjectSummary>>,
  Assert<Describes<typeof ProjectDetailSchema, ProjectDetail>>,
  Assert<Describes<typeof RepositorySummarySchema, RepositorySummary>>,
  Assert<Describes<typeof RepositoryDetailSchema, RepositoryDetail>>,
  Assert<Describes<typeof TagSummarySchema, TagSummary>>,
  Assert<Describes<typeof ManifestDetailSchema, ManifestDetail>>,
  Assert<Describes<typeof AccessTokenSummarySchema, AccessTokenSummary>>,
  Assert<Describes<typeof CreatedAccessTokenSchema, CreatedAccessToken>>,
  Assert<Describes<typeof UserSummarySchema, UserSummary>>,
  Assert<Describes<typeof LifecyclePolicySchema, LifecyclePolicy>>,
  Assert<Describes<typeof AuditEventSchema, AuditEvent>>,
  Assert<Describes<typeof AuditPageSchema, AuditPage>>,
  Assert<Describes<typeof UsageStatsSchema, UsageStats>>,
  Assert<Describes<typeof CleanupPolicySchema, CleanupPolicy>>,
  Assert<Describes<typeof NotificationPolicySchema, NotificationPolicySummary>>,
  Assert<Describes<typeof NotificationDeliverySchema, NotificationDelivery>>,
  Assert<Describes<typeof ReplicationRuleSchema, ReplicationRuleSummary>>,
  Assert<Describes<typeof ReplicationExecutionSchema, ReplicationExecution>>,
];
