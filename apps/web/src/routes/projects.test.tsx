import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ProjectSummary } from "@registry/api-contract";
import { setSessionUser } from "@/store/session";
import { Projects } from "./projects";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ projects: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const project: ProjectSummary = {
  name: "acme",
  visibility: "public",
  description: null,
  quotaBytes: null,
  usedBytes: 0,
  requireSignaturePush: false,
  requireSignaturePull: false,
  immutableTags: false,
  repositories: 2,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  role: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  setSessionUser(null);
  mocks.projects.mockResolvedValue([project]);
});

describe("Projects", () => {
  it("lists the projects it loaded", async () => {
    renderWithProviders(<Projects />);
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "acme" })).toBeInTheDocument();
  });

  it("says so when there are no projects yet", async () => {
    mocks.projects.mockResolvedValue([]);
    renderWithProviders(<Projects />);
    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
  });
});
