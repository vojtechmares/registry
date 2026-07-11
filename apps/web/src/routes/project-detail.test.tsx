import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { ProjectDetail } from "@registry/api-contract";
import { setSessionUser } from "@/store/session";
import { ProjectPage } from "./project-detail";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ project: vi.fn(), projectStats: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const detail: ProjectDetail = {
  name: "acme",
  visibility: "public",
  description: "The acme project",
  quotaBytes: null,
  usedBytes: 0,
  requireSignaturePush: false,
  requireSignaturePull: false,
  immutableTags: false,
  repositories: 3,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  role: null,
  members: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // A plain viewer, so only the read-only Usage tab renders.
  setSessionUser(null);
  mocks.project.mockResolvedValue(detail);
  // The Usage tab loads separately; leave it pending so it shows a skeleton.
  mocks.projectStats.mockReturnValue(new Promise(() => {}));
});

describe("ProjectPage", () => {
  it("renders the project it loaded", async () => {
    renderWithProviders(<ProjectPage name="acme" />);
    expect(await screen.findByRole("heading", { name: "acme" })).toBeInTheDocument();
  });

  it("reports an error when the project cannot be loaded", async () => {
    mocks.project.mockRejectedValue(new Error("boom"));
    renderWithProviders(<ProjectPage name="acme" />);
    expect(await screen.findByText("Could not load acme.")).toBeInTheDocument();
  });
});
