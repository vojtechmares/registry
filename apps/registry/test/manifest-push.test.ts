/**
 * The manifest validator at the distribution push boundary.
 *
 * A malformed manifest is rejected on parse, before any referenced blob is
 * looked up, with the distribution-spec MANIFEST_INVALID error.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { basic, call, errorCode, seedRepository, seedUser } from "./helpers.js";

const ADMIN = { id: "mpush-root", username: "mpushroot", password: "correct-horse-battery" };
const auth = basic(ADMIN.username, ADMIN.password);
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
  await seedRepository("mpush/app");
});

describe("pushing an invalid manifest", () => {
  it("rejects a manifest with a bad descriptor digest as MANIFEST_INVALID", async () => {
    const response = await call("PUT", "/v2/mpush/app/manifests/bad-digest", {
      headers: { Authorization: auth, "Content-Type": MANIFEST_TYPE },
      body: JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: CONFIG_TYPE, digest: "not-a-digest", size: 1 },
        layers: [],
      }),
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("MANIFEST_INVALID");
  });

  it("rejects a manifest body that is not JSON", async () => {
    const response = await call("PUT", "/v2/mpush/app/manifests/not-json", {
      headers: { Authorization: auth, "Content-Type": MANIFEST_TYPE },
      body: "this is not a manifest",
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("MANIFEST_INVALID");
  });
});
