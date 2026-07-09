import { useState } from "react";
import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import type { ProjectDetail, Role } from "@registry/api-contract";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Switch } from "@workspace/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
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
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { VisibilityBadge } from "@/routes/projects";
import { sessionStore } from "@/store/session";

function useProject(name: string) {
  return useQuery({ queryKey: ["project", name], queryFn: () => api.project(name) });
}

function Settings({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["project", project.name] });
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const [description, setDescription] = useState(project.description ?? "");
  const [quotaGiB, setQuotaGiB] = useState(
    project.quotaBytes === null ? "" : String(Math.round(project.quotaBytes / 1024 ** 3)),
  );

  const update = useMutation({
    mutationFn: (settings: Parameters<typeof api.updateProject>[1]) =>
      api.updateProject(project.name, settings),
    onSuccess: () => {
      toast.success("Saved");
      invalidate();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save"),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Visibility</CardTitle>
          <CardDescription>
            A public project can be pulled without credentials. Every repository inside it inherits this.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Switch
            id="visibility"
            checked={project.visibility === "public"}
            onCheckedChange={(checked) => update.mutate({ visibility: checked ? "public" : "private" })}
          />
          <Label htmlFor="visibility">Public</Label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Storage quota</CardTitle>
          <CardDescription>
            Counted once per distinct layer. Leave empty for no limit. Currently using{" "}
            {formatBytes(project.usedBytes)}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const gib = quotaGiB.trim();
              update.mutate({ quotaBytes: gib === "" ? null : Math.round(Number(gib) * 1024 ** 3) });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="quota">Quota (GiB)</Label>
              <Input
                id="quota"
                type="number"
                min="0"
                step="1"
                className="w-40"
                placeholder="unlimited"
                value={quotaGiB}
                onChange={(event) => setQuotaGiB(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signature rules</CardTitle>
          <CardDescription>
            Require cosign or notation signatures. Enforced at the tag on push, and at the manifest on pull.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id="sig-push"
              checked={project.requireSignaturePush}
              onCheckedChange={(checked) => update.mutate({ requireSignaturePush: checked })}
            />
            <Label htmlFor="sig-push" className="text-sm font-normal">
              Require a signature to tag an artifact
            </Label>
          </div>
          <div className="flex items-center gap-3">
            <Switch
              id="sig-pull"
              checked={project.requireSignaturePull}
              onCheckedChange={(checked) => update.mutate({ requireSignaturePull: checked })}
            />
            <Label htmlFor="sig-pull" className="text-sm font-normal">
              Require a signature to pull an artifact
            </Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate({ description: description === "" ? null : description });
            }}
          >
            <Input
              className="flex-1"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this project holds"
            />
            <Button type="submit" variant="outline" disabled={update.isPending}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

const ROLES: Role[] = ["guest", "developer", "maintainer", "owner"];

function Members({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["project", project.name] });

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.setMember(project.name, userId, role),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not update the member"),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(project.name, userId),
    onSuccess: invalidate,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : "Could not remove the member"),
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {project.members.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
              No explicit members. The project owner and administrators still have access.
            </TableCell>
          </TableRow>
        ) : (
          project.members.map((member) => (
            <TableRow key={member.userId}>
              <TableCell className="font-medium">{member.username}</TableCell>
              <TableCell>
                <select
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  value={member.role}
                  onChange={(event) =>
                    setRole.mutate({ userId: member.userId, role: event.target.value as Role })
                  }
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              </TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(member.userId)}>
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function Usage({ name }: { name: string }) {
  const { data, isPending } = useQuery({
    queryKey: ["project-stats", name],
    queryFn: () => api.projectStats(name, 30),
  });

  if (isPending || data === undefined) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pulls (30 days)</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{data.totals.pulls}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pushes (30 days)</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{data.totals.pushes}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Storage</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{formatBytes(data.storageBytes)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {data.repositories !== undefined && data.repositories.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead className="text-right">Pulls</TableHead>
              <TableHead className="text-right">Pushes</TableHead>
              <TableHead className="text-right">Storage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.repositories.map((repo) => (
              <TableRow key={repo.repository}>
                <TableCell>
                  <Link
                    to="/r/$"
                    params={{ _splat: repo.repository }}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {repo.repository}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">{repo.pulls}</TableCell>
                <TableCell className="text-right tabular-nums">{repo.pushes}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBytes(repo.sizeBytes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ProjectPage() {
  const name = projectDetailRoute.useParams().name;
  const { user } = useStore(sessionStore);
  const { data, isPending, error } = useProject(name);

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error !== null || data === undefined) {
    return <p className="text-sm text-destructive">Could not load {name}.</p>;
  }

  const owns = user?.isAdmin === true || data.role === "owner" || user?.username === name;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <VisibilityBadge visibility={data.visibility} />
          </div>
          {data.description !== null && (
            <p className="mt-1 text-sm text-muted-foreground">{data.description}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {data.repositories} repositories · {formatBytes(data.usedBytes)}
            {data.quotaBytes !== null ? ` of ${formatBytes(data.quotaBytes)}` : ""} · updated{" "}
            {formatRelativeTime(data.updatedAt)}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/" search={{ project: name }}>
            Repositories
          </Link>
        </Button>
      </div>

      <Tabs defaultValue="usage">
        <TabsList>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          {owns && <TabsTrigger value="settings">Settings</TabsTrigger>}
          {owns && <TabsTrigger value="members">Members</TabsTrigger>}
          {owns && <TabsTrigger value="rules">Rules</TabsTrigger>}
        </TabsList>

        <TabsContent value="usage" className="pt-4">
          <Usage name={name} />
        </TabsContent>

        {owns && (
          <TabsContent value="settings" className="pt-4">
            <Settings project={data} />
          </TabsContent>
        )}
        {owns && (
          <TabsContent value="members" className="pt-4">
            <Members project={data} />
          </TabsContent>
        )}
        {owns && (
          <TabsContent value="rules" className="pt-4">
            <ProjectRules name={name} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/** Cleanup, notifications and replication share a home; each is a compact editor. */
function ProjectRules({ name }: { name: string }) {
  return (
    <div className="space-y-6">
      <CleanupCard name={name} />
      <NotificationsCard name={name} />
      <ReplicationCard name={name} />
    </div>
  );
}

function CleanupCard({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["cleanup", name], queryFn: () => api.cleanupPolicy(name) });
  const [schedule, setSchedule] = useState("0 3 * * *");
  const [keepLast, setKeepLast] = useState("10");

  const save = useMutation({
    mutationFn: () =>
      api.setCleanupPolicy(name, {
        enabled: true,
        schedule,
        untaggedOlderThanDays: null,
        rules: [
          {
            repositories: "*",
            tags: {},
            keepLast: Number(keepLast) || null,
            keepWithinDays: null,
          },
        ],
      }),
    onSuccess: () => {
      toast.success("Cleanup schedule saved");
      void queryClient.invalidateQueries({ queryKey: ["cleanup", name] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cleanup</CardTitle>
        <CardDescription>
          Keep the newest N tags in every repository on a schedule.{" "}
          {data?.nextRunAt != null && `Next run ${formatRelativeTime(data.nextRunAt)}.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="cron">Schedule (cron, UTC)</Label>
            <Input
              id="cron"
              className="w-40 font-mono"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="keep">Keep newest</Label>
            <Input
              id="keep"
              type="number"
              min="1"
              className="w-28"
              value={keepLast}
              onChange={(e) => setKeepLast(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NotificationsCard({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createNotification(name, {
        name: "webhook",
        targetType: "webhook",
        target: url,
        eventTypes: ["PUSH_ARTIFACT", "DELETE_ARTIFACT"],
      }),
    onSuccess: (result) => {
      toast.success(
        result.secret === undefined ? "Webhook added" : `Webhook added. Secret: ${result.secret}`,
        {
          duration: 12_000,
        },
      );
      setUrl("");
      void queryClient.invalidateQueries({ queryKey: ["notifications", name] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not add the webhook"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Webhook notifications</CardTitle>
        <CardDescription>
          Post a signed payload to an https endpoint on push and delete. The signing secret is shown once.
        </CardDescription>
      </CardHeader>
      <CardContent>
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
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || url === ""}>
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ReplicationCard({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [remote, setRemote] = useState("");

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
      void queryClient.invalidateQueries({ queryKey: ["replication", name] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not create the rule"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Replication</CardTitle>
        <CardDescription>Push every tagged artifact to a downstream registry as it arrives.</CardDescription>
      </CardHeader>
      <CardContent>
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
              onChange={(e) => setRemote(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || remote === ""}>
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$name",
  component: ProjectPage,
});
