/**
 * The core conformance suite against the real D1/R2/Durable Object adapters.
 *
 * The very definition the in-memory suite runs (`@registry/registry-core`'s
 * `conformanceSuite`) runs here against the production ports inside the workerd
 * test pool, so an adapter that diverges from the port contract - dedup winner
 * and loser cleanup, link-returns-false after collection, tag pagination - fails
 * CI here rather than only in the deployed Go suite. Config comes from the same
 * `DEFAULT_CONFIG` the in-memory suite uses, so only the adapters differ.
 *
 * The custom-part-size capability is off: the Durable Object fixes its part
 * size, so the R2-part-boundary reassembly test runs on the in-memory adapters.
 */

import { env } from "cloudflare:test";
import { DEFAULT_CONFIG } from "@registry/registry-core";
import { conformanceSuite, type MakeRegistry } from "@registry/registry-core/conformance";
import { R2ContentStore } from "../src/storage/content.js";
import { D1MetadataStore } from "../src/storage/metadata.js";
import { DurableObjectUploadStore } from "../src/storage/uploads.js";

const makeRealRegistry: MakeRegistry = (overrides = {}, options = {}) => ({
  metadata: new D1MetadataStore(env.DB),
  content: new R2ContentStore(env.BUCKET),
  uploads: new DurableObjectUploadStore(env.UPLOAD_SESSION),
  config: { ...DEFAULT_CONFIG, ...overrides },
  authorize: options.authorize ?? (async () => undefined),
});

conformanceSuite(makeRealRegistry, { customPartSize: false });
