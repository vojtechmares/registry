import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "./event.js";
import { events } from "./construct.js";

const AT = Date.parse("2026-07-10T00:00:00.000Z");

const artifact = {
  project: "acme",
  repository: "acme/api",
  tag: "v1",
  digest: "sha256:abc",
  actor: "alice",
  at: AT,
};

describe("event constructors", () => {
  it("has exactly one constructor per declared event type", () => {
    // The compile-time `satisfies` guard proves this too; asserting it at runtime
    // guards against a type gaining a producer that is never wired up.
    expect(Object.keys(events).toSorted()).toEqual([...EVENT_TYPES].toSorted());
  });

  it("builds a push event with a fresh id, an ISO timestamp, and the artifact's coordinates", () => {
    const event = events.PUSH_ARTIFACT(artifact);
    expect(event).toMatchObject({
      type: "PUSH_ARTIFACT",
      occurredAt: "2026-07-10T00:00:00.000Z",
      project: "acme",
      repository: "acme/api",
      tag: "v1",
      digest: "sha256:abc",
      actor: "alice",
    });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stamps the type each artifact constructor names", () => {
    expect(events.PULL_ARTIFACT(artifact).type).toBe("PULL_ARTIFACT");
    expect(events.DELETE_ARTIFACT(artifact).type).toBe("DELETE_ARTIFACT");
  });

  it("gives each event its own id", () => {
    expect(events.PUSH_ARTIFACT(artifact).id).not.toBe(events.PUSH_ARTIFACT(artifact).id);
  });

  it("omits an empty digest rather than carrying a blank one", () => {
    const event = events.PUSH_ARTIFACT({ ...artifact, digest: "" });
    expect("digest" in event).toBe(false);
  });

  it("normalises a missing tag to null", () => {
    const { tag: _tag, ...untagged } = artifact;
    const event = events.PUSH_ARTIFACT(untagged);
    expect(event.tag).toBeNull();
  });

  it("builds a quota event against the project, with no repository", () => {
    const event = events.QUOTA_EXCEEDED({ project: "acme", at: AT, data: { over: 10 } });
    expect(event).toMatchObject({ type: "QUOTA_EXCEEDED", project: "acme", data: { over: 10 } });
    expect(event.repository).toBeUndefined();
  });

  it("builds a replication event that carries its repository", () => {
    const event = events.REPLICATION({ project: "acme", repository: "acme/api", at: AT });
    expect(event).toMatchObject({ type: "REPLICATION", repository: "acme/api" });
  });

  it("builds a cleanup event against the project", () => {
    const event = events.CLEANUP({ project: "acme", at: AT, data: { tagsRemoved: 3 } });
    expect(event).toMatchObject({ type: "CLEANUP", project: "acme", data: { tagsRemoved: 3 } });
  });
});
