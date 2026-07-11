/**
 * Manifest and image index parsing.
 *
 * Two rules drive the whole file. First, the registry MUST store the manifest
 * in the exact byte representation the client provided, so nothing here ever
 * re-serialises: we parse for validation and metadata extraction only. Second,
 * unknown fields MUST survive - the conformance suite deliberately pushes
 * manifests carrying a `newUnspecifiedField` - so the schemas below are loose
 * objects, which ignore the fields we do not name rather than rejecting them.
 *
 * The untrusted document is validated with Valibot against the OCI image
 * manifest, image index, and descriptor shapes; a schema failure becomes the
 * distribution-spec `MANIFEST_INVALID`. Structure, not the advisory media type,
 * decides which shape applies.
 */

import * as v from "valibot";
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

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/*                                                                            */
/* Loose objects: a field we do not name is ignored, never rejected, so the   */
/* stored bytes keep whatever the client sent. The optional metadata is        */
/* `nullish`, matching the predecessor's tolerance of a field sent as `null`.  */
/* -------------------------------------------------------------------------- */

const annotationsSchema = v.record(v.string(), v.string("annotation values must be strings"));

const descriptorSchema = v.object({
  mediaType: v.string("mediaType must be a string"),
  digest: v.pipe(v.string(), v.check(isValidDigest, "digest must be a valid, supported digest")),
  size: v.pipe(
    v.number("size must be a non-negative integer"),
    v.integer("size must be a non-negative integer"),
    v.minValue(0, "size must be a non-negative integer"),
  ),
  urls: v.nullish(v.array(v.string("urls must be an array of strings"))),
  annotations: v.nullish(annotationsSchema),
  artifactType: v.nullish(v.string()),
});

const commonEntries = {
  schemaVersion: v.literal(2, "schemaVersion must be 2"),
  mediaType: v.nullish(v.string()),
  artifactType: v.nullish(v.string()),
  subject: v.nullish(descriptorSchema),
  annotations: v.nullish(annotationsSchema),
} as const;

const imageManifestSchema = v.object({
  ...commonEntries,
  config: descriptorSchema,
  layers: v.nullish(v.array(descriptorSchema)),
});

const imageIndexSchema = v.object({
  ...commonEntries,
  manifests: v.array(descriptorSchema, "manifests must be an array"),
});

type ValidatedDescriptor = v.InferOutput<typeof descriptorSchema>;

/** Runs a schema, turning the first failure into the distribution-spec error. */
function validate<Schema extends v.GenericSchema>(schema: Schema, document: unknown): v.InferOutput<Schema> {
  const result = v.safeParse(schema, document);
  if (result.success) return result.output;
  const issue = result.issues[0];
  const path = issue === undefined ? null : v.getDotPath(issue);
  throw manifestInvalid(
    path === null ? (issue?.message ?? "manifest is invalid") : `${path}: ${issue!.message}`,
  );
}

/** A field's value only when it carries one; a null, undefined, or empty string is no value. */
function present(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}

/** The validated descriptor, with the absent optionals dropped rather than left undefined. */
function toDescriptor(validated: ValidatedDescriptor): Descriptor {
  const descriptor: { -readonly [K in keyof Descriptor]: Descriptor[K] } = {
    mediaType: validated.mediaType,
    digest: validated.digest,
    size: validated.size,
  };
  if (validated.urls != null) descriptor.urls = validated.urls;
  // A descriptor keeps an empty artifactType, unlike the manifest-level one.
  if (validated.artifactType != null) descriptor.artifactType = validated.artifactType;
  if (validated.annotations != null) descriptor.annotations = validated.annotations;
  return descriptor;
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
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw manifestInvalid("manifest must be a JSON object");
  }

  const fromHeader =
    contentType === undefined ? undefined : stripMediaTypeParameters(contentType) || undefined;

  // Structure decides the kind: an index has `manifests`, an image manifest has
  // `config`. Media types are advisory and clients get them wrong.
  const record = document as Record<string, unknown>;
  if (record.manifests !== undefined) {
    const parsed = validate(imageIndexSchema, document);
    const index: { -readonly [K in keyof ImageIndex]: ImageIndex[K] } = {
      kind: "index",
      mediaType: present(parsed.mediaType) ?? fromHeader ?? MEDIA_TYPE_OCI_INDEX,
      manifests: parsed.manifests.map(toDescriptor),
    };
    const artifactType = present(parsed.artifactType);
    if (artifactType !== undefined) index.artifactType = artifactType;
    if (parsed.subject != null) index.subject = toDescriptor(parsed.subject);
    if (parsed.annotations != null) index.annotations = parsed.annotations;
    return index;
  }

  if (record.config === undefined) {
    throw manifestInvalid("manifest must contain either `config` or `manifests`");
  }

  const parsed = validate(imageManifestSchema, document);
  const image: { -readonly [K in keyof ImageManifest]: ImageManifest[K] } = {
    kind: "image",
    mediaType: present(parsed.mediaType) ?? fromHeader ?? MEDIA_TYPE_OCI_MANIFEST,
    config: toDescriptor(parsed.config),
    layers: (parsed.layers ?? []).map(toDescriptor),
  };
  const artifactType = present(parsed.artifactType);
  if (artifactType !== undefined) image.artifactType = artifactType;
  if (parsed.subject != null) image.subject = toDescriptor(parsed.subject);
  if (parsed.annotations != null) image.annotations = parsed.annotations;
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
