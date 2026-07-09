import { Link, createRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import type { Visibility } from "@registry/api-contract";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { toast } from "@workspace/ui/components/sonner";
import { Switch } from "@workspace/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { Digest } from "@/components/digest";
import { PullCommand } from "@/components/pull-command";
import { api } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { sessionStore } from "@/store/session";

function Repository() {
  // A splat is optional as far as the router's types are concerned; an empty
  // repository name simply fails the lookup below.
  const name = repositoryRoute.useParams()._splat ?? "";
  const { user } = useStore(sessionStore);
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: ["repository", name],
    queryFn: () => api.repository(name),
  });

  const visibility = useMutation({
    mutationFn: (next: Visibility) => api.setVisibility(name, next),
    onSuccess: (result) => {
      toast.success(`${name} is now ${result.visibility}`);
      void queryClient.invalidateQueries({ queryKey: ["repository", name] });
      void queryClient.invalidateQueries({ queryKey: ["repositories"] });
    },
    onError: () => toast.error("Could not change visibility"),
  });

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error !== null) {
    return <p className="text-sm text-destructive">Could not load {name}.</p>;
  }

  // Only someone who may change the repository is shown the control at all.
  const canAdminister = user?.isAdmin === true || (user !== null && name.startsWith(`${user.username}/`));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{name}</h1>
          <div className="mt-2 flex items-center gap-3 text-sm text-muted-foreground">
            <Badge variant={data.visibility === "public" ? "secondary" : "outline"}>{data.visibility}</Badge>
            <span>{formatBytes(data.sizeBytes)}</span>
            <span>
              {data.tags.length} tag{data.tags.length === 1 ? "" : "s"}
            </span>
            <span>updated {formatRelativeTime(data.updatedAt)}</span>
          </div>
        </div>

        {canAdminister && (
          <div className="flex items-center gap-2">
            <Label htmlFor="visibility" className="text-sm">
              Public
            </Label>
            <Switch
              id="visibility"
              checked={data.visibility === "public"}
              disabled={visibility.isPending}
              onCheckedChange={(checked) => visibility.mutate(checked ? "public" : "private")}
            />
          </div>
        )}
      </div>

      {data.tags.length > 0 && data.tags[0] !== undefined && (
        <PullCommand repository={name} reference={data.tags[0].name} />
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Tags</h2>
        {data.tags.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
            No tags. The repository exists but nothing is tagged.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead>Digest</TableHead>
                <TableHead className="w-28 text-right">Size</TableHead>
                <TableHead className="w-36 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tags.map((tag) => (
                <TableRow key={tag.name}>
                  <TableCell>
                    <Link
                      to="/manifest"
                      search={{ repo: name, digest: tag.digest }}
                      className="font-mono font-medium underline-offset-4 hover:underline"
                    >
                      {tag.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Digest value={tag.digest} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatBytes(tag.sizeBytes)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatRelativeTime(tag.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {canAdminister && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Danger zone</h2>
          <DeleteRepository name={name} />
        </section>
      )}
    </div>
  );
}

function DeleteRepository({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteRepository(name),
    onSuccess: () => {
      toast.success(`Deleted ${name}`);
      void queryClient.invalidateQueries({ queryKey: ["repositories"] });
      window.location.assign("/");
    },
    onError: () => toast.error("Could not delete the repository"),
  });

  return (
    <div className="flex items-center justify-between rounded-md border border-destructive/30 px-4 py-3">
      <div className="text-sm">
        <p className="font-medium">Delete this repository</p>
        <p className="text-muted-foreground">
          Tags and manifests go immediately. The content itself is reclaimed once nothing else references it.
        </p>
      </div>
      <Button
        variant="destructive"
        size="sm"
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`Delete ${name}? This cannot be undone.`)) remove.mutate();
        }}
      >
        Delete
      </Button>
    </div>
  );
}

export const repositoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  // A repository name contains slashes, so it must be a splat.
  path: "/r/$",
  component: Repository,
});
