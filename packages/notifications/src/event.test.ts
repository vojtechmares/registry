import { describe, expect, it } from "vitest";
import { type NotificationEvent, describeEvent, isEventType, renderEmail, toPayload } from "./event.js";
import { type NotificationPolicy, policiesFor, policyWants } from "./policy.js";

const event: NotificationEvent = {
  id: "evt-1",
  type: "PUSH_ARTIFACT",
  occurredAt: "2026-07-10T00:00:00.000Z",
  project: "acme",
  repository: "acme/api",
  tag: "v1.2.3",
  digest: `sha256:${"ab".repeat(32)}`,
  actor: "alice",
};

const policy = (overrides: Partial<NotificationPolicy> = {}): NotificationPolicy => ({
  id: "p1",
  project: "acme",
  name: "slack",
  enabled: true,
  targetType: "webhook",
  target: "https://example.com/hook",
  eventTypes: ["PUSH_ARTIFACT"],
  ...overrides,
});

describe("isEventType", () => {
  it("accepts the known types and nothing else", () => {
    expect(isEventType("PUSH_ARTIFACT")).toBe(true);
    expect(isEventType("QUOTA_EXCEEDED")).toBe(true);
    expect(isEventType("push_artifact")).toBe(false);
    expect(isEventType("ANYTHING")).toBe(false);
  });
});

describe("toPayload", () => {
  it("carries a version, so a recipient can reject what it does not understand", () => {
    expect(toPayload(event)).toEqual({ version: 1, event });
  });
});

describe("describeEvent", () => {
  it("names the repository and reference", () => {
    expect(describeEvent(event)).toBe("Artifact pushed to acme/api:v1.2.3");
  });

  it("falls back to the digest when there is no tag", () => {
    expect(describeEvent({ ...event, tag: null })).toContain("sha256:");
  });

  it("falls back to the project when there is no repository", () => {
    const quota: NotificationEvent = {
      id: "evt-2",
      type: "QUOTA_EXCEEDED",
      occurredAt: event.occurredAt,
      project: "acme",
    };
    expect(describeEvent(quota)).toBe("Project acme is over its storage quota");
  });
});

describe("renderEmail", () => {
  it("subjects the mail with the description and lists the facts", () => {
    const mail = renderEmail(event);
    expect(mail.subject).toBe(describeEvent(event));
    expect(mail.text).toContain("Project:    acme");
    expect(mail.text).toContain("Repository: acme/api");
    expect(mail.text).toContain("Tag:        v1.2.3");
    expect(mail.text).toContain("Actor:      alice");
  });

  it("omits the fields an event does not carry", () => {
    const mail = renderEmail({ id: "e", type: "CLEANUP", occurredAt: "x", project: "acme" });
    expect(mail.text).not.toContain("Repository:");
    expect(mail.text).not.toContain("Tag:");
  });

  it("includes details when there are any", () => {
    const mail = renderEmail({ ...event, data: { tagsRemoved: 3 } });
    expect(mail.text).toContain("tagsRemoved");
  });
});

describe("policyWants", () => {
  it("matches an enabled policy in the right project listening for the type", () => {
    expect(policyWants(policy(), event)).toBe(true);
  });

  it("ignores a disabled policy", () => {
    expect(policyWants(policy({ enabled: false }), event)).toBe(false);
  });

  it("never crosses a project boundary", () => {
    expect(policyWants(policy({ project: "other" }), event)).toBe(false);
  });

  it("ignores a type it does not listen for", () => {
    expect(policyWants(policy({ eventTypes: ["PULL_ARTIFACT"] }), event)).toBe(false);
  });

  it("listens to nothing when no types are set, rather than to everything", () => {
    expect(policyWants(policy({ eventTypes: [] }), event)).toBe(false);
  });
});

describe("policiesFor", () => {
  it("selects only the policies that want the event", () => {
    const selected = policiesFor(
      [policy({ id: "a" }), policy({ id: "b", eventTypes: ["PULL_ARTIFACT"] }), policy({ id: "c" })],
      event,
    );
    expect(selected.map((p) => p.id)).toEqual(["a", "c"]);
  });
});
