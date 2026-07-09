/**
 * What a member of a project may do inside it.
 *
 * Four roles, ordered. Each one holds every action the role below it holds,
 * which is what lets a comparison of ranks stand in for a comparison of
 * capabilities anywhere a "at least this privileged" question is asked.
 */

export type Action = "pull" | "push" | "delete";

export const ROLES = ["guest", "developer", "maintainer", "owner"] as const;
export type Role = (typeof ROLES)[number];

const ACTIONS: Record<Role, readonly Action[]> = {
  guest: ["pull"],
  developer: ["pull", "push"],
  maintainer: ["pull", "push", "delete"],
  owner: ["pull", "push", "delete"],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export function roleAllows(role: Role, action: Action): boolean {
  return ACTIONS[role].includes(action);
}

export function actionsOf(role: Role): readonly Action[] {
  return ACTIONS[role];
}

/**
 * Whether the role may change the project itself: its members, quota,
 * visibility, rules, and the rules' schedules.
 *
 * A maintainer can delete an artifact but cannot, say, turn off the rule that
 * requires artifacts to be signed. Separating the two means the strongest
 * guarantee a project makes is not revocable by everyone who can delete a tag.
 */
export function canAdminister(role: Role): boolean {
  return role === "owner";
}
