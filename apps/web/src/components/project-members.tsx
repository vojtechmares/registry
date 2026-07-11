import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidate } from "@/lib/queries";
import type { ProjectDetail, Role } from "@registry/api-contract";
import { Button } from "@registry/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@registry/ui/components/card";
import { Input } from "@registry/ui/components/input";
import { Label } from "@registry/ui/components/label";
import { toast } from "@registry/ui/components/sonner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@registry/ui/components/table";
import { ApiError, api } from "@/lib/api";

const ROLES: Role[] = ["guest", "developer", "maintainer", "owner"];

const ROLE_CLASS = "rounded-md border bg-background px-2 py-1 text-sm";

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * The members of one project: who may do what, and the form that adds them.
 *
 * Members are added by username rather than by user id. The dashboard cannot
 * turn one into the other - listing users is an administrator's privilege - so
 * the name is sent as typed and the registry resolves it.
 */
export function ProjectMembers({ project }: { project: ProjectDetail }) {
  const queryClient = useQueryClient();
  const refresh = () => invalidate.projectMembers(queryClient, project.name);

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("developer");

  const add = useMutation({
    mutationFn: () => api.addMember(project.name, username.trim(), role),
    onSuccess: (member) => {
      toast.success(`${member.username} is now a ${member.role}`);
      setUsername("");
      refresh();
    },
    onError: (error) => toast.error(message(error, "Could not add the member")),
  });

  const setRoleOf = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: Role }) =>
      api.setMember(project.name, userId, next),
    onSuccess: refresh,
    onError: (error) => toast.error(message(error, "Could not update the member")),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api.removeMember(project.name, userId),
    onSuccess: refresh,
    onError: (error) => toast.error(message(error, "Could not remove the member")),
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a member</CardTitle>
          <CardDescription>
            Grant someone who already has an account access to this project. A guest may pull, a developer may
            push, a maintainer may delete, and an owner may change these settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="member-username">Username</Label>
              <Input
                id="member-username"
                autoComplete="off"
                placeholder="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-role">Role</Label>
              <select
                id="member-role"
                className={`${ROLE_CLASS} h-9`}
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={add.isPending || username.trim() === ""}>
              Add
            </Button>
          </form>
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {project.members.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                No explicit members. The project owner and administrators still have access.
              </TableCell>
            </TableRow>
          ) : (
            project.members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell className="font-medium">{member.username}</TableCell>
                <TableCell>
                  <select
                    aria-label={`Role of ${member.username}`}
                    className={ROLE_CLASS}
                    value={member.role}
                    onChange={(event) =>
                      setRoleOf.mutate({ userId: member.userId, next: event.target.value as Role })
                    }
                  >
                    {ROLES.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(member.userId)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
