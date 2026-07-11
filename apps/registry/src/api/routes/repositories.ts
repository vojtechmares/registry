import type { LifecyclePolicy } from "@registry/api-contract";
import { projectOf } from "@registry/projects";
import { Hono } from "hono";
import { actorOf } from "../../audit/store.js";
import { audienceOf } from "../../visibility.js";
import { authorizeFor, principalOf, storesOf, type ApiContext, type ApiEnv } from "../context.js";
import { guard } from "../guard.js";
import { describe } from "../openapi.js";
import { forbidden, notFound } from "../problem.js";
import {
  LifecyclePolicyBody,
  LifecyclePolicySchema,
  ManifestDetailSchema,
  ManifestParam,
  RepositoryDetailSchema,
  RepositoryListQuery,
  RepositoryParam,
  RepositorySummarySchema,
  TagSummarySchema,
  UsageStatsSchema,
  WindowQuery,
  listOf,
} from "../schemas.js";
import { jsonBody, validate } from "../validate.js";

export const repositories = new Hono<ApiEnv>();

const TAGS = ["Repositories"];

/**
 * A repository name carries slashes, so it cannot be one path segment.
 *
 * The parameter is lazy - `.+?` rather than `.+` - so a fixed suffix decides the
 * route: `acme/team/svc/tags` is the tags of `acme/team/svc`, not a repository
 * called `acme/team/svc/tags`. A repository whose own last segment is `tags`
 * remains reachable at its detail route, which is the same rule the management
 * API has always applied.
 */
const NAME = ":name{.+?}";

/**
 * A repository holding immutable tags cannot be deleted out from under them.
 *
 * Deleting the repository and pushing it back is otherwise a way to move an
 * immutable tag - and this route authorizes with `delete` on the data plane, so
 * a machine token can reach it while never being able to turn immutability off,
 * which is the control plane. An empty repository has nothing to protect.
 *
 * A project owner who really means it turns the setting off first, which is a
 * control-plane change, and audited.
 */
async function refuseIfTagsAreImmutable(c: ApiContext, name: string): Promise<void> {
  const project = projectOf(name);
  const { projects, tags } = storesOf(c);

  const rules = await projects.rules(project);
  if (rules?.immutableTags !== true) return;
  if (!(await tags.hasAnyTag(name))) return;

  throw forbidden(
    `"${project}" enforces immutable tags: "${name}" still holds tags, so it cannot be deleted`,
  );
}

repositories.get(
  "/repositories",
  describe({
    summary: "List repositories",
    tags: TAGS,
    ok: {
      status: 200,
      schema: listOf("repositories", RepositorySummarySchema),
      description: "The repositories the caller may see.",
    },
    public: true,
  }),
  validate("query", RepositoryListQuery),
  async (c) => {
    const principal = principalOf(c);
    const query = c.req.valid("query");

    // The audience carries the pin, so a pinned token is confined to its project
    // by the visibility filter itself - the route restates neither rule nor pin.
    const repositoryList = await storesOf(c).repositories.listRepositories({
      search: query.search ?? null,
      project: query.project ?? null,
      limit: query.limit,
      audience: audienceOf(principal),
    });
    return c.json({ repositories: repositoryList });
  },
);

repositories.get(
  `/repositories/${NAME}/tags`,
  describe({
    summary: "List a repository's tags",
    tags: TAGS,
    ok: { status: 200, schema: listOf("tags", TagSummarySchema), description: "The tags." },
    refusals: { 403: "You may not pull this repository." },
    public: true,
  }),
  validate("param", RepositoryParam),
  async (c) => {
    const { name } = c.req.valid("param");
    await authorizeFor(c)(name, "pull");
    return c.json({ tags: await storesOf(c).repositories.tags(name) });
  },
);

repositories.get(
  `/repositories/${NAME}/manifests/:digest`,
  describe({
    summary: "Read a manifest, its blobs and its referrers",
    tags: TAGS,
    ok: { status: 200, schema: ManifestDetailSchema, description: "The manifest." },
    refusals: {
      400: "Not a valid digest.",
      403: "You may not pull this repository.",
      404: "No such manifest.",
    },
    public: true,
  }),
  validate("param", ManifestParam),
  async (c) => {
    const { name, digest } = c.req.valid("param");
    await authorizeFor(c)(name, "pull");

    const detail = await storesOf(c).repositories.manifest(name, digest);
    if (detail === null) throw notFound();
    return c.json(detail);
  },
);

repositories.get(
  `/repositories/${NAME}/policy`,
  describe({
    summary: "Read a repository's lifecycle policy",
    tags: TAGS,
    ok: { status: 200, schema: LifecyclePolicySchema, description: "The policy, or an empty disabled one." },
    refusals: { 403: "You may not pull this repository." },
    public: true,
  }),
  validate("param", RepositoryParam),
  async (c) => {
    const { name } = c.req.valid("param");
    await authorizeFor(c)(name, "pull");

    const policy = await storesOf(c).repositories.policy(name);
    return c.json(policy ?? { repository: name, enabled: false, keepLastTags: null, untaggedTtlDays: null });
  },
);

repositories.put(
  `/repositories/${NAME}/policy`,
  describe({
    summary: "Replace a repository's lifecycle policy",
    tags: TAGS,
    ok: { status: 200, schema: LifecyclePolicySchema, description: "The stored policy." },
    refusals: { 400: "Malformed policy.", 403: "You may not delete in this repository." },
  }),
  // The name has to be a repository name before it can be authorized on, so this
  // one route validates the parameter first and only then decides who may write.
  validate("param", RepositoryParam),
  guard(async (c) => void (await authorizeFor(c)(c.req.param("name") ?? "", "delete"))),
  jsonBody,
  validate("json", LifecyclePolicyBody),
  async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const policy: LifecyclePolicy = { repository: name, ...body };

    await storesOf(c).repositories.setPolicy(policy);
    return c.json(policy);
  },
);

/** Activity for one image. Gated by the right to pull it: usage is information about it. */
repositories.get(
  `/repositories/${NAME}/stats`,
  describe({
    summary: "A repository's pulls, pushes and storage",
    tags: TAGS,
    ok: { status: 200, schema: UsageStatsSchema, description: "Usage for this image alone." },
    refusals: { 403: "You may not pull this repository." },
    public: true,
  }),
  validate("param", RepositoryParam),
  validate("query", WindowQuery),
  async (c) => {
    const { name } = c.req.valid("param");
    await authorizeFor(c)(name, "pull");
    return c.json(await storesOf(c).stats.forRepository(name, c.req.valid("query").days));
  },
);

repositories.get(
  `/repositories/${NAME}`,
  describe({
    summary: "Read a repository",
    tags: TAGS,
    ok: { status: 200, schema: RepositoryDetailSchema, description: "The repository and its tags." },
    refusals: {
      400: "Not a valid repository name.",
      403: "You may not pull this repository.",
      404: "No such repository.",
    },
    public: true,
  }),
  validate("param", RepositoryParam),
  async (c) => {
    const { name } = c.req.valid("param");
    await authorizeFor(c)(name, "pull");

    const detail = await storesOf(c).repositories.repository(name);
    if (detail === null) throw notFound(`repository "${name}" does not exist`);
    return c.json(detail);
  },
);

repositories.delete(
  `/repositories/${NAME}`,
  describe({
    summary: "Delete a repository",
    description: "Refused while the project enforces immutable tags and the repository still holds any.",
    tags: TAGS,
    ok: { status: 204, schema: null, description: "Deleted." },
    refusals: {
      403: "You may not delete in this repository, or its project enforces immutable tags.",
      404: "No such repository.",
    },
  }),
  validate("param", RepositoryParam),
  async (c) => {
    const principal = principalOf(c);
    const { name } = c.req.valid("param");

    await authorizeFor(c)(name, "delete");
    await refuseIfTagsAreImmutable(c, name);

    const { repositories: repositoryStore, audit } = storesOf(c);
    if (!(await repositoryStore.deleteRepository(name))) throw notFound();

    await audit.record({
      actor: actorOf(principal),
      action: "repository.delete",
      resourceType: "repository",
      resource: name,
      project: projectOf(name),
    });

    return c.body(null, 204);
  },
);
