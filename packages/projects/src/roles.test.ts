import { describe, expect, it } from "vitest";
import { ROLES, canAdminister, isRole, roleAllows, roleRank } from "./roles.js";

describe("roleAllows", () => {
  it("gives a guest read access and nothing else", () => {
    expect(roleAllows("guest", "pull")).toBe(true);
    expect(roleAllows("guest", "push")).toBe(false);
    expect(roleAllows("guest", "delete")).toBe(false);
  });

  it("lets a developer push but not delete", () => {
    expect(roleAllows("developer", "pull")).toBe(true);
    expect(roleAllows("developer", "push")).toBe(true);
    expect(roleAllows("developer", "delete")).toBe(false);
  });

  it("lets a maintainer delete", () => {
    expect(roleAllows("maintainer", "delete")).toBe(true);
  });

  it("gives an owner every action", () => {
    expect(roleAllows("owner", "pull")).toBe(true);
    expect(roleAllows("owner", "push")).toBe(true);
    expect(roleAllows("owner", "delete")).toBe(true);
  });

  it("is monotonic: a higher role never loses an action", () => {
    for (const action of ["pull", "push", "delete"] as const) {
      const allowed = ROLES.map((role) => roleAllows(role, action));
      const firstYes = allowed.indexOf(true);
      if (firstYes === -1) continue;
      expect(allowed.slice(firstYes).every(Boolean)).toBe(true);
    }
  });
});

describe("canAdminister", () => {
  it("is reserved for owners", () => {
    expect(canAdminister("owner")).toBe(true);
    expect(canAdminister("maintainer")).toBe(false);
    expect(canAdminister("developer")).toBe(false);
    expect(canAdminister("guest")).toBe(false);
  });
});

describe("roleRank", () => {
  it("orders roles from least to most privileged", () => {
    expect(roleRank("guest")).toBeLessThan(roleRank("developer"));
    expect(roleRank("developer")).toBeLessThan(roleRank("maintainer"));
    expect(roleRank("maintainer")).toBeLessThan(roleRank("owner"));
  });
});

describe("isRole", () => {
  it("accepts exactly the four roles", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole("")).toBe(false);
  });
});
