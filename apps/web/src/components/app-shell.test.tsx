import { afterEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { setSessionUser } from "@/store/session";
import { AppShell } from "./app-shell";
import { renderWithProviders } from "@/test/render";

afterEach(() => {
  setSessionUser(null);
});

describe("AppShell", () => {
  it("renders its children and the public nav, and offers sign-in to a signed-out visitor", async () => {
    setSessionUser(null);
    renderWithProviders(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );

    expect(await screen.findByText("page body")).toBeInTheDocument();
    // The header is the shell's nav; the footer repeats some links, so scope to it.
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Repositories" })).toBeInTheDocument();
    expect(header.getByRole("link", { name: "Projects" })).toBeInTheDocument();
    expect(header.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    // The gated links stay hidden from an anonymous visitor.
    expect(header.queryByRole("link", { name: "Tokens" })).not.toBeInTheDocument();
    expect(header.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("shows the token, admin, and sign-out controls to an administrator", async () => {
    setSessionUser({ id: "u1", username: "root", isAdmin: true });
    renderWithProviders(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );

    await screen.findByText("page body");
    const header = within(screen.getByRole("banner"));
    expect(header.getByRole("link", { name: "Tokens" })).toBeInTheDocument();
    expect(header.getByRole("link", { name: "Admin" })).toBeInTheDocument();
    expect(header.getByText("root")).toBeInTheDocument();
    expect(header.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
