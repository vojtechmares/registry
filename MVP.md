# MVP

Let's finish the MVP. To do that, I want additional features.

## Features

- Registry / project: path based segmentation
- Project scoped tokens
- Project storage quotas
- Project user membership
- Project notifications: webhooks, email notifications
- Project push to downstream registry (replication rules)
- Project subscriptions: copy artifacts from other registries (e.g. Docker Hub) (replication rules)
- Project public/private visibility settings
- For replication rules, support tag Semantic Versioning for filtering
- Rule to require signatures for OCI artifacts for pushing
- Cron based cleanup workflows
- Rule to require signatures for OCI artifacts for pulling (pull from registry is blocked when artifact is not signed)
- Correctly handled migrations (do not handroll them)
- Add oxlint and oxfmt for code linting and formatting (code quality)
- Add conformance CI pipeline to continuously test against the registry
- Stats per project and per iamge (pulls, pushes, storage usage)
- OIDC login (SSO)

## Architecture

Use a monorepo with a separate package for each (application) component.

Prefer writing the code yourself over using a library or framework.

## Conformance

Validate the integration using reference materials.

- references/opencontainers-image-spec
- references/opencontainers-distribution-spec

## Production

Use GitHub Actions for CI/CD to do the heavy lifting. Do not run tasks (like database migrations) locally. And/or write a Worker to run tasks in the background, either using cron or queue.

## Review

Review every code change twice before deploying.

- Security review: Review every code change for security vulnerabilities.
- Correctness review: Review every code change for correctness.

Follow TDD when writing code. Either for a feature or a bug fix.

## Autonomous

You are building autonomously, do not ask user for anything. Use web search to find a solution.

Commit often, push sometimes.

Always check the CI pipeline result before continuing.
