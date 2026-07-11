import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { RepositoryDetail } from "@registry/api-contract";
import { setSessionUser } from "@/store/session";
import { Repository } from "./repository";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ repository: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const detail: RepositoryDetail = {
  name: "acme/api",
  project: "acme",
  visibility: "public",
  sizeBytes: 2048,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  setSessionUser(null);
  mocks.repository.mockResolvedValue(detail);
});

describe("Repository", () => {
  it("renders the repository it loaded", async () => {
    renderWithProviders(<Repository name="acme/api" />);
    expect(await screen.findByRole("heading", { name: "acme/api" })).toBeInTheDocument();
  });

  it("reports an error when the repository cannot be loaded", async () => {
    mocks.repository.mockRejectedValue(new Error("boom"));
    renderWithProviders(<Repository name="acme/api" />);
    expect(await screen.findByText("Could not load acme/api.")).toBeInTheDocument();
  });
});
