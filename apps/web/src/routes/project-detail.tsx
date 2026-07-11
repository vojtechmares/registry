import { useState } from "react";
import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidate, keys } from "@/lib/queries";
import { useStore } from "@tanstack/react-store";
import type { ProjectDetail } from "@registry/api-contract";
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
import { ProjectMembers } from "@/components/project-members";
import { ProjectRules } from "@/components/project-rules";
import { ProjectTokens } from "@/components/project-tokens";
import { ApiError, api } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { VisibilityBadge } from "@/routes/projects";
import { sessionStore } from "@/store/session";

function useProject(name: string) {
  return useQuery({ queryKey: keys.project(name), queryFn: () => api.project(name) });
}

function Settings({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();

  const [description, setDescription] = useState(project.description ?? "");
  const [quotaGiB, setQuotaGiB] = useState(
    project.quotaBytes === null ? "" : String(Math.round(project.quotaBytes / 1024 ** 3)),
  );

  const update = useMutation({
    mutationFn: (settings: Parameters<typeof api.updateProject>[1]) =>
      api.updateProject(project.name, settings),
    onSuccess: () => {
      toast.success("Saved");
      invalidate.project(queryClient, project.name);
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
          <CardTitle className="text-base">Immutable tags</CardTitle>
          <CardDescription>
            A tag names one digest, for good. It cannot be moved, deleted, or retired by a cleanup rule.
            Pushing the digest a tag already names still succeeds, so a CI job that reruns does not fail.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="immutable-tags"
              checked={project.immutableTags}
              onCheckedChange={(checked) => update.mutate({ immutableTags: checked })}
            />
            <Label htmlFor="immutable-tags" className="text-sm font-normal">
              Enforce immutable tags
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

function Usage({ name }: { name: string }) {
  const { data, isPending } = useQuery({
    queryKey: keys.projectStats(name),
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

export function ProjectPage({ name }: { name: string }) {
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
          {owns && <TabsTrigger value="tokens">Tokens</TabsTrigger>}
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
            <ProjectMembers project={data} />
          </TabsContent>
        )}
        {owns && (
          <TabsContent value="rules" className="pt-4">
            <ProjectRules name={name} />
          </TabsContent>
        )}
        {owns && (
          <TabsContent value="tokens" className="pt-4">
            <ProjectTokens project={name} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$name",
  component: function ProjectDetailRoute() {
    return <ProjectPage name={projectDetailRoute.useParams().name} />;
  },
});
