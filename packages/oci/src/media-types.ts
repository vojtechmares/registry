/** Media types from the image spec, plus the Docker types clients still push. */

export const MEDIA_TYPE_OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
export const MEDIA_TYPE_OCI_INDEX = "application/vnd.oci.image.index.v1+json";
export const MEDIA_TYPE_OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
export const MEDIA_TYPE_OCI_EMPTY = "application/vnd.oci.empty.v1+json";

export const MEDIA_TYPE_DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
export const MEDIA_TYPE_DOCKER_MANIFEST_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";
export const MEDIA_TYPE_DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";

export const MEDIA_TYPE_OCTET_STREAM = "application/octet-stream";

/** The content of `application/vnd.oci.empty.v1+json`, and its digest. */
export const EMPTY_JSON = "{}";
export const EMPTY_JSON_DIGEST = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

export const MANIFEST_MEDIA_TYPES: readonly string[] = [
  MEDIA_TYPE_OCI_MANIFEST,
  MEDIA_TYPE_OCI_INDEX,
  MEDIA_TYPE_DOCKER_MANIFEST,
  MEDIA_TYPE_DOCKER_MANIFEST_LIST,
];

/**
 * Strips parameters from a Content-Type. The spec tells registries to ignore
 * them, so `application/json; charset=utf-8` must compare equal to `application/json`.
 */
export function stripMediaTypeParameters(contentType: string): string {
  const semicolon = contentType.indexOf(";");
  return (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim();
}
