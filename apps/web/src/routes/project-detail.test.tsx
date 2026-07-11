import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectDetail } from "@registry/api-contract";
import { ApiError } from "@/lib/api";
import { setSessionUser } from "@/store/session";
import { ProjectPage } from "./project-detail";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ project: vi.fn(), projectStats: vi.fn(), updateProject: vi.fn() }));

const INVALID_REQUEST = "https://registry.mareshq.com/problems/invalid-request";

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

  // An owner reaches the settings, and a rejected save that names `/quotaBytes`
  // has to land under the quota field, not only in a toast.
  it("renders a server field error at the quota field when the save is refused", async () => {
    setSessionUser({ id: "u1", username: "root", isAdmin: true });
    mocks.updateProject.mockRejectedValue(
      new ApiError(400, INVALID_REQUEST, "Invalid request", "The request was refused.", [
        { detail: "Quota must be a whole number of GiB.", pointer: "/quotaBytes" },
      ]),
    );
    const user = userEvent.setup();
    renderWithProviders(<ProjectPage name="acme" />);

    await user.click(await screen.findByRole("tab", { name: "Settings" }));
    const quota = await screen.findByLabelText("Quota (GiB)");
    await user.type(quota, "5");
    await user.click(within(quota.closest("form") as HTMLFormElement).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Quota must be a whole number of GiB.")).toBeInTheDocument();
  });
});
