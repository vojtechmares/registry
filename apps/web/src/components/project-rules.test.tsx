import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CleanupPolicy,
  NotificationDelivery,
  NotificationPolicySummary,
  ReplicationExecution,
  ReplicationRuleSummary,
} from "@registry/api-contract";
import { ProjectRules } from "./project-rules";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  cleanupPolicy: vi.fn(),
  setCleanupPolicy: vi.fn(),
  notifications: vi.fn(),
  deliveries: vi.fn(),
  createNotification: vi.fn(),
  deleteNotification: vi.fn(),
  replicationRules: vi.fn(),
  executions: vi.fn(),
  createReplicationRule: vi.fn(),
  runReplicationRule: vi.fn(),
  deleteReplicationRule: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks,
}));

/** Two hours, not one: exactly one hour lands on the minute/hour rounding boundary. */
const HOUR = 7_200_000;

const policy: CleanupPolicy = {
  project: "acme",
  enabled: true,
  schedule: "0 3 * * *",
  rules: [{ repositories: "*", tags: {}, keepLast: 5, keepWithinDays: null }],
  untaggedOlderThanDays: 7,
  nextRunAt: Date.now() + HOUR,
  lastRunAt: Date.now() - HOUR,
  lastResult: { tagsRemoved: 3, untaggedRemoved: 2 },
};

const webhook: NotificationPolicySummary = {
  id: "n1",
  project: "acme",
  name: "ci-hook",
  enabled: true,
  targetType: "webhook",
  target: "https://example.com/hook",
  eventTypes: ["PUSH_ARTIFACT"],
};

const delivery: NotificationDelivery = {
  id: "d1",
  policyId: "n1",
  eventType: "PUSH_ARTIFACT",
  status: "failed",
  responseStatus: 500,
  error: "upstream exploded",
  createdAt: Date.now() - HOUR,
};

const rule: ReplicationRuleSummary = {
  id: "r1",
  project: "acme",
  name: "downstream",
  enabled: true,
  direction: "push",
  remoteUrl: "https://mirror.example.com",
  destinationNamespace: "",
  repositoryFilter: "*",
  sourceRepositories: [],
  tagFilter: {},
  trigger: "event",
  schedule: null,
  remoteUsername: null,
  nextRunAt: null,
  lastRunAt: Date.now() - HOUR,
  lastResult: "copied 1 manifest",
};

const execution: ReplicationExecution = {
  id: "e1",
  ruleId: "r1",
  status: "succeeded",
  repository: "acme/api",
  reference: "v1.2.3",
  manifests: 1,
  blobs: 4,
  error: null,
  createdAt: Date.now() - HOUR,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cleanupPolicy.mockResolvedValue(policy);
  mocks.setCleanupPolicy.mockResolvedValue({ ...policy, enabled: false });
  mocks.notifications.mockResolvedValue([webhook]);
  mocks.deliveries.mockResolvedValue([delivery]);
  mocks.deleteNotification.mockResolvedValue(undefined);
  mocks.replicationRules.mockResolvedValue([rule]);
  mocks.executions.mockResolvedValue([execution]);
  mocks.runReplicationRule.mockResolvedValue({ queued: true });
  mocks.deleteReplicationRule.mockResolvedValue(undefined);
});

describe("the cleanup card", () => {
  it("reports when the policy last ran, what it removed, and when it runs next", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText(/Next run in 2 hours/i)).toBeInTheDocument();
    expect(screen.getByText(/removing 3 tags and 2 untagged manifests/i)).toBeInTheDocument();
  });

  it("seeds the form from the stored policy rather than from a default", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByLabelText(/Schedule/i)).toHaveValue("0 3 * * *");
    expect(screen.getByLabelText(/Keep newest/i)).toHaveValue(5);
  });

  // Disabling must not silently drop the rules the operator spent time writing.
  it("disables the policy while preserving its schedule and rules", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByLabelText("Enabled"));

    expect(mocks.setCleanupPolicy).toHaveBeenCalledWith("acme", {
      enabled: false,
      schedule: policy.schedule,
      rules: policy.rules,
      untaggedOlderThanDays: 7,
    });
  });

  it("says cleanup is off when it is off", async () => {
    mocks.cleanupPolicy.mockResolvedValue({ ...policy, enabled: false, nextRunAt: null });
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText(/Cleanup is off/i)).toBeInTheDocument();
  });

  // An armed policy must never be reported as off just because the next run is unset.
  it("does not call an enabled policy off when it has no next run", async () => {
    mocks.cleanupPolicy.mockResolvedValue({ ...policy, enabled: true, nextRunAt: null });
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText(/Cleanup is on/i)).toBeInTheDocument();
    expect(screen.queryByText(/Cleanup is off/i)).not.toBeInTheDocument();
  });

  it("turns cleanup on when the very first rule is saved", async () => {
    mocks.cleanupPolicy.mockResolvedValue({ ...policy, enabled: false, rules: [], nextRunAt: null });
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(mocks.setCleanupPolicy).toHaveBeenCalledWith("acme", expect.objectContaining({ enabled: true }));
  });

  it("leaves a deliberately disabled policy disabled when its schedule is edited", async () => {
    mocks.cleanupPolicy.mockResolvedValue({ ...policy, enabled: false, nextRunAt: null });
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(mocks.setCleanupPolicy).toHaveBeenCalledWith("acme", expect.objectContaining({ enabled: false }));
  });
});

describe("the notifications card", () => {
  it("lists the webhooks that exist", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText("https://example.com/hook")).toBeInTheDocument();
    expect(screen.getAllByText("ci-hook").length).toBeGreaterThan(0);
  });

  it("deletes a webhook by its id", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByRole("button", { name: "Delete webhook ci-hook" }));
    expect(mocks.deleteNotification).toHaveBeenCalledWith("acme", "n1");
  });

  it("shows a failed delivery against the webhook's name, with the response and the error", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText("Recent deliveries")).toBeInTheDocument();
    expect(screen.getByText("failed (500)")).toBeInTheDocument();
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();
    // Once in the policy list, once resolved from the delivery's policy id: a
    // reader of the log sees the webhook's name rather than a bare uuid.
    expect(screen.getAllByText("ci-hook")).toHaveLength(2);
  });

  it("hides the delivery log entirely when nothing has been delivered", async () => {
    mocks.deliveries.mockResolvedValue([]);
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText("ci-hook")).toBeInTheDocument();
    expect(screen.queryByText("Recent deliveries")).not.toBeInTheDocument();
  });
});

describe("the replication card", () => {
  it("lists the rules that exist, with their direction and last result", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText("https://mirror.example.com")).toBeInTheDocument();
    expect(screen.getByText("push")).toBeInTheDocument();
    expect(screen.getByText(/copied 1 manifest/)).toBeInTheDocument();
  });

  it("runs a rule now", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByRole("button", { name: "Run rule downstream now" }));
    expect(mocks.runReplicationRule).toHaveBeenCalledWith("acme", "r1");
  });

  it("deletes a rule", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectRules name="acme" />);

    await user.click(await screen.findByRole("button", { name: "Delete rule downstream" }));
    expect(mocks.deleteReplicationRule).toHaveBeenCalledWith("acme", "r1");
  });

  it("shows what each run copied, against the rule's name", async () => {
    renderWithProviders(<ProjectRules name="acme" />);

    expect(await screen.findByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("acme/api:v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("1 manifest, 4 blobs")).toBeInTheDocument();
    // As with deliveries: the rule's name, resolved from the execution's rule id.
    expect(screen.getAllByText("downstream")).toHaveLength(2);
  });
});
