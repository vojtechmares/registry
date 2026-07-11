import { Link, createRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invalidate, keys } from "@/lib/queries";
import { Badge } from "@registry/ui/components/badge";
import { Button } from "@registry/ui/components/button";
import { Skeleton } from "@registry/ui/components/skeleton";
import { toast } from "@registry/ui/components/sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@registry/ui/components/table";
import { ApiError, api } from "@/lib/api";
import { formatDate, formatRelativeTime } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { sessionReady, sessionStore } from "@/store/session";

/**
 * Every token the caller owns, wherever it lives.
 *
 * There is nothing to create here: a token reaches exactly one project, so it
 * is minted from that project's page, where the scopes it may be given are the
 * ones the project can grant. This page exists to find and revoke them.
 */
/** The redirect decision the route guard makes: a signed-out visitor goes to the sign-in page. */
export function requireSession(): void {
  if (sessionStore.state.user === null) throw redirect({ to: "/login" });
}

export function Tokens() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: keys.tokens(), queryFn: api.tokens });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => {
      toast.success("Token revoked");
      invalidate.accountTokens(queryClient);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not revoke the token"),
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Access tokens</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Machine credentials for CI, one project each. Create them from a project's Tokens tab; use the token
          as the password with any username.
        </p>
      </div>

      {isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : data === undefined || data.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No tokens yet. Open a project and use its Tokens tab to create one.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-40">Project</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead className="w-32">Created</TableHead>
              <TableHead className="w-32">Last used</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.name}</TableCell>
                <TableCell>
                  {token.project === null ? (
                    // Minted before a token had to name a project. It no longer
                    // authenticates; saying so is friendlier than an empty cell.
                    <Badge variant="destructive" title="This token no longer works. Revoke it.">
                      none
                    </Badge>
                  ) : (
                    <Link
                      to="/projects/$name"
                      params={{ name: token.project }}
                      className="font-mono text-sm hover:underline"
                    >
                      {token.project}
                    </Link>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {token.scopes.map((scope) => (
                      <Badge key={scope.repository} variant="outline" className="font-mono text-xs">
                        {scope.repository}:{scope.actions.join(",")}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(token.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {token.lastUsedAt === null ? "never" : formatRelativeTime(token.lastUsedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (window.confirm(`Revoke "${token.name}"?`)) revoke.mutate(token.id);
                    }}
                  >
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export const tokensRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/tokens",
  beforeLoad: async () => {
    await sessionReady;
    requireSession();
  },
  component: Tokens,
});
