import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Toaster } from "@workspace/ui/components/sonner";
import { AppShell } from "@/components/app-shell";

export const rootRoute = createRootRoute({
  component: () => (
    <>
      <AppShell>
        <Outlet />
      </AppShell>
      <Toaster position="bottom-right" />
    </>
  ),
  notFoundComponent: () => (
    <div className="py-20 text-center">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">That page does not exist.</p>
    </div>
  ),
});
