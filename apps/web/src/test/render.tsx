import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import { ThemeProvider } from "@workspace/ui/components/theme-provider";

/**
 * Components that render `<Link>` need a router in context, and components that
 * fetch need a query client. Both are supplied here so tests can mount a single
 * component rather than the whole application.
 */
export function renderWithProviders(ui: ReactNode): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });

  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
  // Declared so `<Link to="/r/$">` resolves; never navigated to.
  const repositoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$",
    component: () => null,
  });
  const manifestRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/manifest",
    validateSearch: (search: Record<string, unknown>) => ({
      repo: String(search.repo ?? ""),
      digest: String(search.digest ?? ""),
    }),
    component: () => null,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, repositoryRoute, manifestRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
