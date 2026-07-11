import { Link, createRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/queries";
import { FileTextIcon, ShieldCheckIcon } from "lucide-react";
import { Badge } from "@workspace/ui/components/badge";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Digest } from "@/components/digest";
import { PullCommand } from "@/components/pull-command";
import { api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { rootRoute } from "@/routes/root";

interface ManifestSearch {
  repo: string;
  digest: string;
}

/** Signatures and SBOMs announce themselves through the artifact type. */
function referrerIcon(artifactType: string | null) {
  if (artifactType === null) return <FileTextIcon className="size-4" />;
  if (/sig|cosign|signature/i.test(artifactType)) return <ShieldCheckIcon className="size-4" />;
  return <FileTextIcon className="size-4" />;
}

export function Manifest({ repo, digest }: ManifestSearch) {
  const { data, isPending, error } = useQuery({
    queryKey: keys.manifest(repo, digest),
    queryFn: () => api.manifest(repo, digest),
  });

  if (isPending) return <Skeleton className="h-64 w-full" />;
  if (error !== null) return <p className="text-sm text-destructive">Could not load that manifest.</p>;

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/r/$"
          params={{ _splat: repo }}
          className="font-mono text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {repo}
        </Link>
        <h1 className="mt-1 break-all font-mono text-xl font-semibold tracking-tight">{data.digest}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{data.mediaType}</Badge>
          {data.artifactType !== null && <Badge variant="secondary">{data.artifactType}</Badge>}
          <span>{formatBytes(data.size)}</span>
          <span>pushed {formatDate(data.createdAt)}</span>
        </div>
      </div>

      <PullCommand repository={repo} reference={data.tags[0] ?? data.digest} />

      {data.tags.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Tags</h2>
          <div className="flex flex-wrap gap-2">
            {data.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-mono">
                {tag}
              </Badge>
            ))}
          </div>
        </section>
      )}

      {data.annotations !== null && Object.keys(data.annotations).length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Annotations</h2>
          <dl className="rounded-md border divide-y text-sm">
            {Object.entries(data.annotations).map(([key, value]) => (
              <div key={key} className="grid grid-cols-[minmax(0,1fr)_2fr] gap-4 px-4 py-2">
                <dt className="truncate font-mono text-xs text-muted-foreground">{key}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Referrers ({data.referrers.length})
        </h2>
        {data.referrers.length === 0 ? (
          <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing is attached to this manifest. Signatures and SBOMs would appear here.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.referrers.map((referrer) => (
              <li key={referrer.digest} className="flex items-center gap-3 px-4 py-3">
                {referrerIcon(referrer.artifactType)}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {referrer.artifactType ?? referrer.mediaType}
                  </p>
                  <Link
                    to="/manifest"
                    search={{ repo, digest: referrer.digest }}
                    className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                  >
                    <Digest value={referrer.digest} />
                  </Link>
                </div>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {formatBytes(referrer.size)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Blobs ({data.blobs.length})
        </h2>
        <ul className="divide-y rounded-md border text-sm">
          {data.blobs.map((blob) => (
            <li key={blob.digest} className="flex items-center justify-between px-4 py-2">
              <Digest value={blob.digest} length={20} />
              <span className="tabular-nums text-muted-foreground">{formatBytes(blob.size)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export const manifestRoute = createRoute({
  getParentRoute: () => rootRoute,
  // A repository name and a digest both contain characters that make poor path
  // segments, so they travel as search parameters.
  path: "/manifest",
  validateSearch: (search: Record<string, unknown>): ManifestSearch => ({
    repo: String(search.repo ?? ""),
    digest: String(search.digest ?? ""),
  }),
  component: function ManifestRoute() {
    const { repo, digest } = manifestRoute.useSearch();
    return <Manifest repo={repo} digest={digest} />;
  },
});
