import { Hono } from "hono";
import { authenticateCredentials } from "../../auth/principal.js";
import {
  OidcError,
  completeFlow,
  flowCookie,
  isAdminByGroups,
  readOidcConfig,
  safeNext,
  startFlow,
  usernameFor,
} from "../../auth/oidc.js";
import { clearSessionCookie, createSessionCookie } from "../../auth/session.js";
import { configOf, principalOf, storesOf, type ApiEnv } from "../context.js";
import { normalizeEmail } from "../email.js";
import { requireIdentity, requireUser } from "../guard.js";
import { describe } from "../openapi.js";
import { notFound } from "../problem.js";
import { AuthProvidersSchema, LoginBody, SessionUserSchema } from "../schemas.js";
import { jsonBody, validate } from "../validate.js";

export const auth = new Hono<ApiEnv>();

const TAGS = ["Authentication"];

auth.post(
  "/auth/login",
  describe({
    summary: "Sign in with a username and password",
    description:
      "Returns the session cookie the dashboard uses. A machine token presented as the password is refused: " +
      "the cookie would resolve back as an unconfined user and strip the token's scopes.",
    tags: TAGS,
    ok: { status: 200, schema: SessionUserSchema, description: "Signed in. The session cookie is set." },
    refusals: { 400: "Malformed body.", 401: "Invalid credentials.", 403: "Not a human account." },
    public: true,
  }),
  jsonBody,
  validate("json", LoginBody),
  async (c) => {
    const { username, password } = c.req.valid("json");
    const { auth: store, users } = storesOf(c);
    const config = configOf(c);

    const principal = await authenticateCredentials(username, password, store, config);
    // A machine token authenticates through the same credential path (it may be
    // passed as the password), but it must never be exchanged for a session
    // cookie: the cookie resolves back as a `user` principal, which would strip
    // the token's scope confinement and hand it the full control plane.
    // Rejecting non-user principals here is what keeps `requireUser` on the
    // other routes meaningful.
    const identity = requireUser(principal);

    // Give the bootstrap administrator a real row so it can own access tokens.
    if (identity.id === "bootstrap") await users.ensureBootstrapUser(identity.username);

    return c.json({ id: identity.id, username: identity.username, isAdmin: identity.isAdmin }, 200, {
      "Set-Cookie": await createSessionCookie(identity, config, c.get("secure")),
    });
  },
);

auth.post(
  "/auth/logout",
  describe({
    summary: "Sign out",
    description:
      "Clears the session cookie. A JSON content type is required, so no cross-site form can do it.",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Signed out." },
    refusals: { 400: "Not a JSON request." },
    public: true,
  }),
  // No body is read, so no validator: a `POST` with a JSON content type and no
  // body at all is what the dashboard sends, and Hono's parser would refuse it.
  jsonBody,
  (c) => c.body(null, 204, { "Set-Cookie": clearSessionCookie(c.get("secure")) }),
);

auth.get(
  "/auth/session",
  describe({
    summary: "Who the caller is",
    tags: TAGS,
    ok: { status: 200, schema: SessionUserSchema, description: "The signed-in user." },
  }),
  (c) => {
    const identity = requireIdentity(principalOf(c));
    return c.json({ id: identity.id, username: identity.username, isAdmin: identity.isAdmin });
  },
);

auth.get(
  "/auth/providers",
  describe({
    summary: "What the sign-in page should offer",
    description: "Unauthenticated: it is asked before anyone is signed in.",
    tags: TAGS,
    ok: { status: 200, schema: AuthProvidersSchema, description: "The configured sign-in methods." },
    public: true,
  }),
  (c) => c.json({ password: true, oidc: readOidcConfig(c.env, new URL(c.req.url)) !== null }),
);

/**
 * Sends the browser to the identity provider.
 *
 * A redirect rather than a JSON body carrying a URL, so the flow works from a
 * plain link and needs no script.
 */
auth.get(
  "/auth/oidc/start",
  describe({
    summary: "Begin single sign-on",
    tags: TAGS,
    ok: { status: 302, schema: null, description: "Redirects to the identity provider." },
    refusals: { 404: "Single sign-on is not configured." },
    public: true,
  }),
  async (c) => {
    const config = readOidcConfig(c.env, new URL(c.req.url));
    if (config === null) throw notFound("single sign-on is not configured");

    const secure = c.get("secure");
    const flow = await startFlow(config, configOf(c), safeNext(c.req.query("next") ?? null), secure);

    return new Response(null, {
      status: 302,
      headers: { Location: flow.authorizeUrl, "Set-Cookie": flow.cookie, "Cache-Control": "no-store" },
    });
  },
);

/**
 * Where the provider sends the browser back.
 *
 * On success the flow cookie is cleared and a session cookie takes its place;
 * on failure the browser lands back on the sign-in page with a message, because
 * a JSON error body is not something a person who just clicked "Sign in" can do
 * anything with.
 */
auth.get(
  "/auth/oidc/callback",
  describe({
    summary: "Finish single sign-on",
    tags: TAGS,
    ok: { status: 302, schema: null, description: "Redirects onward, with a session cookie set." },
    refusals: { 404: "Single sign-on is not configured." },
    public: true,
  }),
  async (c) => {
    const oidc = readOidcConfig(c.env, new URL(c.req.url));
    if (oidc === null) throw notFound("single sign-on is not configured");

    const config = configOf(c);
    const secure = c.get("secure");

    let claims;
    let next: string;
    try {
      ({ claims, next } = await completeFlow(oidc, config, c.req.raw));
    } catch (error) {
      if (!(error instanceof OidcError)) throw error;
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/login?error=${encodeURIComponent(error.message)}`,
          "Set-Cookie": flowCookie("", secure, 0),
          "Cache-Control": "no-store",
        },
      });
    }

    const user = await storesOf(c).users.findOrCreateOidcUser({
      issuer: claims.iss,
      subject: claims.sub,
      username: usernameFor(claims),
      // Normalised on the way in, or the unique index over `users.email` would
      // let a provider's `Alice@` sit beside a local `alice@`.
      email: normalizeEmail(claims.email),
      isAdmin: isAdminByGroups(claims, oidc),
    });

    if (user.disabled) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/login?error=account+disabled", "Set-Cookie": flowCookie("", secure, 0) },
      });
    }

    const identity = { id: user.id, username: user.username, isAdmin: user.isAdmin };
    const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
    headers.append("Set-Cookie", flowCookie("", secure, 0));
    headers.append("Set-Cookie", await createSessionCookie(identity, config, secure));

    return new Response(null, { status: 302, headers });
  },
);
