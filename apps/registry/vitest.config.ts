import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// The schema these tests assert against lives in the same migration files the
// deployed Worker ships. Reading them here and handing them to the pool as a
// binding lets a setup file replay them into the throwaway D1, so the tests run
// against exactly the tables production runs against.
const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

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
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
