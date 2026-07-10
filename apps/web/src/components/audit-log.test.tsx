import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuditEvent } from "@registry/api-contract";
import { AuditLog } from "./audit-log";
import { renderWithProviders } from "@/test/render";

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { audit },
}));

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "e1",
    actorId: "u1",
    actorName: "alice",
    actorKind: "user",
    actorTokenId: null,
    action: "project.update",
    resourceType: "project",
    resource: "acme",
    project: "acme",
    detail: { quotaBytes: 100 },
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  audit.mockResolvedValue({ events: [event()], cursor: null });
});

describe("AuditLog", () => {
  it("lists what happened, who did it, and to what", async () => {
    renderWithProviders(<AuditLog />);

    expect(await screen.findByText("project.update")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("acme", { selector: ".font-mono" })).toBeInTheDocument();
    expect(screen.getByText("quotaBytes=100")).toBeInTheDocument();
  });

  it("names the credential when a machine token did it", async () => {
    audit.mockResolvedValue({
      events: [event({ actorKind: "token", actorTokenId: "abcdef0123456789" })],
      cursor: null,
    });
    renderWithProviders(<AuditLog />);

    expect(await screen.findByText("token abcdef01")).toBeInTheDocument();
  });

  it("filters by actor", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuditLog />);

    await user.type(await screen.findByLabelText("Actor"), "bob");
    // The query key carries the filter, so the last call is the filtered one.
    expect(audit).toHaveBeenLastCalledWith({ actor: "bob" });
  });

  it("pages with the cursor the server returned, never an offset", async () => {
    const user = userEvent.setup();
    audit.mockResolvedValueOnce({ events: [event()], cursor: "1700000000000:e1" });
    audit.mockResolvedValueOnce({ events: [event({ id: "e2", action: "member.add" })], cursor: null });

    renderWithProviders(<AuditLog />);
    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(audit).toHaveBeenLastCalledWith({ cursor: "1700000000000:e1" });
    expect(await screen.findByText("member.add")).toBeInTheDocument();
  });

  it("says so when there is nothing, and why a pull is not there", async () => {
    audit.mockResolvedValue({ events: [], cursor: null });
    renderWithProviders(<AuditLog />);

    expect(await screen.findByText(/Pulls are counted rather than audited/)).toBeInTheDocument();
  });
});
