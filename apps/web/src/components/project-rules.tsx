import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CleanupPolicy,
  CleanupRule,
  NotificationPolicySummary,
  ReplicationRuleSummary,
} from "@registry/api-contract";
// The very engine the cron will run the filter with, so a pattern this form
// accepts is one the scheduled cleanup accepts.
import { isValidRegex } from "@registry/regex";
import { parseRange } from "@registry/semver";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Switch } from "@workspace/ui/components/switch";
import { toast } from "@workspace/ui/components/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { ApiError, api } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A failed delivery or run is the thing worth noticing, so it is the thing that is coloured. */
function StatusBadge({ ok, children }: { ok: boolean; children: string }) {
  return <Badge variant={ok ? "secondary" : "destructive"}>{children}</Badge>;
}

/** A history table that renders nothing at all rather than an empty frame. */
function History({
  title,
  rows,
  head,
  children,
}: {
  title: string;
  rows: number;
  head: readonly string[];
  children: React.ReactNode;
}) {
  if (rows === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((column) => (
              <TableHead key={column}>{column}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/** Cleanup, notifications and replication share a home; each lists what exists and adds to it. */
export function ProjectRules({ name }: { name: string }) {
  return (
    <div className="space-y-6">
      <CleanupCard name={name} />
      <NotificationsCard name={name} />
      <ReplicationCard name={name} />
    </div>
  );
}

function CleanupCard({ name }: { name: string }) {
  const { data } = useQuery({ queryKey: ["cleanup", name], queryFn: () => api.cleanupPolicy(name) });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cleanup</CardTitle>
        <CardDescription>
          A rule governs a set of tags and says how many to keep. A tag no rule governs is never touched, so a
          filter that matches nothing deletes nothing.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <CleanupEditor name={name} policy={data} />
        )}
      </CardContent>
    </Card>
  );
}

/** In UTC, and at three in the morning, which is when the registry is quietest. */
const SCHEDULES = [
  { label: "Daily", cron: "0 3 * * *" },
  { label: "Weekly", cron: "0 3 * * 0" },
  { label: "Monthly", cron: "0 3 1 * *" },
] as const;

/** How a rule picks the tags it governs. Exactly one, because more is a puzzle. */
type FilterMode = "all" | "pattern" | "regex" | "semver";

const FILTER_LABELS: Readonly<Record<FilterMode, string>> = {
  all: "Every tag",
  pattern: "Glob pattern",
  regex: "Regular expression",
  semver: "Semver range",
};

const FILTER_HINTS: Readonly<Record<FilterMode, string>> = {
  all: "Every tag in the matched repositories is governed by this rule.",
  pattern: "Anchored at both ends. `*` matches any run of characters, `?` exactly one.",
  regex: "Searched, not anchored: `rc` finds `v1-rc1`. Use `^` and `$` to demand the whole tag.",
  semver: "A range such as `^1.2.3`, `>=1.0.0 <2.0.0`, or `1.x`. A tag that is not a version never matches.",
};

const FILTER_PLACEHOLDERS: Readonly<Record<FilterMode, string>> = {
  all: "",
  pattern: "release-*",
  regex: "^v\\d+\\.\\d+\\.\\d+$",
  semver: "^1.2.3",
};

function modeOf(rule: CleanupRule | undefined): FilterMode {
  if (rule === undefined) return "all";
  if (rule.tags.regex !== undefined && rule.tags.regex !== "") return "regex";
  if (rule.tags.semver !== undefined && rule.tags.semver !== "") return "semver";
  if (rule.tags.pattern !== undefined && rule.tags.pattern !== "") return "pattern";
  return "all";
}

function valueOf(rule: CleanupRule | undefined, mode: FilterMode): string {
  if (rule === undefined || mode === "all") return "";
  return rule.tags[mode] ?? "";
}

/**
 * Why the filter will not be accepted, or null.
 *
 * Checked here with the very engine the registry will run it with, so a pattern
 * this form accepts is one the cron will accept. The server checks it again -
 * this is a courtesy, not a control.
 *
 * An empty filter is not an error here: the field is `required`, and letting the
 * browser say so beats disabling the save button with no explanation.
 */
function filterError(mode: FilterMode, value: string): string | null {
  if (value === "") return null;
  if (mode === "regex" && !isValidRegex(value)) return "Not a regular expression this registry can run.";
  if (mode === "semver" && parseRange(value) === null) return "Not a semver range.";
  return null;
}

/**
 * Mounted only once the policy has loaded, so the form's initial state is the
 * stored state. A later refetch updates what is reported above the form without
 * overwriting whatever the operator has since typed into it.
 */
function CleanupEditor({ name, policy }: { name: string; policy: CleanupPolicy }) {
  const queryClient = useQueryClient();
  const stored = policy.rules[0];

  const [schedule, setSchedule] = useState(policy.schedule);
  const [repositories, setRepositories] = useState(stored?.repositories ?? "*");
  const [mode, setMode] = useState<FilterMode>(modeOf(stored));
  const [filter, setFilter] = useState(valueOf(stored, modeOf(stored)));
  const [includePrerelease, setIncludePrerelease] = useState(stored?.tags.includePrerelease ?? false);
  const [keepBy, setKeepBy] = useState<"updated" | "semver">(stored?.keepBy ?? "updated");
  const [keepLast, setKeepLast] = useState(String(stored?.keepLast ?? 10));
  const [keepWithinDays, setKeepWithinDays] = useState(
    stored?.keepWithinDays === null || stored?.keepWithinDays === undefined
      ? ""
      : String(stored.keepWithinDays),
  );

  const problem = filterError(mode, filter);

  const save = useMutation({
    mutationFn: (input: Pick<CleanupPolicy, "enabled" | "schedule" | "rules">) =>
      api.setCleanupPolicy(name, { ...input, untaggedOlderThanDays: policy.untaggedOlderThanDays }),
    onSuccess: (saved) => {
      toast.success(saved.enabled ? "Cleanup schedule saved" : "Cleanup disabled");
      void queryClient.invalidateQueries({ queryKey: ["cleanup", name] });
    },
    onError: (error) => toast.error(message(error, "Could not save")),
  });

  const tagsOf = (): CleanupRule["tags"] => {
    if (mode === "all") return {};
    if (mode === "pattern") return { pattern: filter };
    if (mode === "regex") return { regex: filter };
    return { semver: filter, includePrerelease };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch
          id="cleanup-enabled"
          checked={policy.enabled}
          disabled={save.isPending}
          // Toggling preserves what is stored rather than what is typed: this is
          // the on/off switch for the saved policy, not a second save button.
          onCheckedChange={(enabled) =>
            save.mutate({ enabled, schedule: policy.schedule, rules: policy.rules })
          }
        />
        <Label htmlFor="cleanup-enabled" className="text-sm font-normal">
          Enabled
        </Label>
      </div>

      <p className="text-sm text-muted-foreground">
        {/* Only `enabled` decides whether cleanup runs, so only `enabled` may say
            that it does not: an enabled policy whose next run is somehow unset is
            still armed, and reporting it as off would be a lie. */}
        {!policy.enabled
          ? "Cleanup is off."
          : policy.nextRunAt === null
            ? "Cleanup is on."
            : `Next run ${formatRelativeTime(policy.nextRunAt)}.`}{" "}
        {policy.lastRunAt !== null &&
          `Last run ${formatRelativeTime(policy.lastRunAt)}${
            policy.lastResult === null
              ? ""
              : `, removing ${plural(policy.lastResult.tagsRemoved, "tag")} and ${plural(
                  policy.lastResult.untaggedRemoved,
                  "untagged manifest",
                )}`
          }.`}
      </p>

      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem !== null) return;
          save.mutate({
            // Saving the first rule turns cleanup on; saving a change to a policy
            // that was deliberately switched off leaves it off.
            enabled: policy.enabled || policy.rules.length === 0,
            schedule,
            rules: [
              {
                repositories: repositories === "" ? "*" : repositories,
                tags: tagsOf(),
                keepLast: Number(keepLast) || null,
                keepWithinDays: Number(keepWithinDays) || null,
                keepBy,
              },
            ],
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="cron">Schedule (cron, UTC)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="cron"
              className="w-40 font-mono"
              placeholder="0 3 * * *"
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
            />
            {SCHEDULES.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant={schedule === preset.cron ? "secondary" : "outline"}
                size="sm"
                onClick={() => setSchedule(preset.cron)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Five fields: minute, hour, day of month, month, day of week.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="repositories">Repositories</Label>
            <Input
              id="repositories"
              className="font-mono"
              placeholder="*"
              value={repositories}
              onChange={(event) => setRepositories(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A glob over repository names in this project. `*` for all of them.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="filter-mode">Select tags by</Label>
            <Select value={mode} onValueChange={(next) => setMode(next as FilterMode)}>
              <SelectTrigger id="filter-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FILTER_LABELS) as FilterMode[]).map((option) => (
                  <SelectItem key={option} value={option}>
                    {FILTER_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{FILTER_HINTS[mode]}</p>
          </div>
        </div>

        {mode !== "all" && (
          <div className="space-y-2">
            <Label htmlFor="filter">{FILTER_LABELS[mode]}</Label>
            <Input
              id="filter"
              required
              className="font-mono"
              placeholder={FILTER_PLACEHOLDERS[mode]}
              value={filter}
              aria-invalid={problem !== null}
              onChange={(event) => setFilter(event.target.value)}
            />
            {problem !== null && <p className="text-xs text-destructive">{problem}</p>}
            {mode === "semver" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={includePrerelease}
                  onChange={(event) => setIncludePrerelease(event.target.checked)}
                />
                Include prereleases
              </label>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="keep">Keep newest</Label>
            <Input
              id="keep"
              type="number"
              min="0"
              placeholder="none"
              value={keepLast}
              onChange={(event) => setKeepLast(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="keep-by">Newest means</Label>
            <Select value={keepBy} onValueChange={(next) => setKeepBy(next as "updated" | "semver")}>
              <SelectTrigger id="keep-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated">Most recently pushed</SelectItem>
                <SelectItem value="semver">Highest version</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="keep-days">Keep within (days)</Label>
            <Input
              id="keep-days"
              type="number"
              min="0"
              placeholder="none"
              value={keepWithinDays}
              onChange={(event) => setKeepWithinDays(event.target.value)}
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          A governed tag survives if either rule keeps it. Keeping nothing on both grounds deletes every tag
          the filter matches.
        </p>

        <Button type="submit" disabled={save.isPending || problem !== null}>
          Save
        </Button>
      </form>
    </div>
  );
}

function NotificationsCard({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");

  const { data: policies } = useQuery({
    queryKey: ["notifications", name],
    queryFn: () => api.notifications(name),
  });
  const { data: deliveries } = useQuery({
    queryKey: ["deliveries", name],
    queryFn: () => api.deliveries(name),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["notifications", name] });
    void queryClient.invalidateQueries({ queryKey: ["deliveries", name] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createNotification(name, {
        name: "webhook",
        targetType: "webhook",
        target: url,
        eventTypes: ["PUSH_ARTIFACT", "DELETE_ARTIFACT"],
      }),
    onSuccess: (result) => {
      toast.success(result.secret === null ? "Webhook added" : `Webhook added. Secret: ${result.secret}`, {
        duration: 12_000,
      });
      setUrl("");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not add the webhook")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNotification(name, id),
    onSuccess: () => {
      toast.success("Webhook removed");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not remove the webhook")),
  });

  const named = (id: string): string => policies?.find((policy) => policy.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Webhook notifications</CardTitle>
        <CardDescription>
          Post a signed payload to an https endpoint on push and delete. The signing secret is shown once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="hook">Endpoint</Label>
            <Input
              id="hook"
              type="url"
              placeholder="https://example.com/hook"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || url === ""}>
            Add
          </Button>
        </form>

        {policies !== undefined && policies.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Events</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((policy: NotificationPolicySummary) => (
                <TableRow key={policy.id}>
                  <TableCell className="font-medium">{policy.name}</TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-xs">{policy.target}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {policy.eventTypes.join(", ")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete webhook ${policy.name}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(policy.id)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <History
          title="Recent deliveries"
          rows={deliveries?.length ?? 0}
          head={["Webhook", "Event", "Status", "When"]}
        >
          {(deliveries ?? []).map((delivery) => (
            <TableRow key={delivery.id}>
              <TableCell className="font-medium">{named(delivery.policyId)}</TableCell>
              <TableCell className="font-mono text-xs">{delivery.eventType}</TableCell>
              <TableCell>
                <StatusBadge ok={delivery.status === "delivered"}>
                  {delivery.responseStatus === null
                    ? delivery.status
                    : `${delivery.status} (${delivery.responseStatus})`}
                </StatusBadge>
                {delivery.error !== null && (
                  <span className="ml-2 text-xs text-muted-foreground">{delivery.error}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(delivery.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </History>
      </CardContent>
    </Card>
  );
}

function ReplicationCard({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [remote, setRemote] = useState("");

  const { data: rules } = useQuery({
    queryKey: ["replication", name],
    queryFn: () => api.replicationRules(name),
  });
  const { data: executions } = useQuery({
    queryKey: ["executions", name],
    queryFn: () => api.executions(name),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["replication", name] });
    void queryClient.invalidateQueries({ queryKey: ["executions", name] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.createReplicationRule(name, {
        name: "downstream",
        direction: "push",
        remoteUrl: remote,
        trigger: "event",
      }),
    onSuccess: () => {
      toast.success("Replication rule created");
      setRemote("");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not create the rule")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteReplicationRule(name, id),
    onSuccess: () => {
      toast.success("Replication rule removed");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not remove the rule")),
  });

  const run = useMutation({
    mutationFn: (id: string) => api.runReplicationRule(name, id),
    // The rule is queued, not run: the history fills in once the worker drains it.
    onSuccess: () => {
      toast.success("Queued. The run will appear in the history once it finishes.");
      void queryClient.invalidateQueries({ queryKey: ["executions", name] });
    },
    onError: (error) => toast.error(message(error, "Could not run the rule")),
  });

  const named = (id: string): string => rules?.find((rule) => rule.id === id)?.name ?? id.slice(0, 8);

  const busy = run.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Replication</CardTitle>
        <CardDescription>Push every tagged artifact to a downstream registry as it arrives.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex-1 space-y-2">
            <Label htmlFor="remote">Downstream registry</Label>
            <Input
              id="remote"
              type="url"
              placeholder="https://registry.example.com"
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || remote === ""}>
            Add
          </Button>
        </form>

        {rules !== undefined && rules.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Remote</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule: ReplicationRuleSummary) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">
                    {rule.name} <Badge variant="outline">{rule.direction}</Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-xs">{rule.remoteUrl}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {rule.trigger}
                    {rule.schedule !== null && ` (${rule.schedule})`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {rule.lastRunAt === null ? "never" : formatRelativeTime(rule.lastRunAt)}
                    {rule.lastResult !== null && `: ${rule.lastResult}`}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Run rule ${rule.name} now`}
                      disabled={busy}
                      onClick={() => run.mutate(rule.id)}
                    >
                      Run now
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete rule ${rule.name}`}
                      disabled={busy}
                      onClick={() => remove.mutate(rule.id)}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <History
          title="Recent runs"
          rows={executions?.length ?? 0}
          head={["Rule", "Repository", "Status", "Copied", "When"]}
        >
          {(executions ?? []).map((execution) => (
            <TableRow key={execution.id}>
              <TableCell className="font-medium">{named(execution.ruleId)}</TableCell>
              <TableCell className="font-mono text-xs">
                {execution.repository ?? "-"}
                {execution.reference !== null && `:${execution.reference}`}
              </TableCell>
              <TableCell>
                <StatusBadge ok={execution.status === "succeeded"}>{execution.status}</StatusBadge>
                {execution.error !== null && (
                  <span className="ml-2 text-xs text-muted-foreground">{execution.error}</span>
                )}
              </TableCell>
              <TableCell className="text-xs tabular-nums text-muted-foreground">
                {`${plural(execution.manifests, "manifest")}, ${plural(execution.blobs, "blob")}`}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(execution.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </History>
      </CardContent>
    </Card>
  );
}
