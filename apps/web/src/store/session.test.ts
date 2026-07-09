import { beforeEach, describe, expect, it } from "vitest";
import { beginSessionLoad, isAdmin, sessionStore, setSessionUser } from "./session";

const admin = { id: "1", username: "root", isAdmin: true };
const member = { id: "2", username: "alice", isAdmin: false };

beforeEach(() => {
  sessionStore.setState(() => ({ user: null, loading: true }));
});

describe("sessionStore", () => {
  it("starts loading with nobody signed in", () => {
    expect(sessionStore.state).toEqual({ user: null, loading: true });
  });

  it("stops loading once a user is known, even an absent one", () => {
    setSessionUser(null);
    expect(sessionStore.state).toEqual({ user: null, loading: false });

    setSessionUser(member);
    expect(sessionStore.state).toEqual({ user: member, loading: false });
  });

  it("notifies subscribers", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = sessionStore.subscribe(() => seen.push(sessionStore.state.user?.username ?? null));

    setSessionUser(member);
    setSessionUser(null);
    unsubscribe();
    setSessionUser(admin);

    expect(seen).toEqual(["alice", null]);
  });

  it("re-enters the loading state without discarding the current user", () => {
    setSessionUser(member);
    beginSessionLoad();
    expect(sessionStore.state).toEqual({ user: member, loading: true });
  });
});

describe("isAdmin", () => {
  it("is false for anonymous and for ordinary users", () => {
    expect(isAdmin({ user: null, loading: false })).toBe(false);
    expect(isAdmin({ user: member, loading: false })).toBe(false);
    expect(isAdmin({ user: admin, loading: false })).toBe(true);
  });
});
