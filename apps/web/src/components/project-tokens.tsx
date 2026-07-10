import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatedAccessToken } from "@registry/api-contract";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { toast } from "@workspace/ui/components/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { CopyButton } from "@/components/copy-button";
import { ApiError, api } from "@/lib/api";
import { formatDate, formatRelativeTime } from "@/lib/format";

const ACTIONS = ["pull", "push", "delete"] as const;

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * A project's machine credentials.
 *
 * Tokens live here rather than in a registry-wide list because they reach
 * exactly one project. A scope that names another project is refused, and so is
 * a scope wider than the member who typed it.
 */
export function ProjectTokens({ project }: { project: string }) {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);

  const [name, setName] = useState("");
  const [repository, setRepository] = useState("*");
  const [actions, setActions] = useState<string[]>(["pull"]);

  const { data, isPending } = useQuery({
    queryKey: ["project-tokens", project],
    queryFn: () => api.projectTokens(project),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["project-tokens", project] });
    void queryClient.invalidateQueries({ queryKey: ["tokens"] });
  };

  const create = useMutation({
    mutationFn: () => api.createProjectToken(project, { name, scopes: [{ repository, actions }] }),
    onSuccess: (token) => {
      setCreated(token);
      setName("");
      setRepository("*");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not create the token")),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeProjectToken(project, id),
    onSuccess: () => {
      toast.success("Token revoked");
      invalidate();
    },
    onError: (error) => toast.error(message(error, "Could not revoke the token")),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">New token</CardTitle>
          <CardDescription>
            Reaches only <span className="font-mono">{project}</span>, and never more than you can already do.
            Use it as the password with any username.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {created !== null && (
            <Alert className="mb-4">
              <AlertTitle>Copy this token now</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>It is shown once and never again. Only its hash is stored.</p>
                <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                  <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
                    {created.secret}
                  </code>
                  <CopyButton value={created.secret} label="Copy token" />
                </div>
              </AlertDescription>
            </Alert>
          )}

          <form
            className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="token-name">Name</Label>
              <Input
                id="token-name"
                required
                value={name}
                placeholder="ci"
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="token-repository">Repository</Label>
              <Input
                id="token-repository"
                required
                value={repository}
                placeholder={`${project}/app`}
                onChange={(event) => setRepository(event.target.value)}
              />
            </div>

            <div className="space-y-2 sm:col-span-3">
              <span className="text-sm font-medium">Permissions</span>
              <div className="flex gap-4">
                {ACTIONS.map((action) => (
                  <label key={action} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={actions.includes(action)}
                      onChange={(event) =>
                        setActions((current) =>
                          event.target.checked ? [...current, action] : current.filter((a) => a !== action),
                        )
                      }
                    />
                    {action}
                  </label>
                ))}
              </div>
            </div>

            <Button
              type="submit"
              className="sm:col-start-3"
              disabled={create.isPending || actions.length === 0}
            >
              Create token
            </Button>
          </form>
        </CardContent>
      </Card>

      {isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : data === undefined || data.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No tokens in this project yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-32">Owner</TableHead>
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
                <TableCell className="text-muted-foreground">{token.username}</TableCell>
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
