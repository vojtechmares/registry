/**
 * Signature rules against real D1, driven through the registry API exactly as
 * `docker` and `cosign` drive it.
 *
 * The rules bite at the tag on the way in and at the manifest on the way out,
 * and they have to leave both signature layouts - the referrers API and
 * cosign's older `sha256-<hex>.sig` tag - able to do their job.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { COSIGN_SIGNATURE_ARTIFACT_TYPE, cosignSignatureTag } from "@registry/signing";
import {
  basic,
  call,
  deterministic,
  digestOf,
  errorCode,
  seedProject,
  seedRepository,
  seedUser,
} from "./helpers.js";

const ADMIN = { id: "sig-root", username: "sigroot", password: "correct-horse-battery" };
const auth = basic(ADMIN.username, ADMIN.password);

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";

/** Uploads a blob and returns its digest, so a manifest may legally reference it. */
async function seedBlob(repository: string, bytes: Uint8Array): Promise<string> {
  const digest = await digestOf(bytes);
  const response = await call("POST", `/v2/${repository}/blobs/uploads/?digest=${digest}`, {
    headers: { Authorization: auth, "Content-Length": String(bytes.length) },
    body: bytes as unknown as BodyInit,
  });
  expect(response.status).toBe(201);
  return digest;
}

interface ManifestOptions {
  readonly configDigest: string;
  readonly configSize: number;
  readonly configType?: string;
  readonly subject?: { digest: string; size: number };
  readonly artifactType?: string;
}

function manifestBody(options: ManifestOptions): string {
  const manifest: Record<string, unknown> = {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: {
      mediaType: options.configType ?? CONFIG_TYPE,
      digest: options.configDigest,
      size: options.configSize,
    },
    layers: [],
  };
  if (options.artifactType !== undefined) manifest.artifactType = options.artifactType;
  if (options.subject !== undefined) {
    manifest.subject = {
      mediaType: MANIFEST_TYPE,
      digest: options.subject.digest,
      size: options.subject.size,
    };
  }
  return JSON.stringify(manifest);
}

async function putManifest(repository: string, reference: string, body: string): Promise<Response> {
  return call("PUT", `/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: auth, "Content-Type": MANIFEST_TYPE },
    body,
  });
}

/**
 * Fetches a manifest and drains the body.
 *
 * A 200 hands back a stream straight out of R2. Leaving it unread holds the
 * object open past the end of the test, and the pool cannot then roll back its
 * isolated storage - which surfaces as a mystifying failure in whichever test
 * happens to run next.
 */
async function getManifest(repository: string, reference: string): Promise<Response> {
  const response = await call("GET", `/v2/${repository}/manifests/${reference}`, {
    headers: { Authorization: auth },
  });
  await response.arrayBuffer();
  return response;
}

/** Pushes an unsigned image by digest, which every rule here permits. */
async function pushImage(repository: string, seed: number): Promise<{ digest: string; size: number }> {
  const config = deterministic(32, seed);
  const configDigest = await seedBlob(repository, config);
  const body = manifestBody({ configDigest, configSize: config.length });
  const digest = await digestOf(new TextEncoder().encode(body));

  const response = await putManifest(repository, digest, body);
  expect(response.status).toBe(201);
  return { digest, size: body.length };
}

/** Attaches a cosign signature through the referrers API. */
async function signViaReferrers(
  repository: string,
  subject: { digest: string; size: number },
): Promise<void> {
  const config = deterministic(16, 99);
  const configDigest = await seedBlob(repository, config);
  const body = manifestBody({
    configDigest,
    configSize: config.length,
    configType: COSIGN_SIGNATURE_ARTIFACT_TYPE,
    subject,
  });
  const digest = await digestOf(new TextEncoder().encode(body));
  const response = await putManifest(repository, digest, body);
  expect(response.status).toBe(201);
}

/** Attaches a signature the way cosign does against a registry without referrers. */
async function signViaLegacyTag(repository: string, subjectDigest: string): Promise<string> {
  const config = deterministic(16, 98);
  const configDigest = await seedBlob(repository, config);
  const body = manifestBody({ configDigest, configSize: config.length });
  const digest = await digestOf(new TextEncoder().encode(body));

  const response = await putManifest(repository, cosignSignatureTag(subjectDigest)!, body);
  expect(response.status).toBe(201);
  return digest;
}

beforeAll(async () => {
  await seedUser({ ...ADMIN, isAdmin: true });
});

describe("require signatures on push", () => {
  it("refuses to tag a manifest nothing has signed", async () => {
    await seedRepository("sigpush/app", { name: "sigpush", requireSignaturePush: true });
    const image = await pushImage("sigpush/app", 1);

    const response = await putManifest(
      "sigpush/app",
      "v1",
      manifestBody({ configDigest: await digestOf(deterministic(32, 1)), configSize: 32 }),
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
    expect(image.digest).toBeTruthy();
  });

  it("permits a push by digest, which is how a manifest becomes signable", async () => {
    await seedRepository("sigpush2/app", { name: "sigpush2", requireSignaturePush: true });
    const image = await pushImage("sigpush2/app", 2);
    expect(image.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("permits the tag once a referrers signature exists", async () => {
    await seedRepository("sigpush3/app", { name: "sigpush3", requireSignaturePush: true });
    const image = await pushImage("sigpush3/app", 3);
    await signViaReferrers("sigpush3/app", image);

    const config = deterministic(32, 3);
    const body = manifestBody({ configDigest: await digestOf(config), configSize: config.length });
    expect((await putManifest("sigpush3/app", "v1", body)).status).toBe(201);
  });

  it("permits the tag once a legacy cosign signature tag exists", async () => {
    await seedRepository("sigpush4/app", { name: "sigpush4", requireSignaturePush: true });
    const image = await pushImage("sigpush4/app", 4);
    await signViaLegacyTag("sigpush4/app", image.digest);

    const config = deterministic(32, 4);
    const body = manifestBody({ configDigest: await digestOf(config), configSize: config.length });
    expect((await putManifest("sigpush4/app", "v1", body)).status).toBe(201);
  });

  it("permits pushing the signature itself under its own attachment tag", async () => {
    await seedRepository("sigpush5/app", { name: "sigpush5", requireSignaturePush: true });
    const image = await pushImage("sigpush5/app", 5);
    // Would deadlock if the rule applied: the signature would need a signature.
    const signature = await signViaLegacyTag("sigpush5/app", image.digest);
    expect(signature).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("does not let a tag that merely resembles an attachment slip an unsigned image through", async () => {
    await seedRepository("sigpush6/app", { name: "sigpush6", requireSignaturePush: true });
    await pushImage("sigpush6/app", 6);

    const config = deterministic(32, 6);
    const body = manifestBody({ configDigest: await digestOf(config), configSize: config.length });
    const response = await putManifest("sigpush6/app", `sha256-${"ab".repeat(32)}.evil`, body);
    expect(response.status).toBe(403);
  });

  it("leaves a project without the rule alone", async () => {
    await seedRepository("nosig/app");
    await pushImage("nosig/app", 7);
    const config = deterministic(32, 7);
    const body = manifestBody({ configDigest: await digestOf(config), configSize: config.length });
    expect((await putManifest("nosig/app", "v1", body)).status).toBe(201);
  });
});

describe("require signatures on pull", () => {
  it("refuses to serve a manifest nothing has signed", async () => {
    await seedRepository("sigpull/app");
    const image = await pushImage("sigpull/app", 10);
    await seedProject({ name: "sigpull", requireSignaturePull: true });

    const response = await call("GET", `/v2/sigpull/app/manifests/${image.digest}`, {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("DENIED");
  });

  it("serves a manifest once it carries a referrers signature", async () => {
    await seedRepository("sigpull2/app");
    const image = await pushImage("sigpull2/app", 11);
    await signViaReferrers("sigpull2/app", image);
    await seedProject({ name: "sigpull2", requireSignaturePull: true });

    expect((await getManifest("sigpull2/app", image.digest)).status).toBe(200);
  });

  it("still serves the signature manifest itself, or nothing could verify anything", async () => {
    await seedRepository("sigpull3/app");
    const image = await pushImage("sigpull3/app", 12);
    const signatureDigest = await signViaLegacyTag("sigpull3/app", image.digest);
    await seedProject({ name: "sigpull3", requireSignaturePull: true });

    // The subject is now servable, because the legacy tag signs it...
    expect((await getManifest("sigpull3/app", image.digest)).status).toBe(200);

    // ...and so is the signature, which has no signature of its own.
    expect((await getManifest("sigpull3/app", cosignSignatureTag(image.digest)!)).status).toBe(200);
    expect((await getManifest("sigpull3/app", signatureDigest)).status).toBe(200);
  });

  it("serves a referrers signature manifest, which carries a subject", async () => {
    await seedRepository("sigpull4/app");
    const image = await pushImage("sigpull4/app", 13);
    await signViaReferrers("sigpull4/app", image);
    await seedProject({ name: "sigpull4", requireSignaturePull: true });

    const referrers = await call("GET", `/v2/sigpull4/app/referrers/${image.digest}`, {
      headers: { Authorization: auth },
    });
    expect(referrers.status).toBe(200);
    const index = (await referrers.json()) as { manifests: Array<{ digest: string }> };
    const signature = index.manifests[0]!.digest;

    expect((await getManifest("sigpull4/app", signature)).status).toBe(200);
  });

  it("does not accept a signature filed against a different repository", async () => {
    await seedRepository("sigpull5/app");
    await seedRepository("sigpull5/other");
    const image = await pushImage("sigpull5/app", 14);
    // Signed, but in the sibling repository. A signature is scoped to the
    // repository holding it, or anyone who can push anywhere could vouch for
    // a subject they cannot even read.
    await signViaLegacyTag("sigpull5/other", image.digest);
    await seedProject({ name: "sigpull5", requireSignaturePull: true });

    expect((await getManifest("sigpull5/app", image.digest)).status).toBe(403);
  });
});
