import { createRouter } from "@tanstack/react-router";
import { adminRoute } from "@/routes/admin";
import { browseRoute } from "@/routes/browse";
import { loginRoute } from "@/routes/login";
import { manifestRoute } from "@/routes/manifest";
import { projectDetailRoute } from "@/routes/project-detail";
import { projectsRoute } from "@/routes/projects";
import { repositoryRoute } from "@/routes/repository";
import { rootRoute } from "@/routes/root";
import { tokensRoute } from "@/routes/tokens";

const routeTree = rootRoute.addChildren([
  browseRoute,
  loginRoute,
  manifestRoute,
  projectsRoute,
  projectDetailRoute,
  repositoryRoute,
  tokensRoute,
  adminRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
