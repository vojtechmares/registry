import type { BlobStream, ManifestBytes, RegistryClient } from "./client.js";

/**
 * The far end of a replication, over the distribution API.
 *
 * Authentication is the interesting part. A registry answers 401 with a
 * `WWW-Authenticate` header naming a token endpoint and a scope; the client
 * fetches a bearer token for that scope and retries. Docker Hub, GHCR, ECR and
 * this registry all speak it, and it is why replication needs no per-registry
 * special case. Basic credentials, when configured, are what the token endpoint
 * is given - never the registry itself, which would leak them to a host that
 * only asked for a token.
 */

export interface RemoteCredentials {
  readonly username: string;
  readonly password: string;
}

export interface RemoteOptions {
  /** The registry's base URL, e.g. `https://registry-1.docker.io`. */
  readonly url: string;
  readonly credentials?: RemoteCredentials | undefined;
  readonly timeoutMs?: number;
  /** Injected so tests need no network. */
  readonly fetch?: typeof fetch;
}

const ACCEPT_MANIFEST = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

interface Challenge {
  readonly realm: string;
  readonly service: string | null;
  readonly scope: string | null;
}

/** Parses `Bearer realm="...",service="...",scope="..."`. */
export function parseChallenge(header: string): Challenge | null {
  if (!header.toLowerCase().startsWith("bearer ")) return null;

  const parameters = new Map<string, string>();
  for (const match of header.slice(7).matchAll(/(\w+)="([^"]*)"/g)) {
    parameters.set(match[1]!, match[2]!);
  }

  const realm = parameters.get("realm");
  if (realm === undefined) return null;
  return { realm, service: parameters.get("service") ?? null, scope: parameters.get("scope") ?? null };
}

export class RemoteRegistry implements RegistryClient {
  readonly name: string;

  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  /** One token per scope, for as long as this replication run lasts. */
  private readonly tokens = new Map<string, string>();

  constructor(private readonly options: RemoteOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.name = new URL(this.base).host;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private basicHeader(): string | null {
    const credentials = this.options.credentials;
    if (credentials === undefined) return null;
    return `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
  }

  /**
   * Fetches a bearer token for a scope, then remembers it.
   *
   * The credentials go to the realm named in the challenge, which the operator
   * configured this registry to talk to. They are not sent anywhere else.
   */
  private async token(challenge: Challenge): Promise<string | null> {
    const key = challenge.scope ?? "";
    const cached = this.tokens.get(key);
    if (cached !== undefined) return cached;

    const url = new URL(challenge.realm);
    if (challenge.service !== null) url.searchParams.set("service", challenge.service);
    if (challenge.scope !== null) url.searchParams.set("scope", challenge.scope);

    const headers = new Headers();
    const basic = this.basicHeader();
    if (basic !== null) headers.set("Authorization", basic);

    const response = await this.fetcher(url.toString(), {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (token === undefined) return null;

    this.tokens.set(key, token);
    return token;
  }

  /**
   * Issues a request, answering an authentication challenge once if one comes
   * back. Once, and not in a loop: a registry that challenges the very token it
   * just issued is a registry this client cannot talk to, and retrying would
   * only turn that into a hang.
   */
  private async call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);

    const cached = [...this.tokens.values()][0];
    if (!headers.has("Authorization") && cached !== undefined) {
      headers.set("Authorization", `Bearer ${cached}`);
    }

    const response = await this.fetcher(`${this.base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status !== 401 || !retry) return response;

    const header = response.headers.get("WWW-Authenticate");
    if (header === null) return response;

    const challenge = parseChallenge(header);
    if (challenge === null) {
      // Basic, then. Send the credentials to the registry itself.
      const basic = this.basicHeader();
      if (basic === null) return response;
      headers.set("Authorization", basic);
      return this.call(path, { ...init, headers }, false);
    }

    const token = await this.token(challenge);
    if (token === null) return response;

    headers.set("Authorization", `Bearer ${token}`);
    return this.call(path, { ...init, headers }, false);
  }

  async getManifest(repository: string, reference: string): Promise<ManifestBytes | null> {
    const response = await this.call(`/v2/${repository}/manifests/${reference}`, {
      headers: { Accept: ACCEPT_MANIFEST },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${this.name} answered ${response.status} for ${reference}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const mediaType = response.headers.get("Content-Type") ?? "application/octet-stream";
    const digest = response.headers.get("Docker-Content-Digest") ?? (await digestOf(bytes));

    return { bytes, mediaType: mediaType.split(";")[0]!.trim(), digest };
  }

  async putManifest(repository: string, reference: string, manifest: ManifestBytes): Promise<void> {
    const response = await this.call(`/v2/${repository}/manifests/${reference}`, {
      method: "PUT",
      headers: { "Content-Type": manifest.mediaType },
      body: manifest.bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`${this.name} refused the manifest: ${response.status} ${await response.text()}`);
    }
  }

  async hasBlob(repository: string, digest: string): Promise<boolean> {
    const response = await this.call(`/v2/${repository}/blobs/${digest}`, { method: "HEAD" });
    return response.ok;
  }

  async getBlob(repository: string, digest: string): Promise<BlobStream | null> {
    const response = await this.call(`/v2/${repository}/blobs/${digest}`);
    if (response.status === 404) return null;
    if (!response.ok || response.body === null) {
      throw new Error(`${this.name} answered ${response.status} for blob ${digest}`);
    }

    const length = response.headers.get("Content-Length");
    return { body: response.body, size: length === null ? -1 : Number(length) };
  }

  /**
   * Uploads a blob in one request.
   *
   * A `Content-Length` is mandatory, and a source that would not tell us the
   * size cannot be streamed to a destination that insists on knowing it. The
   * bytes are buffered in that case, which is why a source that reports its
   * sizes is worth having.
   */
  async putBlob(repository: string, digest: string, blob: BlobStream): Promise<void> {
    const session = await this.call(`/v2/${repository}/blobs/uploads/`, { method: "POST" });
    if (session.status !== 202) {
      throw new Error(`${this.name} refused an upload session: ${session.status}`);
    }

    const location = session.headers.get("Location");
    if (location === null) throw new Error(`${this.name} opened an upload with no Location`);

    let body: BodyInit;
    let size = blob.size;
    if (size < 0) {
      const buffered = new Uint8Array(await new Response(blob.body).arrayBuffer());
      size = buffered.length;
      body = buffered as unknown as BodyInit;
    } else {
      body = blob.body as unknown as BodyInit;
    }

    const upload = new URL(location, `${this.base}/`);
    upload.searchParams.set("digest", digest);

    const response = await this.call(upload.pathname + upload.search, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body,
    });
    if (!response.ok) {
      throw new Error(`${this.name} refused blob ${digest}: ${response.status} ${await response.text()}`);
    }
  }

  async listTags(repository: string): Promise<string[]> {
    const response = await this.call(`/v2/${repository}/tags/list?n=1000`);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`${this.name} answered ${response.status} listing tags`);

    const body = (await response.json()) as { tags?: string[] | null };
    return body.tags ?? [];
  }
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
