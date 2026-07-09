/**
 * Path parsing for the `/v2/` API.
 *
 * `<name>` may itself contain slashes (`library/ubuntu`), so routes cannot be
 * matched by splitting on `/`. Each pattern instead anchors on the fixed suffix
 * and lets a greedy `.+` absorb the name. Ordering matters: `blobs/uploads/`
 * must be tried before `blobs/<digest>`, or `uploads` would be read as a digest.
 */

export type Route =
  | { readonly kind: "base" }
  | { readonly kind: "uploads"; readonly name: string }
  | { readonly kind: "upload"; readonly name: string; readonly id: string }
  | { readonly kind: "blob"; readonly name: string; readonly digest: string }
  | { readonly kind: "manifest"; readonly name: string; readonly reference: string }
  | { readonly kind: "tags"; readonly name: string }
  | { readonly kind: "referrers"; readonly name: string; readonly digest: string };

const TAGS = /^(.+)\/tags\/list$/;
const UPLOADS = /^(.+)\/blobs\/uploads\/$/;
const UPLOAD = /^(.+)\/blobs\/uploads\/([^/]+)$/;
const BLOB = /^(.+)\/blobs\/([^/]+)$/;
const MANIFEST = /^(.+)\/manifests\/([^/]+)$/;
const REFERRERS = /^(.+)\/referrers\/([^/]+)$/;

export function matchRoute(pathname: string): Route | null {
  if (pathname === "/v2" || pathname === "/v2/") return { kind: "base" };
  if (!pathname.startsWith("/v2/")) return null;

  const rest = pathname.slice("/v2/".length);

  const tags = TAGS.exec(rest);
  if (tags !== null) return { kind: "tags", name: tags[1]! };

  const uploads = UPLOADS.exec(rest);
  if (uploads !== null) return { kind: "uploads", name: uploads[1]! };

  const upload = UPLOAD.exec(rest);
  if (upload !== null) return { kind: "upload", name: upload[1]!, id: upload[2]! };

  const blob = BLOB.exec(rest);
  if (blob !== null) return { kind: "blob", name: blob[1]!, digest: blob[2]! };

  const manifest = MANIFEST.exec(rest);
  if (manifest !== null) return { kind: "manifest", name: manifest[1]!, reference: manifest[2]! };

  const referrers = REFERRERS.exec(rest);
  if (referrers !== null) return { kind: "referrers", name: referrers[1]!, digest: referrers[2]! };

  return null;
}
