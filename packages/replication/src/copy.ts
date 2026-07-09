import { parseManifest, referencedContent } from "@registry/oci";
import type { BlobStream, ManifestBytes, RegistryClient } from "./client.js";

export interface CopyReport {
  readonly manifests: number;
  readonly blobs: number;
  readonly blobsSkipped: number;
}

export class CopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyError";
  }
}

/** Guards against a hostile or broken index that names itself, directly or in a cycle. */
const MAX_DEPTH = 8;

/**
 * Copies one artifact from `source` to `destination`, by tag or by digest.
 *
 * The order is what matters. Blobs first, then any child manifests, then the
 * manifest itself - which is the only order in which the destination is never
 * left holding a manifest that names content it does not have. A registry that
 * validates blob references (this one does) would reject the manifest anyway;
 * one that does not would end up serving a broken image.
 *
 * A blob already present at the destination is not transferred. Across a
 * deduplicating registry that is most of them, most of the time.
 */
export async function copyArtifact(
  source: RegistryClient,
  destination: RegistryClient,
  sourceRepository: string,
  destinationRepository: string,
  reference: string,
): Promise<CopyReport> {
  const report = { manifests: 0, blobs: 0, blobsSkipped: 0 };
  await copyOne(source, destination, sourceRepository, destinationRepository, reference, report, 0);
  return report;
}

async function copyOne(
  source: RegistryClient,
  destination: RegistryClient,
  sourceRepository: string,
  destinationRepository: string,
  reference: string,
  report: { manifests: number; blobs: number; blobsSkipped: number },
  depth: number,
): Promise<void> {
  if (depth > MAX_DEPTH) throw new CopyError(`manifest nesting exceeded ${MAX_DEPTH} levels`);

  const manifest = await source.getManifest(sourceRepository, reference);
  if (manifest === null) {
    throw new CopyError(`${source.name} has no "${sourceRepository}:${reference}"`);
  }

  const parsed = parseManifest(manifest.bytes, manifest.mediaType);
  const { blobs, manifests } = referencedContent(parsed);

  for (const digest of blobs) {
    if (await destination.hasBlob(destinationRepository, digest)) {
      report.blobsSkipped++;
      continue;
    }

    const blob = await source.getBlob(sourceRepository, digest);
    if (blob === null) throw new CopyError(`${source.name} is missing blob ${digest}`);

    await destination.putBlob(destinationRepository, digest, blob);
    report.blobs++;
  }

  // A child of an index is addressed by digest, and is copied before the index
  // that names it.
  for (const child of manifests) {
    await copyOne(source, destination, sourceRepository, destinationRepository, child, report, depth + 1);
  }

  await destination.putManifest(destinationRepository, reference, manifest);
  report.manifests++;
}

/**
 * Where a repository lands at the other end.
 *
 * `namespace` is prepended, so `acme/api` replicated into `mirror` becomes
 * `mirror/acme/api`. An empty namespace copies the name across unchanged, which
 * is what a mirror of the same layout wants.
 */
export function remap(repository: string, namespace: string): string {
  const trimmed = namespace.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? repository : `${trimmed}/${repository}`;
}

export type { BlobStream, ManifestBytes, RegistryClient };
