import { useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/queries";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { ApiError, api } from "@/lib/api";
import { rootRoute } from "@/routes/root";
import { setSessionUser } from "@/store/session";

function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Whether single sign-on is configured, so the button is shown only when it works.
  const providers = useQuery({ queryKey: keys.providers(), queryFn: api.providers });
  // A message the OIDC callback may have redirected back with.
  const callbackError = new URLSearchParams(window.location.search).get("error");

  const signIn = useMutation({
    mutationFn: () => api.login(username, password),
    onSuccess: async (user) => {
      setSessionUser(user);
      await navigate({ to: "/" });
    },
  });

  const message =
    signIn.error === null
      ? null
      : signIn.error instanceof ApiError && signIn.error.status === 401
        ? "Incorrect username or password."
        : signIn.error instanceof ApiError && signIn.error.status === 429
          ? "Too many attempts. Try again shortly."
          : "Something went wrong. Try again.";

  return (
    <div className="mx-auto max-w-sm py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Manage repositories, tokens and users.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              signIn.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {(message ?? callbackError) !== null && (
              <p role="alert" className="text-sm text-destructive">
                {message ?? callbackError}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={signIn.isPending}>
              {signIn.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {providers.data?.oidc === true && (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
              <Button variant="outline" className="w-full" asChild>
                {/* A full navigation, not a fetch: the provider needs the browser. */}
                <a href="/api/v1/auth/oidc/start">Sign in with SSO</a>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});
