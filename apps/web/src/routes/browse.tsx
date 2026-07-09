import { useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { RepositoryTable } from "@/components/repository-table";
import { api } from "@/lib/api";
import { rootRoute } from "@/routes/root";

function Browse() {
  const [search, setSearch] = useState("");
  const { data, isPending, error } = useQuery({
    queryKey: ["repositories", search],
    queryFn: () => api.repositories(search),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anyone can pull from a public repository. Sign in to see your own.
        </p>
      </div>

      <div className="relative max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter repositories"
          aria-label="Filter repositories"
          className="pl-9"
        />
      </div>

      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error !== null ? (
        <p className="text-sm text-destructive">Could not load repositories.</p>
      ) : (
        <RepositoryTable repositories={data} />
      )}
    </div>
  );
}

export const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Browse,
});
