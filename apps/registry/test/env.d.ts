/// <reference types="@cloudflare/vitest-pool-workers" />

import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env.js";

// The Worker's own bindings, plus the migration list the pool injects, so
// `env` from "cloudflare:test" is typed the same as the Worker sees it.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    readonly TEST_MIGRATIONS: D1Migration[];
  }
}
