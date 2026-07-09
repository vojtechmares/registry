import { describe, expect, it } from "vitest";
import { MAX_PROJECT_NAME_LENGTH, isValidProjectName, projectOf, splitRepository } from "./name.js";

describe("projectOf", () => {
  it("takes the first path segment", () => {
    expect(projectOf("myorg/myrepo")).toBe("myorg");
    expect(projectOf("myorg/nested/deeply/repo")).toBe("myorg");
  });

  it("treats a single-segment name as its own project", () => {
    expect(projectOf("alpine")).toBe("alpine");
  });

  it("never returns a segment containing a slash", () => {
    expect(projectOf("a/b")).not.toContain("/");
  });
});

describe("splitRepository", () => {
  it("separates the project from the rest of the path", () => {
    expect(splitRepository("myorg/myrepo")).toEqual({ project: "myorg", path: "myrepo" });
    expect(splitRepository("myorg/team/service")).toEqual({ project: "myorg", path: "team/service" });
  });

  it("rejects a name with no project segment", () => {
    expect(splitRepository("alpine")).toBeNull();
  });

  it("rejects a name whose project segment is empty", () => {
    expect(splitRepository("/repo")).toBeNull();
  });

  it("rejects a name whose remainder is empty", () => {
    expect(splitRepository("myorg/")).toBeNull();
  });

  it("rejects a project segment that is not a valid project name", () => {
    // `_private` is a legal path component nowhere in the OCI grammar.
    expect(splitRepository("_private/repo")).toBeNull();
  });
});

describe("isValidProjectName", () => {
  it("accepts a lowercase OCI path component", () => {
    expect(isValidProjectName("myorg")).toBe(true);
    expect(isValidProjectName("my-org")).toBe(true);
    expect(isValidProjectName("my.org")).toBe(true);
    expect(isValidProjectName("my_org")).toBe(true);
    expect(isValidProjectName("org123")).toBe(true);
  });

  it("rejects a name that is not a single path component", () => {
    expect(isValidProjectName("my/org")).toBe(false);
  });

  it("rejects uppercase, which no registry client will round-trip", () => {
    expect(isValidProjectName("MyOrg")).toBe(false);
  });

  it("rejects leading or trailing separators", () => {
    expect(isValidProjectName("-org")).toBe(false);
    expect(isValidProjectName("org-")).toBe(false);
    expect(isValidProjectName(".org")).toBe(false);
    expect(isValidProjectName("_org")).toBe(false);
  });

  it("rejects the empty name and one that is too long", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME_LENGTH))).toBe(true);
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME_LENGTH + 1))).toBe(false);
  });

  it("rejects a name that would shadow a registry endpoint", () => {
    expect(isValidProjectName("v2")).toBe(false);
    expect(isValidProjectName("api")).toBe(false);
  });
});
