import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "@registry/ui/globals.css";
import { ThemeProvider } from "@registry/ui/components/theme-provider";
import { ApiError, api } from "@/lib/api";
import { router } from "@/router";
import { loadSession } from "@/store/session";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retrying a 401 or a 403 only wastes the user's time; the answer will not change.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.status < 500 ? false : failureCount < 2,
    },
  },
});

// Fired before the first render, not from an effect: route guards await the
// result, and an effect would not have run by the time the first route loads.
void loadSession(api.session);

const container = document.getElementById("root");
if (container === null) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
