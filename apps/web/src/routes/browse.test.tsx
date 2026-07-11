import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { RepositorySummary } from "@registry/api-contract";
import { Browse } from "./browse";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ repositories: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const repository: RepositorySummary = {
  name: "acme/api",
  project: "acme",
  visibility: "public",
  tags: 3,
  manifests: 5,
  sizeBytes: 1024,
  updatedAt: Date.now(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repositories.mockResolvedValue([repository]);
});

describe("Browse", () => {
  it("lists the repositories it loaded", async () => {
    renderWithProviders(<Browse />);
    expect(await screen.findByRole("heading", { name: "Repositories" })).toBeInTheDocument();
    expect(await screen.findByText("acme/api")).toBeInTheDocument();
  });

  it("reports an error when the repositories cannot be loaded", async () => {
    mocks.repositories.mockRejectedValue(new Error("boom"));
    renderWithProviders(<Browse />);
    expect(await screen.findByText("Could not load repositories.")).toBeInTheDocument();
  });
});
