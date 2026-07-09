/**
 * Manifest and image index parsing.
 *
 * Two rules drive the whole file. First, the registry MUST store the manifest
 * in the exact byte representation the client provided, so nothing here ever
 * re-serialises: we parse for validation and metadata extraction only. Second,
 * unknown fields MUST survive - the conformance suite deliberately pushes
 * manifests carrying a `newUnspecifiedField` - so validation is a whitelist of
 * the fields we care about, never a rejection of the fields we do not.
 */

import { isValidDigest } from "./digest.js";
import { manifestInvalid } from "./errors.js";
import { MEDIA_TYPE_OCI_INDEX, MEDIA_TYPE_OCI_MANIFEST, stripMediaTypeParameters } from "./media-types.js";

/** Spec: registries SHOULD support manifest pushes of at least 4 MiB. */
export const MAX_MANIFEST_SIZE = 4 * 1024 * 1024;

export interface Descriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly urls?: readonly string[];
  readonly annotations?: Readonly<Record<string, string>>;
  readonly artifactType?: string;
}

interface ManifestCommon {
  readonly mediaType: string;
  readonly artifactType?: string;
  readonly subject?: Descriptor;
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface ImageManifest extends ManifestCommon {
  readonly kind: "image";
  readonly config: Descriptor;
  readonly layers: readonly Descriptor[];
}

export interface ImageIndex extends ManifestCommon {
  readonly kind: "index";
  readonly manifests: readonly Descriptor[];
}

export type Manifest = ImageManifest | ImageIndex;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnnotations(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw manifestInvalid(`${where}: annotations must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw manifestInvalid(`${where}: annotation "${key}" must be a string`);
    out[key] = entry;
  }
  return out;
}

function parseDescriptor(value: unknown, where: string): Descriptor {
  if (!isRecord(value)) throw manifestInvalid(`${where}: descriptor must be an object`);

  const { mediaType, digest, size, urls, artifactType } = value;
  if (typeof mediaType !== "string") throw manifestInvalid(`${where}: mediaType must be a string`);
  if (typeof digest !== "string" || !isValidDigest(digest)) {
    throw manifestInvalid(`${where}: digest must be a valid, supported digest`);
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw manifestInvalid(`${where}: size must be a non-negative integer`);
  }

  const descriptor: {
    -readonly [K in keyof Descriptor]: Descriptor[K];
  } = { mediaType, digest, size };

  if (urls !== undefined && urls !== null) {
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== "string")) {
      throw manifestInvalid(`${where}: urls must be an array of strings`);
    }
    descriptor.urls = urls as string[];
  }
  if (artifactType !== undefined && artifactType !== null) {
    if (typeof artifactType !== "string") throw manifestInvalid(`${where}: artifactType must be a string`);
    descriptor.artifactType = artifactType;
  }
  const annotations = parseAnnotations(value.annotations, where);
  if (annotations !== undefined) descriptor.annotations = annotations;

  return descriptor;
}

function parseDescriptorArray(value: unknown, where: string): Descriptor[] {
  if (!Array.isArray(value)) throw manifestInvalid(`${where} must be an array`);
  return value.map((entry, index) => parseDescriptor(entry, `${where}[${index}]`));
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw manifestInvalid(`${where} must be a string`);
  return value;
}

/**
 * Parses manifest bytes. `contentType` supplies the media type when the body
 * omits `mediaType`, which the spec allows and the conformance suite exercises
 * with its no-layer manifest.
 */
export function parseManifest(body: Uint8Array, contentType?: string): Manifest {
  if (body.length > MAX_MANIFEST_SIZE) throw manifestInvalid("manifest too large");

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw manifestInvalid("manifest is not valid JSON");
  }
  if (!isRecord(document)) throw manifestInvalid("manifest must be a JSON object");

  if (document.schemaVersion !== 2) {
    throw manifestInvalid("schemaVersion must be 2");
  }

  const declared = optionalString(document.mediaType, "mediaType");
  const fromHeader =
    contentType === undefined ? undefined : stripMediaTypeParameters(contentType) || undefined;

  const artifactType = optionalString(document.artifactType, "artifactType");
  const annotations = parseAnnotations(document.annotations, "manifest");
  const subject =
    document.subject === undefined || document.subject === null
      ? undefined
      : parseDescriptor(document.subject, "subject");

  // Structure decides the kind: an index has `manifests`, an image manifest has
  // `config`. Media types are advisory and clients get them wrong.
  if (document.manifests !== undefined) {
    const manifests = parseDescriptorArray(document.manifests, "manifests");
    const index: { -readonly [K in keyof ImageIndex]: ImageIndex[K] } = {
      kind: "index",
      mediaType: declared ?? fromHeader ?? MEDIA_TYPE_OCI_INDEX,
      manifests,
    };
    if (artifactType !== undefined) index.artifactType = artifactType;
    if (subject !== undefined) index.subject = subject;
    if (annotations !== undefined) index.annotations = annotations;
    return index;
  }

  if (document.config === undefined) {
    throw manifestInvalid("manifest must contain either `config` or `manifests`");
  }

  const image: { -readonly [K in keyof ImageManifest]: ImageManifest[K] } = {
    kind: "image",
    mediaType: declared ?? fromHeader ?? MEDIA_TYPE_OCI_MANIFEST,
    config: parseDescriptor(document.config, "config"),
    layers: parseDescriptorArray(document.layers ?? [], "layers"),
  };
  if (artifactType !== undefined) image.artifactType = artifactType;
  if (subject !== undefined) image.subject = subject;
  if (annotations !== undefined) image.annotations = annotations;
  return image;
}

/**
 * The `artifactType` a referrers descriptor must carry.
 *
 * Spec: use the manifest's own `artifactType`; if empty or missing on an image
 * manifest, fall back to the config descriptor's `mediaType`; if empty or
 * missing on an index, omit it entirely.
 */
export function referrerArtifactType(manifest: Manifest): string | undefined {
  if (manifest.artifactType !== undefined) return manifest.artifactType;
  if (manifest.kind === "index") return undefined;
  return manifest.config.mediaType === "" ? undefined : manifest.config.mediaType;
}

/** Builds the descriptor that represents `manifest` inside a referrers listing. */
export function referrerDescriptor(manifest: Manifest, digest: string, size: number): Descriptor {
  const descriptor: { -readonly [K in keyof Descriptor]: Descriptor[K] } = {
    mediaType: manifest.mediaType,
    digest,
    size,
  };
  const artifactType = referrerArtifactType(manifest);
  if (artifactType !== undefined) descriptor.artifactType = artifactType;
  if (manifest.annotations !== undefined) descriptor.annotations = manifest.annotations;
  return descriptor;
}

/**
 * Content this manifest requires the registry to already hold, excluding
 * `subject` - a manifest may legitimately be pushed before its subject.
 *
 * Layers carrying `urls` are foreign layers, fetched from elsewhere, so the
 * registry never stores them and must not demand they exist.
 */
export function referencedContent(manifest: Manifest): { blobs: string[]; manifests: string[] } {
  if (manifest.kind === "index") {
    return { blobs: [], manifests: manifest.manifests.map((descriptor) => descriptor.digest) };
  }
  const blobs = [manifest.config.digest];
  for (const layer of manifest.layers) {
    if (layer.urls === undefined || layer.urls.length === 0) blobs.push(layer.digest);
  }
  return { blobs, manifests: [] };
}
