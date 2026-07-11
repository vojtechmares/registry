import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { keys } from "@/lib/queries";
import type { AuditEvent, AuditResourceType } from "@registry/api-contract";
import { Badge } from "@registry/ui/components/badge";
import { Button } from "@registry/ui/components/button";
import { Input } from "@registry/ui/components/input";
import { Label } from "@registry/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@registry/ui/components/select";
import { Skeleton } from "@registry/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@registry/ui/components/table";
import { api } from "@/lib/api";
import { formatDate, formatRelativeTime } from "@/lib/format";

const RESOURCE_TYPES = ["project", "repository", "artifact", "user", "token"] as const;

/** `all` is the absence of a filter, and a `Select` cannot hold an empty value. */
const ALL = "all";

/** Destructive actions read differently from the rest, and should. */
function actionVariant(action: string): "outline" | "destructive" {
  return action.endsWith(".delete") || action.endsWith(".revoke") || action.endsWith(".remove")
    ? "destructive"
    : "outline";
}

/** `{"role":"developer"}` reads better as `role=developer`. */
function summarise(detail: Record<string, unknown> | null): string {
  if (detail === null) return "";
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
}

function Actor({ event }: { event: AuditEvent }) {
  return (
    <div className="flex flex-col">
      <span>{event.actorName}</span>
      {event.actorKind === "token" && (
        <span className="font-mono text-xs text-muted-foreground" title={event.actorTokenId ?? undefined}>
          token {event.actorTokenId?.slice(0, 8)}
        </span>
      )}
      {event.actorKind === "anonymous" && <span className="text-xs text-muted-foreground">anonymous</span>}
    </div>
  );
}

/**
 * Who changed what, newest first.
 *
 * Paged by cursor rather than offset: rows arrive while the page is being read,
 * and an offset would silently skip whichever row the new one displaced.
 */
export function AuditLog() {
  const [resourceType, setResourceType] = useState<AuditResourceType | typeof ALL>(ALL);
  const [actor, setActor] = useState("");
  const [project, setProject] = useState("");

  const filters = {
    ...(resourceType === ALL ? {} : { resourceType }),
    ...(actor === "" ? {} : { actor }),
    ...(project === "" ? {} : { project }),
  };

  const { data, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: keys.audit(filters),
    queryFn: ({ pageParam }) => api.audit({ ...filters, ...(pageParam === "" ? {} : { cursor: pageParam }) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.cursor,
  });

  const events = data?.pages.flatMap((page) => page.events) ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-md border p-4 sm:grid-cols-[200px_1fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="audit-type">Resource</Label>
          <Select
            value={resourceType}
            onValueChange={(value) => setResourceType(value as AuditResourceType | typeof ALL)}
          >
            <SelectTrigger id="audit-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Everything</SelectItem>
              {RESOURCE_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="audit-actor">Actor</Label>
          <Input
            id="audit-actor"
            value={actor}
            placeholder="username"
            onChange={(event) => setActor(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="audit-project">Project</Label>
          <Input
            id="audit-project"
            value={project}
            placeholder="acme"
            onChange={(event) => setProject(event.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : events.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          Nothing recorded yet. Pulls are counted rather than audited.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">When</TableHead>
                <TableHead className="w-40">Actor</TableHead>
                <TableHead className="w-44">Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead className="w-32">Project</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="text-muted-foreground" title={formatDate(event.createdAt)}>
                    {formatRelativeTime(event.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Actor event={event} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={actionVariant(event.action)} className="font-mono text-xs">
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs break-all">{event.resource}</TableCell>
                  <TableCell className="text-muted-foreground">{event.project ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs break-all text-muted-foreground">
                    {summarise(event.detail)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
