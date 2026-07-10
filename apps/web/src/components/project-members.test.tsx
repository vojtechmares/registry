import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectDetail } from "@registry/api-contract";
import { ProjectMembers } from "./project-members";
import { renderWithProviders } from "@/test/render";

const { addMember, removeMember, setMember } = vi.hoisted(() => ({
  addMember: vi.fn(),
  removeMember: vi.fn(),
  setMember: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { addMember, removeMember, setMember },
}));

const project: ProjectDetail = {
  name: "acme",
  visibility: "private",
  description: null,
  quotaBytes: null,
  usedBytes: 0,
  requireSignaturePush: false,
  requireSignaturePull: false,
  immutableTags: false,
  repositories: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  role: "owner",
  members: [{ userId: "u1", username: "bob", role: "developer", createdAt: Date.now() }],
};

beforeEach(() => {
  vi.clearAllMocks();
  addMember.mockResolvedValue({ project: "acme", userId: "u2", username: "carol", role: "maintainer" });
  removeMember.mockResolvedValue(undefined);
  setMember.mockResolvedValue({ project: "acme", userId: "u1", role: "guest" });
});

describe("ProjectMembers", () => {
  it("adds a member by the username that was typed, with the chosen role", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectMembers project={project} />);

    await user.type(await screen.findByLabelText("Username"), "carol");
    await user.selectOptions(screen.getByLabelText("Role"), "maintainer");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(addMember).toHaveBeenCalledWith("acme", "carol", "maintainer");
  });

  it("will not submit an empty username", async () => {
    renderWithProviders(<ProjectMembers project={project} />);

    expect(await screen.findByRole("button", { name: "Add" })).toBeDisabled();
    expect(addMember).not.toHaveBeenCalled();
  });

  it("trims the username, so a stray space does not become a failed lookup", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectMembers project={project} />);

    await user.type(await screen.findByLabelText("Username"), "  carol  ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(addMember).toHaveBeenCalledWith("acme", "carol", "developer");
  });

  it("lists the existing members and removes one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectMembers project={project} />);

    expect(await screen.findByText("bob")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(removeMember).toHaveBeenCalledWith("acme", "u1");
  });

  it("changes an existing member's role", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectMembers project={project} />);

    await user.selectOptions(await screen.findByLabelText("Role of bob"), "guest");
    expect(setMember).toHaveBeenCalledWith("acme", "u1", "guest");
  });

  it("says who still has access when there are no explicit members", async () => {
    renderWithProviders(<ProjectMembers project={{ ...project, members: [] }} />);
    expect(await screen.findByText(/No explicit members/i)).toBeInTheDocument();
  });
});
