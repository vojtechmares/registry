import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { RegistryStats } from "@registry/api-contract";
import { setSessionUser } from "@/store/session";
import { Admin, requireAdmin } from "./admin";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ stats: vi.fn(), repositories: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const stats: RegistryStats = {
  projects: 2,
  repositories: 4,
  tags: 9,
  manifests: 11,
  blobs: 20,
  storageBytes: 1024,
  referencedBytes: 1024,
  logicalBytes: 2048,
  reclaimableBytes: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stats.mockResolvedValue(stats);
  mocks.repositories.mockResolvedValue([]);
});

describe("Admin", () => {
  it("renders the admin overview", async () => {
    renderWithProviders(<Admin />);
    expect(await screen.findByRole("heading", { name: "Admin" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Users" })).toBeInTheDocument();
  });
});

describe("the admin route guard", () => {
  it("redirects a non-administrator to the sign-in page", () => {
    setSessionUser({ id: "u1", username: "bob", isAdmin: false });
    const thrown = (() => {
      try {
        requireAdmin();
      } catch (redirect) {
        return redirect;
      }
      return null;
    })();
    expect(thrown).toMatchObject({ options: { to: "/login" } });
  });

  it("lets an administrator through", () => {
    setSessionUser({ id: "u2", username: "root", isAdmin: true });
    expect(() => requireAdmin()).not.toThrow();
  });
});
