import { Hono } from "hono";
import { storesOf, type ApiEnv } from "../context.js";
import { adminOnly } from "../guard.js";
import { describe } from "../openapi.js";
import { AuditPageSchema, AuditQuery, RegistryStatsSchema } from "../schemas.js";
import { validate } from "../validate.js";

export const insights = new Hono<ApiEnv>();

insights.get(
  "/stats",
  describe({
    summary: "Registry-wide totals",
    description:
      "`logicalBytes - referencedBytes` is what deduplication saves; `reclaimableBytes` is what the next " +
      "garbage collection will free.",
    tags: ["Registry"],
    ok: { status: 200, schema: RegistryStatsSchema, description: "The totals." },
    refusals: { 403: "Administrator privileges are required." },
  }),
  adminOnly,
  async (c) => c.json(await storesOf(c).repositories.stats()),
);

/**
 * `GET /audit` - who changed what.
 *
 * Administrators only. The log spans every project, and a project owner who
 * could read it would learn the names of repositories in projects they cannot
 * see. Scoping a per-project view is a larger change than the audit itself.
 */
insights.get(
  "/audit",
  describe({
    summary: "Who changed what",
    description:
      "Pulls are not recorded: one `docker pull` reaches the manifest endpoint many times, and the usage " +
      "counters already know about them. Pushes and deletes are. `cursor` is opaque; pass it back for the next page.",
    tags: ["Registry"],
    ok: { status: 200, schema: AuditPageSchema, description: "A page of events, newest first." },
    refusals: { 400: "Not an audited resource type.", 403: "Administrator privileges are required." },
  }),
  // Ahead of the query validator. `resourceType` is a closed set, so a caller
  // who may not read the log at all would otherwise learn it by watching a bad
  // value answer 400 where a good one answers 403.
  adminOnly,
  validate("query", AuditQuery),
  async (c) => c.json(await storesOf(c).audit.list(c.req.valid("query"))),
);
