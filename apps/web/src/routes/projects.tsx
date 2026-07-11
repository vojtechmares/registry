import { useState } from "react";
import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidate, keys } from "@/lib/queries";
import { useStore } from "@tanstack/react-store";
import type { ProjectSummary, Visibility } from "@registry/api-contract";
import { Badge } from "@registry/ui/components/badge";
import { Button } from "@registry/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@registry/ui/components/card";
import { Input } from "@registry/ui/components/input";
import { Label } from "@registry/ui/components/label";
import { Skeleton } from "@registry/ui/components/skeleton";
import { toast } from "@registry/ui/components/sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@registry/ui/components/table";
import { ApiError, api } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { sessionStore } from "@/store/session";

function quotaLabel(project: ProjectSummary): string {
  if (project.quotaBytes === null) return formatBytes(project.usedBytes);
  const percent = project.quotaBytes === 0 ? 100 : Math.round((project.usedBytes / project.quotaBytes) * 100);
  return `${formatBytes(project.usedBytes)} / ${formatBytes(project.quotaBytes)} (${percent}%)`;
}

function CreateProject() {
  const { user } = useStore(sessionStore);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api.createProject({ name }),
    onSuccess: (project) => {
      toast.success(`Created ${project.name}`);
      setName("");
      invalidate.projects(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : "Could not create the project");
    },
  });

  if (user === null) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New project</CardTitle>
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
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              placeholder={user.isAdmin ? "acme" : user.username}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={create.isPending || name === ""}>
            Create
          </Button>
        </form>
        {!user.isAdmin && (
          <p className="mt-2 text-xs text-muted-foreground">
            You may create the project named after you. An administrator can create any other.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function Projects() {
  const { user } = useStore(sessionStore);
  const { data, isPending } = useQuery({ queryKey: keys.projects(), queryFn: api.projects });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every repository lives in a project. The project decides visibility, quota, and rules.
        </p>
      </div>

      {user !== null && <CreateProject />}

      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : data === undefined || data.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No projects yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead className="text-right">Repositories</TableHead>
              <TableHead className="text-right">Storage</TableHead>
              <TableHead className="w-36 text-right">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((project) => (
              <TableRow key={project.name}>
                <TableCell>
                  <Link
                    to="/projects/$name"
                    params={{ name: project.name }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {project.name}
                  </Link>
                  {project.role !== null && (
                    <Badge variant="outline" className="ml-2 text-xs">
                      {project.role}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <VisibilityBadge visibility={project.visibility} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{project.repositories}</TableCell>
                <TableCell className="text-right tabular-nums">{quotaLabel(project)}</TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatRelativeTime(project.updatedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return <Badge variant={visibility === "public" ? "secondary" : "outline"}>{visibility}</Badge>;
}

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: Projects,
});
