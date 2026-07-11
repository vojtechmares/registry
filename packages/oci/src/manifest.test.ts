import { describe, expect, it } from "vitest";
import { OciError } from "./errors.js";
import {
  MAX_MANIFEST_SIZE,
  parseManifest,
  referencedContent,
  referrerArtifactType,
  referrerDescriptor,
} from "./manifest.js";
import { EMPTY_JSON_DIGEST, MEDIA_TYPE_OCI_INDEX, MEDIA_TYPE_OCI_MANIFEST } from "./media-types.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

const emptyDescriptor = {
  mediaType: "application/vnd.oci.empty.v1+json",
  digest: EMPTY_JSON_DIGEST,
  size: 2,
};

const imageManifest = {
  schemaVersion: 2,
  mediaType: MEDIA_TYPE_OCI_MANIFEST,
  config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestA, size: 123 },
  layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digestB, size: 456 }],
};

describe("parseManifest", () => {
  it("parses an image manifest", () => {
    const manifest = parseManifest(encode(imageManifest));
    expect(manifest.kind).toBe("image");
    expect(manifest.mediaType).toBe(MEDIA_TYPE_OCI_MANIFEST);
  });

  it("preserves unknown fields by ignoring them, as the conformance suite requires", () => {
    // The suite pushes descriptors carrying `newUnspecifiedField` and `data`.
    const withUnknowns = {
      ...imageManifest,
      newUnspecifiedField: null,
      somethingElse: { nested: true },
      config: { ...imageManifest.config, data: "e30=", newUnspecifiedField: "aGVsbG8gd29ybGQ=" },
    };
    expect(() => parseManifest(encode(withUnknowns))).not.toThrow();
  });

  it("falls back to Content-Type when the body omits mediaType", () => {
    // The suite's no-layer manifest has no `mediaType` field.
    const { mediaType: _omitted, ...noMediaType } = imageManifest;
    const manifest = parseManifest(encode({ ...noMediaType, layers: [] }), MEDIA_TYPE_OCI_MANIFEST);
    expect(manifest.mediaType).toBe(MEDIA_TYPE_OCI_MANIFEST);
    expect(manifest.kind).toBe("image");
  });

  it("ignores Content-Type parameters", () => {
    const { mediaType: _omitted, ...noMediaType } = imageManifest;
    const manifest = parseManifest(encode(noMediaType), `${MEDIA_TYPE_OCI_MANIFEST}; charset=utf-8`);
    expect(manifest.mediaType).toBe(MEDIA_TYPE_OCI_MANIFEST);
  });

  it("accepts a manifest with no layers", () => {
    const manifest = parseManifest(encode({ ...imageManifest, layers: [] }));
    expect(manifest.kind === "image" && manifest.layers).toEqual([]);
  });

  it("accepts a manifest with layers omitted entirely", () => {
    const { layers: _omitted, ...noLayers } = imageManifest;
    const manifest = parseManifest(encode(noLayers));
    expect(manifest.kind === "image" && manifest.layers).toEqual([]);
  });

  it("distinguishes an index by structure, not by media type", () => {
    const index = parseManifest(
      encode({
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        manifests: [{ mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestA, size: 10 }],
      }),
    );
    expect(index.kind).toBe("index");
  });

  it("accepts a valid image index unchanged", () => {
    const index = parseManifest(
      encode({
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        manifests: [
          { mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestA, size: 10 },
          { mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestB, size: 20 },
        ],
        annotations: { "org.opencontainers.image.ref.name": "v1" },
      }),
    );
    expect(index.kind === "index" && index.manifests.map((entry) => entry.digest)).toEqual([
      digestA,
      digestB,
    ]);
    expect(index.annotations).toEqual({ "org.opencontainers.image.ref.name": "v1" });
  });

  it("reads subject and annotations", () => {
    const manifest = parseManifest(
      encode({
        ...imageManifest,
        subject: { mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestC, size: 99 },
        annotations: { "org.opencontainers.conformance.test": "test config a" },
      }),
    );
    expect(manifest.subject?.digest).toBe(digestC);
    expect(manifest.annotations).toEqual({ "org.opencontainers.conformance.test": "test config a" });
  });

  it("rejects malformed manifests with MANIFEST_INVALID", () => {
    const cases: Array<[string, Uint8Array]> = [
      ["not json", new TextEncoder().encode("blablabla")],
      ["not an object", encode([1, 2, 3])],
      ["schemaVersion 1", encode({ ...imageManifest, schemaVersion: 1 })],
      ["schemaVersion missing", encode({ config: imageManifest.config, layers: [] })],
      ["no config and no manifests", encode({ schemaVersion: 2 })],
      ["config not an object", encode({ schemaVersion: 2, config: "x", layers: [] })],
      [
        "bad descriptor digest",
        encode({ schemaVersion: 2, config: { ...imageManifest.config, digest: "nope" }, layers: [] }),
      ],
      [
        "negative size",
        encode({ schemaVersion: 2, config: { ...imageManifest.config, size: -1 }, layers: [] }),
      ],
      [
        "fractional size",
        encode({ schemaVersion: 2, config: { ...imageManifest.config, size: 1.5 }, layers: [] }),
      ],
      ["layers not an array", encode({ ...imageManifest, layers: {} })],
      ["non-string annotation", encode({ ...imageManifest, annotations: { key: 5 } })],
      // A descriptor whose media type is missing is a content/media-type mismatch.
      ["descriptor missing mediaType", encode({ schemaVersion: 2, config: { digest: digestA, size: 1 } })],
      [
        "index child with a bad digest",
        encode({
          schemaVersion: 2,
          manifests: [{ mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: "nope", size: 1 }],
        }),
      ],
    ];

    for (const [label, body] of cases) {
      let thrown: unknown;
      try {
        parseManifest(body);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(OciError);
      expect((thrown as OciError).code, label).toBe("MANIFEST_INVALID");
      expect((thrown as OciError).status, label).toBe(400);
    }
  });

  it("rejects manifests over the size limit", () => {
    expect(() => parseManifest(new Uint8Array(MAX_MANIFEST_SIZE + 1))).toThrow(OciError);
  });
});

describe("referrerArtifactType", () => {
  it("prefers the manifest's own artifactType", () => {
    const manifest = parseManifest(
      encode({
        ...imageManifest,
        artifactType: "application/vnd.nhl.peanut.butter.bagel",
        config: emptyDescriptor,
      }),
    );
    expect(referrerArtifactType(manifest)).toBe("application/vnd.nhl.peanut.butter.bagel");
  });

  it("falls back to the config media type on an image manifest", () => {
    const manifest = parseManifest(
      encode({
        ...imageManifest,
        config: { ...imageManifest.config, mediaType: "application/vnd.nba.strawberry.jam.croissant" },
      }),
    );
    expect(referrerArtifactType(manifest)).toBe("application/vnd.nba.strawberry.jam.croissant");
  });

  it("omits artifactType on an index that does not declare one", () => {
    const index = parseManifest(encode({ schemaVersion: 2, mediaType: MEDIA_TYPE_OCI_INDEX, manifests: [] }));
    expect(referrerArtifactType(index)).toBeUndefined();
  });

  it("keeps artifactType on an index that declares one", () => {
    const index = parseManifest(
      encode({
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        artifactType: "application/vnd.food.stand",
        manifests: [],
      }),
    );
    expect(referrerArtifactType(index)).toBe("application/vnd.food.stand");
  });

  it("omits artifactType when the config media type is empty", () => {
    const manifest = parseManifest(
      encode({ ...imageManifest, config: { ...imageManifest.config, mediaType: "" } }),
    );
    expect(referrerArtifactType(manifest)).toBeUndefined();
  });
});

describe("referrerDescriptor", () => {
  it("carries mediaType, size, digest, artifactType and annotations", () => {
    const manifest = parseManifest(
      encode({
        ...imageManifest,
        artifactType: "application/vnd.nhl.peanut.butter.bagel",
        annotations: { "org.opencontainers.conformance.test": "test layer a" },
      }),
    );
    expect(referrerDescriptor(manifest, digestC, 512)).toEqual({
      mediaType: MEDIA_TYPE_OCI_MANIFEST,
      digest: digestC,
      size: 512,
      artifactType: "application/vnd.nhl.peanut.butter.bagel",
      annotations: { "org.opencontainers.conformance.test": "test layer a" },
    });
  });

  it("omits annotations entirely when the manifest has none", () => {
    const manifest = parseManifest(encode(imageManifest));
    expect(referrerDescriptor(manifest, digestC, 512)).not.toHaveProperty("annotations");
  });
});

describe("referencedContent", () => {
  it("lists config and layers for an image manifest", () => {
    expect(referencedContent(parseManifest(encode(imageManifest)))).toEqual({
      blobs: [digestA, digestB],
      manifests: [],
    });
  });

  it("skips foreign layers, which the registry never stores", () => {
    const manifest = parseManifest(
      encode({
        ...imageManifest,
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
            digest: digestB,
            size: 1,
            urls: ["https://example.com/layer"],
          },
          { mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digestC, size: 2 },
        ],
      }),
    );
    expect(referencedContent(manifest)).toEqual({ blobs: [digestA, digestC], manifests: [] });
  });

  it("lists child manifests for an index and never the subject", () => {
    const index = parseManifest(
      encode({
        schemaVersion: 2,
        mediaType: MEDIA_TYPE_OCI_INDEX,
        manifests: [{ mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestA, size: 1 }],
        subject: { mediaType: MEDIA_TYPE_OCI_MANIFEST, digest: digestC, size: 2 },
      }),
    );
    // A manifest may be pushed before its subject exists, so the subject is
    // never a precondition for accepting the push.
    expect(referencedContent(index)).toEqual({ blobs: [], manifests: [digestA] });
  });
});
