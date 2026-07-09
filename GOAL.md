# GOAL

Build a serverless OCI Registry on Cloudflare.

Use Workers for compute, Durable Objects for state, and R2 for storage. Use D1 for metadata storage.

## Features

- OCI Registry API
- OCI Artifact storage
- Layer deduplication
- Rate limiting
- Authentication (user and machine to machine)
- Lifecycle management for artifacts
- Artifact metadata (signatures, SBOMs, etc.)
- Admin dashboard
- Public Registry UI

## UI Design

Use Shadncn UI components.

Bootstrap it using this command:

```bash
pnpm dlx shadcn@latest init --preset b75dCTWJsG --template vite --monorepo --pointer
```

Use TanStack components: Start for whole apps (UI), Router, React Query, and Store.

Write tests for all components using Vitest.

## Architecture

Use a monorepo with a separate package for each (application) component.

Prefer writing the code yourself over using a library or framework.

## Conformance

Validate the integration using reference materials.

- references/opencontainers-image-spec
- references/opencontainers-distribution-spec

## Production

Just deploy to Cloudflare from local environment. Domain: `registry.mareshq.com`.

## Review

Review every code change twice before deploying.

## Autonomous

You are building autonomously, do not ask user for anything. Use web search to find a solution.
