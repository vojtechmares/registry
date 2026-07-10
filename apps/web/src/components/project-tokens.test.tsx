import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectAccessToken } from "@registry/api-contract";
import { ProjectTokens } from "./project-tokens";
import { renderWithProviders } from "@/test/render";

const { projectTokens, createProjectToken, revokeProjectToken } = vi.hoisted(() => ({
  projectTokens: vi.fn(),
  createProjectToken: vi.fn(),
  revokeProjectToken: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { projectTokens, createProjectToken, revokeProjectToken },
}));

const existing: ProjectAccessToken = {
  id: "tok1",
  name: "ci",
  username: "bob",
  scopes: [{ repository: "acme/api", actions: ["pull"] }],
  project: "acme",
  expiresAt: null,
  createdAt: Date.now(),
  lastUsedAt: null,
  revoked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  projectTokens.mockResolvedValue([existing]);
  createProjectToken.mockResolvedValue({ ...existing, id: "tok2", name: "deploy", secret: "sec-ret" });
  revokeProjectToken.mockResolvedValue(undefined);
});

describe("ProjectTokens", () => {
  it("lists the project's tokens and says whose each one is", async () => {
    renderWithProviders(<ProjectTokens project="acme" />);

    expect(await screen.findByText("ci")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("acme/api:pull")).toBeInTheDocument();
  });

  it("creates a token scoped to the project, and shows the secret exactly once", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectTokens project="acme" />);

    await user.type(await screen.findByLabelText("Name"), "deploy");
    await user.clear(screen.getByLabelText("Repository"));
    await user.type(screen.getByLabelText("Repository"), "acme/api");
    await user.click(screen.getByRole("checkbox", { name: "push" }));
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(createProjectToken).toHaveBeenCalledWith("acme", {
      name: "deploy",
      scopes: [{ repository: "acme/api", actions: ["pull", "push"] }],
    });
    expect(await screen.findByText("sec-ret")).toBeInTheDocument();
  });

  it("revokes a token once the confirmation is accepted", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithProviders(<ProjectTokens project="acme" />);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(revokeProjectToken).toHaveBeenCalledWith("acme", "tok1");
  });

  it("does not revoke when the confirmation is declined", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithProviders(<ProjectTokens project="acme" />);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(revokeProjectToken).not.toHaveBeenCalled();
  });
});
