import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Runs once per test file, before its own hooks. Isolated storage means each
// file starts from an empty database, so the schema has to be laid down again
// here; `applyD1Migrations` records what it applied and is a no-op on a replay.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
