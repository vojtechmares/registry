import type { SessionUser } from "@registry/api-contract";
import { Store } from "@tanstack/store";

/**
 * Who is signed in.
 *
 * The session itself lives in an `HttpOnly` cookie that this code cannot read,
 * so the store holds only what the server told us about the current user. It is
 * a cache of an answer, never the credential.
 */
export interface SessionState {
  readonly user: SessionUser | null;
  /** True until the first `/auth/session` probe resolves, so the shell can wait. */
  readonly loading: boolean;
}

export const sessionStore = new Store<SessionState>({ user: null, loading: true });

export function setSessionUser(user: SessionUser | null): void {
  sessionStore.setState(() => ({ user, loading: false }));
}

export function beginSessionLoad(): void {
  sessionStore.setState((state) => ({ ...state, loading: true }));
}

export function isAdmin(state: SessionState): boolean {
  return state.user?.isAdmin === true;
}

/**
 * Resolves once the registry has told us who, if anyone, is signed in.
 *
 * A route guard that merely reads `sessionStore` runs before the first probe
 * returns, sees `loading: true`, and waves the visitor through. Guards await
 * this instead. The API is the real gate; this only stops an anonymous visitor
 * being shown a page they cannot use.
 */
let resolveReady: () => void;
export const sessionReady: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

export function loadSession(fetchSession: () => Promise<SessionUser>): Promise<void> {
  beginSessionLoad();
  return fetchSession()
    .then(setSessionUser)
    .catch(() => setSessionUser(null))
    .finally(() => resolveReady());
}
