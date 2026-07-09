import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { RepositorySummary } from "@registry/api-contract";
import { RepositoryTable } from "./repository-table";
import { renderWithProviders } from "@/test/render";

const now = Date.now();

const repositories: RepositorySummary[] = [
  {
    name: "myorg/app",
    project: "myorg",
    visibility: "public",
    tags: 3,
    manifests: 4,
    sizeBytes: 12 * 1024 * 1024,
    updatedAt: now,
  },
  {
    name: "myorg/secret",
    project: "myorg",
    visibility: "private",
    tags: 0,
    manifests: 0,
    sizeBytes: 0,
    updatedAt: now - 86_400_000,
  },
];

describe("RepositoryTable", () => {
  it("tells the visitor how to get started when there is nothing to show", async () => {
    renderWithProviders(<RepositoryTable repositories={[]} />);
    expect(await screen.findByText(/push an image to create one/i)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("links each repository to its own page", async () => {
    renderWithProviders(<RepositoryTable repositories={repositories} />);

    const link = await screen.findByRole("link", { name: "myorg/app" });
    expect(link).toHaveAttribute("href", "/r/myorg/app");
  });

  it("shows visibility, tag count and human-readable size", async () => {
    renderWithProviders(<RepositoryTable repositories={repositories} />);

    expect(await screen.findByText("public")).toBeInTheDocument();
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(screen.getByText("12 MiB")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders one row per repository", async () => {
    renderWithProviders(<RepositoryTable repositories={repositories} />);
    // Plus one for the header.
    expect(await screen.findAllByRole("row")).toHaveLength(repositories.length + 1);
  });
});
