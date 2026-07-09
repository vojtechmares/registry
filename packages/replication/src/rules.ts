import { type TagFilter, matchesTagFilter } from "@registry/semver";

/**
 * `push` sends this project's artifacts to a downstream registry.
 * `pull` subscribes to another registry - Docker Hub, say - and copies from it.
 */
export type Direction = "push" | "pull";

/** `event` fires on every push; `scheduled` on a cron; `manual` only when asked. */
export type Trigger = "manual" | "event" | "scheduled";

export interface ReplicationRule {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly direction: Direction;
  /** The far registry's base URL. */
  readonly remoteUrl: string;
  /** Prepended to a repository name at the destination. */
  readonly destinationNamespace: string;
  /**
   * For `push`, a glob over this project's repository names. For `pull`, the
   * explicit list of remote repositories to subscribe to - a remote catalog is
   * rarely listable, and guessing at it is worse than being told.
   */
  readonly repositoryFilter: string;
  readonly sourceRepositories: readonly string[];
  readonly tagFilter: TagFilter;
  readonly trigger: Trigger;
  /** A cron expression, when the trigger is `scheduled`. */
  readonly schedule: string | null;
}

/** Anchored glob, with regular-expression metacharacters taken literally. */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === "") return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "[\\s\\S]*" : `\\${char}`,
  );
  return new RegExp(`^${escaped}$`).test(value);
}

export function ruleMatchesRepository(rule: ReplicationRule, repository: string): boolean {
  return globMatches(rule.repositoryFilter, repository);
}

export function ruleMatchesTag(rule: ReplicationRule, tag: string): boolean {
  return matchesTagFilter(tag, rule.tagFilter);
}

/**
 * The rules a push should set off.
 *
 * Only `push` rules with an `event` trigger, and only for repositories they
 * name. A `pull` rule is a subscription to somebody else's registry; nothing
 * that happens here should make it run.
 */
export function rulesTriggeredByPush(
  rules: readonly ReplicationRule[],
  repository: string,
  tag: string | null,
): ReplicationRule[] {
  if (tag === null) return [];
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.direction === "push" &&
      rule.trigger === "event" &&
      ruleMatchesRepository(rule, repository) &&
      ruleMatchesTag(rule, tag),
  );
}
