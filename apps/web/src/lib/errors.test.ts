import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { fieldErrorsOf, presentError, problemNameOf } from "./errors";

const INVALID = "https://registry.mareshq.com/problems/invalid-request";

describe("presentError", () => {
  it("shows the refusal's detail sentence", () => {
    const error = new ApiError(403, "about:blank", "Forbidden", "You may not do that.");
    expect(presentError(error, "fallback")).toBe("You may not do that.");
  });

  it("falls back when the thrown value is not a refusal we named", () => {
    expect(presentError(new Error("boom"), "Could not save")).toBe("Could not save");
    expect(presentError("boom", "Could not save")).toBe("Could not save");
  });
});

describe("fieldErrorsOf", () => {
  it("keys a pointer fault by its first body segment", () => {
    const error = new ApiError(400, INVALID, "Invalid request", "no", [
      { detail: "Enter a URL.", pointer: "/url" },
      { detail: "Pick a version.", pointer: "/rules/1/tags/semver" },
    ]);
    const errors = fieldErrorsOf(error);
    expect(errors.get("url")).toBe("Enter a URL.");
    expect(errors.get("rules")).toBe("Pick a version.");
  });

  it("keys a parameter fault by the parameter name", () => {
    const error = new ApiError(400, INVALID, "Invalid request", "no", [
      { detail: "Unknown resource type.", parameter: "resourceType" },
    ]);
    expect(fieldErrorsOf(error).get("resourceType")).toBe("Unknown resource type.");
  });

  it("keeps the first message per field", () => {
    const error = new ApiError(400, INVALID, "Invalid request", "no", [
      { detail: "First.", pointer: "/url" },
      { detail: "Second.", pointer: "/url" },
    ]);
    expect(fieldErrorsOf(error).get("url")).toBe("First.");
  });

  it("leaves out a body-level fault that names no field", () => {
    const error = new ApiError(400, INVALID, "Invalid request", "no", [
      { detail: "The body is malformed." },
      { detail: "Enter a URL.", pointer: "/url" },
    ]);
    const errors = fieldErrorsOf(error);
    expect(errors.size).toBe(1);
    expect(errors.get("url")).toBe("Enter a URL.");
  });

  it("returns an empty map for a value that is not a refusal", () => {
    expect(fieldErrorsOf(new Error("boom")).size).toBe(0);
    expect(fieldErrorsOf(undefined).size).toBe(0);
  });
});

describe("problemNameOf", () => {
  it("reads the type's final segment, whichever host served it", () => {
    const error = new ApiError(429, "https://registry.mareshq.com/problems/rate-limited", "Slow down", "no");
    expect(problemNameOf(error)).toBe("rate-limited");
  });

  it("is null for a value that is not a refusal", () => {
    expect(problemNameOf(new Error("boom"))).toBeNull();
  });
});
