import { Hono } from "hono";
import { actorOf } from "../../audit/store.js";
import { hashPassword } from "../../auth/password.js";
import { principalOf, storesOf, type ApiContext, type ApiEnv } from "../context.js";
import { adminOnly, guard, requireAdmin, requireUser } from "../guard.js";
import { describe } from "../openapi.js";
import { badRequest, conflict, forbidden, notFound } from "../problem.js";
import { CreateUserBody, IdParam, UpdateUserBody, UserSummarySchema, listOf } from "../schemas.js";
import { jsonBody, validate } from "../validate.js";

export const users = new Hono<ApiEnv>();

const TAGS = ["Users"];

/**
 * A valid address that no other account holds.
 *
 * `owner` is the account the address is being assigned to, so that saving a
 * user without changing their email is not a conflict with themselves. The
 * check races the unique index, which is the thing that actually decides;
 * losing the race gives a 500 rather than a 409, and no duplicate.
 */
async function requireFreeEmail(c: ApiContext, email: string, owner: string | null): Promise<string> {
  const holder = await storesOf(c).users.findUserIdByEmail(email);
  if (holder !== null && holder !== owner) throw conflict(`"${email}" is already in use`);
  return email;
}

users.get(
  "/users",
  describe({
    summary: "List every account",
    tags: TAGS,
    ok: { status: 200, schema: listOf("users", UserSummarySchema), description: "Every account." },
    refusals: { 403: "Administrator privileges are required." },
  }),
  adminOnly,
  async (c) => c.json({ users: await storesOf(c).users.listUsers() }),
);

users.post(
  "/users",
  describe({
    summary: "Create an account",
    tags: TAGS,
    ok: { status: 201, schema: UserSummarySchema, description: "The account that was created." },
    refusals: {
      400: "Malformed body.",
      403: "Administrator privileges are required.",
      409: "The username or email address is taken.",
    },
  }),
  adminOnly,
  jsonBody,
  validate("json", CreateUserBody),
  async (c) => {
    const principal = principalOf(c);
    const body = c.req.valid("json");
    const { auth, users: userStore, audit } = storesOf(c);

    const email = await requireFreeEmail(c, body.email, null);
    if ((await auth.findUserByUsername(body.username)) !== null) {
      throw conflict(`user "${body.username}" already exists`);
    }

    const user = await userStore.createUser({
      id: crypto.randomUUID(),
      username: body.username,
      email,
      passwordHash: await hashPassword(body.password),
      isAdmin: body.isAdmin,
    });

    await audit.record({
      actor: actorOf(principal),
      action: "user.create",
      resourceType: "user",
      resource: user.id,
      detail: { username: user.username, email: user.email, isAdmin: user.isAdmin },
    });

    return c.json(user, 201);
  },
);

/** An administrator may change any address; anyone else may change only their own. */
users.patch(
  "/users/:id",
  describe({
    summary: "Change an account's email address",
    tags: TAGS,
    ok: { status: 200, schema: UserSummarySchema, description: "The account as it now stands." },
    refusals: {
      400: "Malformed body.",
      403: "You may only change your own email address.",
      404: "No such account.",
      409: "The address is already in use.",
    },
  }),
  // Ahead of the body: a caller who may not change this address must not be told
  // what a valid one looks like.
  guard((c) => {
    const identity = requireUser(principalOf(c));
    if (!identity.isAdmin && identity.id !== c.req.param("id")) {
      throw forbidden("you may only change your own email address");
    }
  }),
  jsonBody,
  validate("param", IdParam),
  validate("json", UpdateUserBody),
  async (c) => {
    const principal = principalOf(c);
    const { id } = c.req.valid("param");

    const { users: userStore, audit } = storesOf(c);
    const email = await requireFreeEmail(c, c.req.valid("json").email, id);

    const user = await userStore.setUserEmail(id, email);
    if (user === null) throw notFound(`user "${id}" does not exist`);

    await audit.record({
      actor: actorOf(principal),
      action: "user.update",
      resourceType: "user",
      resource: id,
      detail: { username: user.username, email },
    });

    return c.json(user);
  },
);

users.delete(
  "/users/:id",
  describe({
    summary: "Delete an account",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "The account is gone; the audit rows naming it remain." },
    refusals: {
      400: "You cannot delete your own account, nor the bootstrap administrator.",
      403: "Administrator privileges are required.",
      404: "No such account.",
    },
  }),
  adminOnly,
  validate("param", IdParam),
  async (c) => {
    const principal = principalOf(c);
    const identity = requireAdmin(principal);
    const { id } = c.req.valid("param");

    if (identity.id === id) throw badRequest("you cannot delete your own account");
    if (id === "bootstrap") throw badRequest("the bootstrap administrator cannot be deleted");

    const { auth, users: userStore, audit } = storesOf(c);

    // Read before the delete, so the row can name whom it was. There is no
    // foreign key from `audit_events` to `users`, precisely so this survives.
    const doomed = await auth.findUserById(id);
    if (!(await userStore.deleteUser(id))) throw notFound();

    await audit.record({
      actor: actorOf(principal),
      action: "user.delete",
      resourceType: "user",
      resource: id,
      detail: { username: doomed?.username ?? null },
    });

    return c.body(null, 204);
  },
);
