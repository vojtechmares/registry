import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { AccessTokenSummary } from "@registry/api-contract";
import { setSessionUser } from "@/store/session";
import { Tokens, requireSession } from "./tokens";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ tokens: vi.fn(), revokeToken: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

const token: AccessTokenSummary = {
  id: "t1",
  name: "ci",
  scopes: [{ repository: "acme/api", actions: ["pull"] }],
  project: "acme",
  expiresAt: null,
  createdAt: Date.now(),
  lastUsedAt: null,
  revoked: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tokens.mockResolvedValue([token]);
});

describe("Tokens", () => {
  it("lists the account's tokens", async () => {
    renderWithProviders(<Tokens />);
    expect(await screen.findByRole("heading", { name: "Access tokens" })).toBeInTheDocument();
    expect(await screen.findByText("ci")).toBeInTheDocument();
  });

  it("says so when there are no tokens yet", async () => {
    mocks.tokens.mockResolvedValue([]);
    renderWithProviders(<Tokens />);
    expect(await screen.findByText(/No tokens yet/i)).toBeInTheDocument();
  });
});

describe("the tokens route guard", () => {
  it("redirects a signed-out visitor to the sign-in page", () => {
    setSessionUser(null);
    const thrown = (() => {
      try {
        requireSession();
      } catch (redirect) {
        return redirect;
      }
      return null;
    })();
    expect(thrown).toMatchObject({ options: { to: "/login" } });
  });

  it("lets a signed-in visitor through", () => {
    setSessionUser({ id: "u1", username: "bob", isAdmin: false });
    expect(() => requireSession()).not.toThrow();
  });
});
