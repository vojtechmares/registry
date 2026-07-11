import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import { Login } from "./login";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({ providers: vi.fn(), login: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers.mockResolvedValue({ password: true, oidc: false });
  mocks.login.mockResolvedValue({ id: "u1", username: "bob", isAdmin: false });
});

describe("Login", () => {
  it("renders the sign-in form", async () => {
    renderWithProviders(<Login />);
    expect(await screen.findByText("Manage repositories, tokens and users.")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("reports an incorrect password when the sign-in is refused", async () => {
    mocks.login.mockRejectedValue(
      new ApiError(401, "https://registry.mareshq.com/problems/unauthorized", "Unauthorized", "no"),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText("Username"), "bob");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Incorrect username or password.")).toBeInTheDocument();
  });

  // The rate limiter emits a different problem type, so the message names the
  // lock-out rather than a bad password even though this too is a refused login.
  it("reports being rate limited when too many attempts are made", async () => {
    mocks.login.mockRejectedValue(
      new ApiError(
        429,
        "https://registry.mareshq.com/problems/rate-limited",
        "Too many requests",
        "slow down",
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText("Username"), "bob");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Too many attempts. Try again shortly.")).toBeInTheDocument();
  });

  it("offers single sign-on when the registry has it configured", async () => {
    mocks.providers.mockResolvedValue({ password: true, oidc: true });
    renderWithProviders(<Login />);
    expect(await screen.findByRole("link", { name: /Sign in with SSO/i })).toBeInTheDocument();
  });
});
