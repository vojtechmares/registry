import { Link, useNavigate } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { BoxIcon, LogOutIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@workspace/ui/components/button";
import { toast } from "@workspace/ui/components/sonner";
import { useTheme } from "@workspace/ui/components/theme-provider";
import { api } from "@/lib/api";
import { SiteFooter } from "@/components/site-footer";
import { sessionStore, setSessionUser } from "@/store/session";

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </Button>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user } = useStore(sessionStore);
  const navigate = useNavigate();

  async function signOut() {
    await api.logout();
    setSessionUser(null);
    toast.success("Signed out");
    await navigate({ to: "/" });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <BoxIcon className="size-5" />
            <span>registry</span>
          </Link>

          <nav className="flex flex-1 items-center gap-1 text-sm">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              Repositories
            </Link>
            <Link
              to="/projects"
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              Projects
            </Link>
            {user !== null && (
              <Link
                to="/settings/tokens"
                className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
              >
                Tokens
              </Link>
            )}
            {user?.isAdmin === true && (
              <Link
                to="/admin"
                className="rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
              >
                Admin
              </Link>
            )}
          </nav>

          <ThemeToggle />

          {user === null ? (
            <Button asChild size="sm">
              <Link to="/login">Sign in</Link>
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{user.username}</span>
              <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
                <LogOutIcon className="size-4" />
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>

      <SiteFooter />
    </div>
  );
}
