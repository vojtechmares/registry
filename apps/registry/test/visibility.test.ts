/**
 * The visibility module's two faces - the SQL filter that pages listing queries
 * and the predicate that gates an already-fetched row - must select exactly the
 * same projects. A private name one selects while the other hides is a
 * disclosure leak, so this sweeps viewer x visibility x membership x pin and
 * asserts, against real D1, that the two agree row for row.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@registry/projects";
import { type Audience, isVisible, visibleProjectsFilter } from "../src/visibility.js";
import { seedMember, seedProject, seedUser } from "./helpers.js";

const ALICE = { id: "vis-alice-id", username: "vis-alice" };
const ADMIN = { id: "vis-admin-id", username: "vis-admin" };

/** A fixture set touching every branch: public, private, membership, namesake. */
const PROJECTS: ReadonlyArray<{
  name: string;
  visibility: "public" | "private";
  member: Role | null;
}> = [
  { name: "vis-pub", visibility: "public", member: null },
  { name: "vis-priv", visibility: "private", member: null },
  { name: "vis-mem-priv", visibility: "private", member: "owner" },
  { name: "vis-mem-pub", visibility: "public", member: "developer" },
  // Named after Alice, who is not a member: the personal-namespace branch alone.
  { name: "vis-alice", visibility: "private", member: null },
  { name: "vis-other", visibility: "private", member: null },
];

beforeAll(async () => {
  await seedUser({ ...ALICE, password: "correct-horse-battery" });
  await seedUser({ ...ADMIN, password: "correct-horse-battery", isAdmin: true });
  for (const project of PROJECTS) {
    await seedProject({ name: project.name, visibility: project.visibility });
    if (project.member !== null) await seedMember(project.name, ALICE.id, project.member);
  }
});

const alice = { id: ALICE.id, username: ALICE.username, isAdmin: false };
const admin = { id: ADMIN.id, username: ADMIN.username, isAdmin: true };

const AUDIENCES: ReadonlyArray<{ label: string; audience: Audience }> = [
  { label: "an anonymous caller", audience: { viewer: null, pin: null } },
  { label: "a member and namesake, unpinned", audience: { viewer: alice, pin: null } },
  { label: "an administrator, unpinned", audience: { viewer: admin, pin: null } },
  { label: "a member pinned to a project they can see", audience: { viewer: alice, pin: "vis-mem-priv" } },
  { label: "a member pinned to a project they cannot see", audience: { viewer: alice, pin: "vis-priv" } },
  { label: "a member pinned to their personal namespace", audience: { viewer: alice, pin: "vis-alice" } },
  { label: "an administrator pinned to one project", audience: { viewer: admin, pin: "vis-priv" } },
  { label: "an anonymous caller pinned to a public project", audience: { viewer: null, pin: "vis-pub" } },
];

/** Only this test's fixtures, so a project seeded by another test cannot skew the comparison. */
const mine = (names: string[]): string[] => names.filter((name) => name.startsWith("vis-"));

async function selectedBySqlFilter(audience: Audience): Promise<string[]> {
  const filter = visibleProjectsFilter(audience, "p");
  const where = filter === null ? "" : `WHERE ${filter.sql}`;
  const rows = await env.DB.prepare(`SELECT p.name FROM projects AS p ${where} ORDER BY p.name ASC`)
    .bind(...(filter?.bindings ?? []))
    .all<{ name: string }>();
  return mine(rows.results.map((row) => row.name));
}

async function selectedByPredicate(audience: Audience): Promise<string[]> {
  const all = await env.DB.prepare("SELECT name, visibility FROM projects ORDER BY name ASC").all<{
    name: string;
    visibility: "public" | "private";
  }>();
  const visible: string[] = [];
  for (const row of all.results) {
    const role =
      audience.viewer === null
        ? null
        : ((
            await env.DB.prepare("SELECT role FROM project_members WHERE project = ? AND user_id = ?")
              .bind(row.name, audience.viewer.id)
              .first<{ role: Role }>()
          )?.role ?? null);
    if (isVisible(audience, { name: row.name, visibility: row.visibility, role })) visible.push(row.name);
  }
  return mine(visible);
}

describe("the visibility filter and predicate agree", () => {
  for (const { label, audience } of AUDIENCES) {
    it(`selects identical projects for ${label}`, async () => {
      const bySql = await selectedBySqlFilter(audience);
      const byPredicate = await selectedByPredicate(audience);
      expect(bySql).toEqual(byPredicate);
    });
  }

  // Guards the sweep against both faces vacuously "agreeing" by selecting
  // nothing: at least one audience must see the whole fixture set.
  it("selects every project for an unpinned administrator", async () => {
    const bySql = await selectedBySqlFilter({ viewer: admin, pin: null });
    expect(bySql.length).toBe(PROJECTS.length);
  });
});
