# registry

A serverless OCI registry on Cloudflare. Workers for compute, R2 for blob
storage, D1 for metadata, and Durable Objects for upload sessions and rate
limiting. It passes the official OCI distribution-spec conformance suite and
serves `docker`, `crane`, and `oras`.

Inspired by [cloudflare/serverless-registry](https://github.com/cloudflare/serverless-registry).

## Layout

A pnpm workspace, one package per concern.

| Package                  | What it holds                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/oci`           | Spec primitives with no dependencies: a resumable SHA-256, digest and repository-name validation, manifest parsing, error codes.                                      |
| `packages/registry-core` | The whole `/v2` distribution API, written against storage interfaces (ports) rather than any platform. This is where the spec lives, and where most of the tests run. |
| `packages/api-contract`  | Types shared by the management API and the dashboard.                                                                                                                 |
| `packages/ui`            | Shared shadcn/ui component library.                                                                                                                                   |
| `apps/registry`          | The Cloudflare Worker: R2, D1, and Durable Object adapters for the core's ports, plus authentication, rate limiting, lifecycle, and the management API.               |
| `apps/web`               | The dashboard and public browse UI (TanStack Router/Query/Store, Vite).                                                                                               |

The split is deliberate: `registry-core` never imports a Cloudflare type, so the
distribution logic is exercised end to end against in-memory stores in
milliseconds, and the Worker's adapters stay thin enough that the conformance
suite is the only thing that needs real infrastructure.

## Features

- Full OCI distribution API: pull, push (monolithic, streamed, chunked),
  cross-repository mount, tag listing with pagination, the referrers API, and
  deletion.
- Layer deduplication: identical content is stored once and linked from each
  repository that references it.
- Authentication: password (PBKDF2) and machine-to-machine tokens, with the
  Docker bearer-token flow and scoped permissions.
- Rate limiting via a Durable Object token bucket, priced so credential checking
  cannot be used to amplify load.
- Lifecycle management and refcounted garbage collection on a nightly cron.
- Per-project immutable tags: a tag names one digest, and neither a push, a
  delete, nor a cleanup rule may change that.
- Cleanup rules that select tags by glob, semver range, or regular expression,
  matched by an engine that cannot backtrack.
- Admin dashboard and public registry UI.

## Development

```bash
pnpm install
pnpm --filter @registry/worker db:migrate:local   # set up the local D1 database
pnpm dev                                           # wrangler dev on :8787
```

Point a client at it (the dev server treats localhost as insecure):

```bash
crane copy --insecure alpine 127.0.0.1:8787/library/alpine:latest
```

## Testing

```bash
pnpm test          # unit and integration tests across every package
pnpm conformance   # the official OCI suite against a live wrangler dev
```

`pnpm conformance` builds the upstream Go conformance binary and runs all four
workflow categories (pull, push, content discovery, content management) against
the Worker on Miniflare.

## Deployment

```bash
# One-time, per environment:
wrangler r2 bucket create registry-content
wrangler d1 create registry                        # copy the id into wrangler.jsonc
pnpm --filter @registry/worker db:migrate:remote
node scripts/hash-password.mjs '<admin password>'  # -> BOOTSTRAP_ADMIN_PASSWORD_HASH
wrangler secret put JWT_SECRET --env production
wrangler secret put BOOTSTRAP_ADMIN_USERNAME --env production
wrangler secret put BOOTSTRAP_ADMIN_PASSWORD_HASH --env production

pnpm --filter @registry/web build
pnpm deploy
```

Production is served at `registry.mareshq.com`.

## Configuration

Worker behaviour is set through `vars` in `wrangler.jsonc`:

| Variable                       | Default | Meaning                                                                              |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------ |
| `ALLOW_ANONYMOUS_PULL`         | `true`  | Serve public repositories without credentials.                                       |
| `ENABLE_DELETES`               | `true`  | Allow blob and manifest deletion.                                                    |
| `VALIDATE_BLOB_REFERENCES`     | `true`  | Reject a manifest whose config or layers are absent.                                 |
| `VALIDATE_MANIFEST_REFERENCES` | `false` | Reject an index whose children are absent (off: clients push in any order).          |
| `AUTOMATIC_CROSS_MOUNT`        | `true`  | Mount a blob without `from`, but only from a repository the caller can already pull. |
| `RATE_LIMIT_IP_RPM`            | `1200`  | Per-source-address request budget.                                                   |
| `RATE_LIMIT_USER_RPM`          | `3000`  | Per-principal request budget.                                                        |
| `UNTAGGED_MANIFEST_TTL_DAYS`   | `0`     | Retire untagged manifests older than this (0 disables).                              |

Secrets (`JWT_SECRET`, `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD_HASH`)
are set with `wrangler secret put`.

## Known limitations

Found during review and deliberately deferred, not defects that corrupt data or
leak access:

- **Replication does not copy an artifact's signatures.** `copyArtifact` walks
  config, layers, and index children, not referrers, so a replicated image
  arrives unsigned. Replicating _into_ a project that requires signatures on
  push therefore fails at the destination (loudly, recorded as a failed
  execution) rather than silently. Pulling from Docker Hub and pushing to a
  permissive downstream mirror both work.
- **Untagged retirement measures age from push time, not from when the tag was
  removed.** A manifest older than the TTL is retired the moment it becomes
  untagged, so the grace period is not a grace period for old images. This
  matches the pre-existing nightly lifecycle job; both would need an
  "untagged-since" timestamp to honour the window.
- **An immutable tag can still be lost to a concurrent delete.** The push path
  restates its check in the `tagManifest` upsert, so two simultaneous pushes
  cannot silently overwrite each other. The delete path has no such backstop:
  `beforeTagDelete` reads the tag, finds nothing, and permits the delete, while
  a concurrent push creates it. Guarding the `DELETE` the same way is not enough
  either, because `deleteManifest` removes the manifest and its tags in one
  batch, and suppressing half of that batch would leave a tag pointing at a
  manifest that no longer exists. It needs a transaction, which D1 does not give
  a Worker across statements. Every sequential delete is refused.
- **The 0004 migration moved per-repository grants to per-project membership.**
  That is the intended model - a project has members, not per-repository ACLs -
  but a pre-existing grant on one repository becomes access to its whole
  project. It matters only for a registry that already had heterogeneous
  per-repository grants before the migration.
