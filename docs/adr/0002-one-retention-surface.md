# One retention surface: cleanup policies absorb lifecycle policies

The registry had two retention engines: per-project `cleanup_policies` (cron + rules, evaluated by `@registry/retention`) and per-repository `lifecycle_policies` (`keep_last_tags`, `untagged_ttl_days`, reimplemented in SQL). We migrate to the single per-project surface and delete the per-repository table, API routes and dashboard form.

Two constraints shaped the migration, and both would be re-discovered the hard way by anyone reversing it:

- Per-repo untagged TTLs cannot collapse to the project-level `untagged_older_than_days` column: the project sweep covers every repository in the project, so promoting one repository's TTL would start deleting untagged manifests in sibling repositories that never opted in.
- Therefore `CleanupRule` became a discriminated union - `{kind: "tags", ...}` (default when `kind` is absent, so existing JSON rows keep meaning what they meant) and `{kind: "untagged", repositories, olderThanDays}` - and the project-level column itself folds into a `repositories: "*"` untagged rule and is dropped. Untagged TTL has exactly one home.

Converted rules use `keepBy: "updated"`, preserving the old engine's `ORDER BY updated_at DESC` semantics. A converted policy joins the project's existing cleanup policy when one exists; its rules then run on that policy's schedule rather than the old nightly cron - a documented behaviour change. The safety stance is unchanged and now uniform: what no rule governs is never touched.
