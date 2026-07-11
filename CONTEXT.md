# Registry

A serverless OCI registry on Cloudflare (Workers, Durable Objects, R2, D1) with a project/tenant layer, a management API, and a dashboard. This glossary names the concepts the code is organised around; architecture reviews and refactors should use these terms.

## Access

**Project**:
The tenant unit. A repository's first path segment is its project; a single-segment repository is its own project.
_Avoid_: namespace, org, tenant

**Access decision**:
The pure allow/challenge/deny ruling (`decideAccess`) applied to one action on one repository. The 401-vs-403 distinction is load-bearing for docker clients. There is exactly one implementation.
_Avoid_: permission check, ACL

**Audience**:
Who a listing is rendered for: the viewer identity plus the token project pin. Constructed only by `audienceOf(principal)`, consumed by the visibility module. Distinct from the access decision - listings show existence, the access decision governs actions.
_Avoid_: viewer (alone), caller

**Visibility module**:
The single module that answers "which projects and repositories may this audience see" - as one SQL filter and one predicate, agreement-tested against each other. Listing paths never restate the rule.
_Avoid_: visibility filter (for the module itself)

**Pin**:
The project a machine token is confined to. A pinned token sees and reaches nothing outside its project, whatever its scopes say.
_Avoid_: token project (when the confinement is meant)

## Retention

**Cleanup policy**:
The one per-project retention surface: a cron schedule plus rules. After the lifecycle migration there is no per-repository policy table.

**Rule**:
One entry in a cleanup policy, scoped by a repository glob. Two kinds: a **tags rule** (governs tags, says how many to keep and by which order) and an **untagged rule** (retires untagged manifests older than a TTL). What no rule governs is never touched.
_Avoid_: lifecycle policy, retention setting

**Retention executor**:
The single Worker module that enumerates due cleanup policies, asks `@registry/retention` what is doomed, retires through the one deletion path, and records lifecycle events (always with the project set).
_Avoid_: cleanup engine, lifecycle runner

**Lifecycle event**:
The audit record of one retirement (tag or manifest), attributed to its project. Written by the retention executor and the garbage collector only.

## Notifications

**Notification event**:
What a recipient is told the registry did. Born inside `@registry/notifications` via per-type constructors - an event type without a constructor cannot exist. Six types: push, pull, delete, quota-exceeded, replication, cleanup.
_Avoid_: webhook payload (that is its serialisation)

**Event constructor**:
The package function that is the only way to create a notification event of its type. The Worker adapts registry activity to constructor calls; it never assembles an event by hand.

## Contract

**Contract**:
`@registry/api-contract`: the runtime-free package declaring every request and response shape of the management API. Both the Worker and the web app import it type-only; the valibot schemas are pinned to it by compile-time guards in both directions for requests, one direction for responses.
_Avoid_: shared types, DTOs

**Problem details**:
The RFC 7807 error shape every management-API refusal uses, including per-field `errors`. The web client decodes it in one place and surfaces field errors to forms.
