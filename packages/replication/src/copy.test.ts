import { describe, expect, it } from "vitest";
import type { BlobStream, ManifestBytes, RegistryClient } from "./client.js";
import { CopyError, copyArtifact, remap } from "./copy.js";

const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function streamOf(bytes: Uint8Array): BlobStream {
  return {
    size: bytes.length,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

/** An in-memory registry: enough to prove the copy order, and nothing else. */
class MemoryRegistry implements RegistryClient {
  readonly manifests = new Map<string, ManifestBytes>();
  readonly blobs = new Map<string, Uint8Array>();
  /** Every operation, in order, so the sequencing can be asserted. */
  readonly log: string[] = [];

  constructor(readonly name: string) {}

  async getManifest(repository: string, reference: string): Promise<ManifestBytes | null> {
    this.log.push(`getManifest ${repository}:${reference}`);
    return this.manifests.get(`${repository}|${reference}`) ?? null;
  }

  async putManifest(repository: string, reference: string, manifest: ManifestBytes): Promise<void> {
    this.log.push(`putManifest ${repository}:${reference}`);
    this.manifests.set(`${repository}|${reference}`, manifest);
    this.manifests.set(`${repository}|${manifest.digest}`, manifest);
  }

  async hasBlob(repository: string, digest: string): Promise<boolean> {
    return this.blobs.has(`${repository}|${digest}`);
  }

  async getBlob(repository: string, digest: string): Promise<BlobStream | null> {
    const bytes = this.blobs.get(`${repository}|${digest}`);
    return bytes === undefined ? null : streamOf(bytes);
  }

  async putBlob(repository: string, digest: string, blob: BlobStream): Promise<void> {
    this.log.push(`putBlob ${digest}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of blob.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    this.blobs.set(`${repository}|${digest}`, chunks[0] ?? new Uint8Array());
  }

  async listTags(repository: string): Promise<string[]> {
    return [...this.manifests.keys()]
      .filter((key) => key.startsWith(`${repository}|`) && !key.includes("|sha256:"))
      .map((key) => key.split("|")[1]!);
  }
}

/** Seeds an image with a config blob and one layer, returns its manifest bytes. */
async function seedImage(registry: MemoryRegistry, repository: string, tag: string, seed: number) {
  const config = new Uint8Array([seed, 1, 2]);
  const layer = new Uint8Array([seed, 3, 4]);
  const configDigest = await sha256(config);
  const layerDigest = await sha256(layer);

  registry.blobs.set(`${repository}|${configDigest}`, config);
  registry.blobs.set(`${repository}|${layerDigest}`, layer);

  const body = JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: 3 },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: 3 }],
  });
  const bytes = new TextEncoder().encode(body);
  const manifest: ManifestBytes = { bytes, mediaType: MANIFEST_TYPE, digest: await sha256(bytes) };

  registry.manifests.set(`${repository}|${tag}`, manifest);
  registry.manifests.set(`${repository}|${manifest.digest}`, manifest);
  return { manifest, configDigest, layerDigest };
}

describe("copyArtifact", () => {
  it("copies a plain image, blobs before the manifest", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");
    await seedImage(source, "acme/api", "v1", 1);

    const report = await copyArtifact(source, destination, "acme/api", "mirror/api", "v1");
    expect(report).toEqual({ manifests: 1, blobs: 2, blobsSkipped: 0 });

    // The manifest lands only once everything it names is already there.
    const putManifestAt = destination.log.indexOf("putManifest mirror/api:v1");
    const lastBlobAt = destination.log.findLastIndex((entry) => entry.startsWith("putBlob"));
    expect(lastBlobAt).toBeLessThan(putManifestAt);
  });

  it("transfers no blob the destination already holds", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");
    const { configDigest, layerDigest } = await seedImage(source, "acme/api", "v1", 1);

    destination.blobs.set(`mirror/api|${configDigest}`, new Uint8Array([1, 1, 2]));
    destination.blobs.set(`mirror/api|${layerDigest}`, new Uint8Array([1, 3, 4]));

    const report = await copyArtifact(source, destination, "acme/api", "mirror/api", "v1");
    expect(report).toEqual({ manifests: 1, blobs: 0, blobsSkipped: 2 });
  });

  it("copies an index's children before the index", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");

    const amd = await seedImage(source, "acme/api", "amd64", 1);
    const arm = await seedImage(source, "acme/api", "arm64", 2);

    const indexBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_TYPE,
      manifests: [
        { mediaType: MANIFEST_TYPE, digest: amd.manifest.digest, size: amd.manifest.bytes.length },
        { mediaType: MANIFEST_TYPE, digest: arm.manifest.digest, size: arm.manifest.bytes.length },
      ],
    });
    const indexBytes = new TextEncoder().encode(indexBody);
    const index: ManifestBytes = {
      bytes: indexBytes,
      mediaType: INDEX_TYPE,
      digest: await sha256(indexBytes),
    };
    source.manifests.set("acme/api|multi", index);

    const report = await copyArtifact(source, destination, "acme/api", "mirror/api", "multi");
    expect(report.manifests).toBe(3);
    expect(report.blobs).toBe(4);

    const indexAt = destination.log.indexOf("putManifest mirror/api:multi");
    const childAt = destination.log.indexOf(`putManifest mirror/api:${amd.manifest.digest}`);
    expect(childAt).toBeLessThan(indexAt);
  });

  it("refuses an artifact the source does not have", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");
    await expect(copyArtifact(source, destination, "acme/api", "mirror/api", "v1")).rejects.toThrow(
      CopyError,
    );
  });

  it("refuses a manifest whose blob the source cannot serve", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");
    const { layerDigest } = await seedImage(source, "acme/api", "v1", 1);
    source.blobs.delete(`acme/api|${layerDigest}`);

    await expect(copyArtifact(source, destination, "acme/api", "mirror/api", "v1")).rejects.toThrow(
      /missing blob/,
    );
  });

  it("gives up on a manifest that nests too deep, rather than recursing forever", async () => {
    const source = new MemoryRegistry("source");
    const destination = new MemoryRegistry("destination");

    // An index that names itself.
    const body = JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_TYPE,
      manifests: [{ mediaType: INDEX_TYPE, digest: `sha256:${"ab".repeat(32)}`, size: 10 }],
    });
    const bytes = new TextEncoder().encode(body);
    const self: ManifestBytes = { bytes, mediaType: INDEX_TYPE, digest: `sha256:${"ab".repeat(32)}` };
    source.manifests.set("acme/api|loop", self);
    source.manifests.set(`acme/api|sha256:${"ab".repeat(32)}`, self);

    await expect(copyArtifact(source, destination, "acme/api", "mirror/api", "loop")).rejects.toThrow(
      /nesting/,
    );
  });
});

describe("remap", () => {
  it("prepends a namespace", () => {
    expect(remap("acme/api", "mirror")).toBe("mirror/acme/api");
  });

  it("passes the name through when there is no namespace", () => {
    expect(remap("acme/api", "")).toBe("acme/api");
  });

  it("does not double a slash", () => {
    expect(remap("acme/api", "/mirror/")).toBe("mirror/acme/api");
  });
});
