import { useState } from "react";
import { createRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserSummary } from "@registry/api-contract";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { toast } from "@workspace/ui/components/sonner";
import { Switch } from "@workspace/ui/components/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import { RepositoryTable } from "@/components/repository-table";
import { ApiError, api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/format";
import { rootRoute } from "@/routes/root";
import { isAdmin, sessionReady, sessionStore } from "@/store/session";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint !== undefined && <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

function Overview() {
  const { data, isPending } = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const repositories = useQuery({ queryKey: ["repositories", ""], queryFn: () => api.repositories() });

  if (isPending || data === undefined) return <Skeleton className="h-40 w-full" />;

  // Deduplication saves nothing until the same layer appears in two places, so
  // measure it against the content that is still linked, not against the bytes
  // in the bucket - those include garbage the collector has not reached yet.
  const saved = Math.max(0, data.logicalBytes - data.referencedBytes);
  const ratio = data.logicalBytes === 0 ? 0 : Math.round((saved / data.logicalBytes) * 100);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Repositories" value={String(data.repositories)} />
        <Stat label="Tags" value={String(data.tags)} hint={`${data.manifests} manifests`} />
        <Stat
          label="Stored"
          value={formatBytes(data.storageBytes)}
          hint={
            data.reclaimableBytes > 0
              ? `${data.blobs} blobs, ${formatBytes(data.reclaimableBytes)} reclaimable`
              : `${data.blobs} blobs`
          }
        />
        <Stat
          label="Deduplicated"
          value={formatBytes(saved)}
          hint={`${ratio}% of ${formatBytes(data.logicalBytes)} logical`}
        />
      </div>

      {repositories.data !== undefined && <RepositoryTable repositories={repositories.data} />}
    </div>
  );
}

/**
 * Changing an address.
 *
 * A dialog rather than an editable cell, because saving an address the moment
 * focus leaves the field is how one gets typed into the wrong row.
 */
function ChangeEmail({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(user.email ?? "");

  const save = useMutation({
    mutationFn: () => api.updateUser(user.id, { email }),
    onSuccess: () => {
      toast.success(`Updated ${user.username}`);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not save the email"),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening after a failed save should not show the rejected address.
        if (next) setEmail(user.email ?? "");
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Email
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email for {user.username}</DialogTitle>
          <DialogDescription>No two accounts may share an address.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`email-${user.id}`}>Address</Label>
            <Input
              id={`email-${user.id}`}
              type="email"
              required
              value={email}
              placeholder="alice@example.com"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Users() {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: ["users"], queryFn: api.users });

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Named apart from the imported `isAdmin` guard, which this would otherwise shadow.
  const [makeAdmin, setMakeAdmin] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createUser({ username, email, password, isAdmin: makeAdmin }),
    onSuccess: () => {
      toast.success(`Created ${username}`);
      setUsername("");
      setEmail("");
      setPassword("");
      setMakeAdmin(false);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not create the user"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteUser(id),
    onSuccess: () => {
      toast.success("User deleted");
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : "Could not delete the user"),
  });

  return (
    <div className="space-y-6">
      <form
        className="grid gap-4 rounded-md border p-4 sm:grid-cols-[1fr_1fr_1fr_auto_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="new-username">Username</Label>
          <Input id="new-username" required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-email">Email</Label>
          <Input
            id="new-email"
            type="email"
            required
            placeholder="alice@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password">Password</Label>
          <Input
            id="new-password"
            type="password"
            required
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="new-admin" checked={makeAdmin} onCheckedChange={setMakeAdmin} />
          <Label htmlFor="new-admin">Admin</Label>
        </div>
        <Button type="submit" disabled={create.isPending}>
          Create user
        </Button>
      </form>

      {isPending || data === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Email</TableHead>
              <TableHead className="w-24">Role</TableHead>
              <TableHead className="w-40">Created</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.username}</TableCell>
                <TableCell className="text-muted-foreground">
                  {user.email ?? <span className="italic">none</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={user.isAdmin ? "secondary" : "outline"}>
                    {user.isAdmin ? "admin" : "member"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(user.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <ChangeEmail user={user} />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={user.id === "bootstrap" || remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${user.username}?`)) remove.mutate(user.id);
                    }}
                  >
                    Delete
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

function Admin() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">Registry health, repositories and accounts.</p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="pt-6">
          <Overview />
        </TabsContent>
        <TabsContent value="users" className="pt-6">
          <Users />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  /**
   * The API enforces this too, and it is the enforcement that matters. Guarding
   * the route only spares a non-admin a page full of failed requests - but it
   * has to wait for the session probe first, or it waves everyone through.
   */
  beforeLoad: async () => {
    await sessionReady;
    if (!isAdmin(sessionStore.state)) throw redirect({ to: "/login" });
  },
  component: Admin,
});
