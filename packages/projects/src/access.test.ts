import { describe, expect, it } from "vitest";
import { type AccessPrincipal, type ProjectAccess, decideAccess } from "./access.js";
import type { Action } from "./roles.js";

const anonymous: AccessPrincipal = { kind: "anonymous" };
const alice: AccessPrincipal = { kind: "user", username: "alice", isAdmin: false };
const root: AccessPrincipal = { kind: "user", username: "root", isAdmin: true };

function token(overrides: Partial<Extract<AccessPrincipal, { kind: "token" }>> = {}): AccessPrincipal {
  return {
    kind: "token",
    username: "alice",
    isAdmin: false,
    scopes: [{ repository: "*", actions: ["pull", "push", "delete"] }],
    project: null,
    ...overrides,
  };
}

function project(overrides: Partial<ProjectAccess> = {}): ProjectAccess {
  return { name: "acme", visibility: "private", role: null, ...overrides };
}

function decide(
  principal: AccessPrincipal,
  action: Action,
  proj: ProjectAccess | null,
  repository = "acme/api",
  allowAnonymousPull = true,
) {
  return decideAccess({ repository, action, principal, project: proj, allowAnonymousPull });
}

describe("anonymous callers", () => {
  it("may pull from a public project", () => {
    expect(decide(anonymous, "pull", project({ visibility: "public" })).kind).toBe("allow");
  });

  it("is challenged, not denied, on a private project", () => {
    // 401 tells the client to come back with credentials; 403 tells it to give up.
    expect(decide(anonymous, "pull", project()).kind).toBe("challenge");
  });

  it("is challenged for a project that does not exist, which discloses nothing", () => {
    expect(decide(anonymous, "pull", null).kind).toBe("challenge");
  });

  it("may never push, even to a public project", () => {
    expect(decide(anonymous, "push", project({ visibility: "public" })).kind).toBe("challenge");
  });

  it("is challenged on a public project when anonymous pull is disabled", () => {
    expect(decide(anonymous, "pull", project({ visibility: "public" }), "acme/api", false).kind).toBe(
      "challenge",
    );
  });
});

describe("administrators", () => {
  it("may do anything in any project", () => {
    for (const action of ["pull", "push", "delete"] as const) {
      expect(decide(root, action, project()).kind).toBe("allow");
    }
  });

  it("may push into a project that does not exist yet, creating it", () => {
    expect(decide(root, "push", null).kind).toBe("allow");
  });
});

describe("project members", () => {
  it("a guest may pull and nothing else", () => {
    expect(decide(alice, "pull", project({ role: "guest" })).kind).toBe("allow");
    expect(decide(alice, "push", project({ role: "guest" })).kind).toBe("deny");
  });

  it("a developer may push", () => {
    expect(decide(alice, "push", project({ role: "developer" })).kind).toBe("allow");
    expect(decide(alice, "delete", project({ role: "developer" })).kind).toBe("deny");
  });

  it("a maintainer may delete", () => {
    expect(decide(alice, "delete", project({ role: "maintainer" })).kind).toBe("allow");
  });
});

describe("non-members", () => {
  it("may pull a public project", () => {
    expect(decide(alice, "pull", project({ visibility: "public" })).kind).toBe("allow");
  });

  it("may not push to a public project", () => {
    expect(decide(alice, "push", project({ visibility: "public" })).kind).toBe("deny");
  });

  it("is denied, not challenged, on a private project", () => {
    // The caller proved who they are; asking again would loop.
    expect(decide(alice, "pull", project()).kind).toBe("deny");
  });
});

describe("personal projects", () => {
  it("a user implicitly owns the project named after them", () => {
    const personal = project({ name: "alice", role: null });
    expect(decide(alice, "push", personal, "alice/tools").kind).toBe("allow");
    expect(decide(alice, "delete", personal, "alice/tools").kind).toBe("allow");
  });

  it("and may create it by pushing to it", () => {
    expect(decide(alice, "push", null, "alice/tools").kind).toBe("allow");
  });

  it("but may not create someone else's", () => {
    expect(decide(alice, "push", null, "bob/tools").kind).toBe("deny");
  });

  it("and the implicit ownership does not leak across a name prefix", () => {
    expect(decide(alice, "push", null, "alicebob/tools").kind).toBe("deny");
  });
});

describe("machine tokens", () => {
  it("act as their owner within their scopes", () => {
    expect(decide(token(), "push", project({ role: "developer" })).kind).toBe("allow");
  });

  it("are confined by their scopes even when their owner holds more", () => {
    const readOnly = token({ scopes: [{ repository: "*", actions: ["pull"] }] });
    expect(decide(readOnly, "pull", project({ role: "owner" })).kind).toBe("allow");
    expect(decide(readOnly, "push", project({ role: "owner" })).kind).toBe("deny");
  });

  it("are confined by their scopes even when their owner is an administrator", () => {
    const readOnly = token({ isAdmin: true, scopes: [{ repository: "*", actions: ["pull"] }] });
    expect(decide(readOnly, "push", project({ role: null })).kind).toBe("deny");
  });

  it("cannot reach outside the project they are scoped to", () => {
    const scoped = token({ project: "acme", isAdmin: true });
    expect(decide(scoped, "push", project({ name: "acme" }), "acme/api").kind).toBe("allow");
    expect(decide(scoped, "push", project({ name: "other" }), "other/api").kind).toBe("deny");
  });

  it("cannot escape their project through a wildcard scope", () => {
    const scoped = token({
      project: "acme",
      scopes: [{ repository: "*", actions: ["pull"] }],
      isAdmin: true,
    });
    expect(decide(scoped, "pull", project({ name: "other", visibility: "public" }), "other/api").kind).toBe(
      "deny",
    );
  });

  it("cannot escape their project through a prefix that merely looks like it", () => {
    const scoped = token({ project: "acme", isAdmin: true });
    expect(decide(scoped, "pull", project({ name: "acme-evil" }), "acme-evil/api").kind).toBe("deny");
  });

  it("are denied rather than challenged: a token cannot be re-presented as something better", () => {
    const readOnly = token({ scopes: [{ repository: "*", actions: ["pull"] }] });
    expect(decide(readOnly, "push", project()).kind).toBe("deny");
  });
});
