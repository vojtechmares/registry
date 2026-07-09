import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// The schema these tests assert against lives in the same migration files the
// deployed Worker ships. Reading them here and handing them to the pool as a
// binding lets a setup file replay them into the throwaway D1, so the tests run
// against exactly the tables production runs against.
const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// The pool validates every binding in wrangler.jsonc as it loads the config,
// including the dashboard's `assets.directory`. None of these tests touch the
// dashboard, but the directory has to exist or the pool refuses to start - and
// on a fresh checkout it does not, because it is a build artifact. Create an
// empty one so `pnpm test` is self-contained without first building the UI.
mkdirSync(fileURLToPath(new URL("../web/dist", import.meta.url)), { recursive: true });

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          // One Worker instance shared across files keeps the runtime warm;
          // isolated storage still gives every test its own clean R2, D1 and
          // Durable Object state, rolled back the instant the test ends.
          singleWorker: true,
          isolatedStorage: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              // The Worker refuses to start without a signing secret.
              JWT_SECRET: "test-jwt-secret-not-for-production",
              // The limiter is exercised in its own file by driving the Durable
              // Object directly. Everywhere else it would only add latency and
              // flakiness to requests that are not testing it.
              RATE_LIMIT_ENABLED: "false",
              // Single sign-on, so the OIDC routes are live under test. The
              // provider itself is stubbed with `fetch`.
              OIDC_ISSUER: "https://idp.test",
              OIDC_CLIENT_ID: "registry-client",
              OIDC_CLIENT_SECRET: "test-client-secret",
              OIDC_ADMIN_GROUPS: "platform-admins",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
