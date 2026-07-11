import { useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/queries";
import { SearchIcon } from "lucide-react";
import { Input } from "@registry/ui/components/input";
import { Skeleton } from "@registry/ui/components/skeleton";
import { RepositoryTable } from "@/components/repository-table";
import { api } from "@/lib/api";
import { rootRoute } from "@/routes/root";

const LOGO = [
  "██████╗ ███████╗ ██████╗ ██╗███████╗████████╗██████╗ ██╗   ██╗",
  "██╔══██╗██╔════╝██╔════╝ ██║██╔════╝╚══██╔══╝██╔══██╗╚██╗ ██╔╝",
  "██████╔╝█████╗  ██║  ███╗██║███████╗   ██║   ██████╔╝ ╚████╔╝ ",
  "██╔══██╗██╔══╝  ██║   ██║██║╚════██║   ██║   ██╔══██╗  ╚██╔╝  ",
  "██║  ██║███████╗╚██████╔╝██║███████║   ██║   ██║  ██║   ██║   ",
  "╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ",
].join("\n");

export function Browse() {
  const [search, setSearch] = useState("");
  const { data, isPending, error } = useQuery({
    queryKey: keys.repositories(search),
    queryFn: () => api.repositories(search),
  });

  return (
    <div className="space-y-6">
      <pre
        aria-hidden="true"
        className="select-none font-mono text-[min(1.7vw,11px)] leading-none text-muted-foreground"
      >
        {LOGO}
      </pre>

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
