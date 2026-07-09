import { describe, expect, it } from "vitest";
import { QUOTA_UNLIMITED, formatBytes, quotaAdmits, remainingQuota } from "./quota.js";

describe("quotaAdmits", () => {
  it("admits anything when the project has no quota", () => {
    expect(quotaAdmits({ usedBytes: 1e12, quotaBytes: QUOTA_UNLIMITED }, 1e12)).toBe(true);
  });

  it("admits a write that exactly fills the quota", () => {
    expect(quotaAdmits({ usedBytes: 90, quotaBytes: 100 }, 10)).toBe(true);
  });

  it("refuses a write that would exceed the quota by one byte", () => {
    expect(quotaAdmits({ usedBytes: 90, quotaBytes: 100 }, 11)).toBe(false);
  });

  it("refuses a write to a project already over quota", () => {
    // Usage can exceed a quota that was lowered after the fact.
    expect(quotaAdmits({ usedBytes: 200, quotaBytes: 100 }, 1)).toBe(false);
  });

  it("admits a zero-byte write to a project already over quota", () => {
    // A blob already stored in the project adds nothing, and must not be refused.
    expect(quotaAdmits({ usedBytes: 200, quotaBytes: 100 }, 0)).toBe(true);
  });

  it("refuses any write under a quota of zero", () => {
    expect(quotaAdmits({ usedBytes: 0, quotaBytes: 0 }, 1)).toBe(false);
  });
});

describe("remainingQuota", () => {
  it("is null when unlimited", () => {
    expect(remainingQuota({ usedBytes: 5, quotaBytes: QUOTA_UNLIMITED })).toBeNull();
  });

  it("never goes negative", () => {
    expect(remainingQuota({ usedBytes: 150, quotaBytes: 100 })).toBe(0);
  });

  it("is the difference otherwise", () => {
    expect(remainingQuota({ usedBytes: 40, quotaBytes: 100 })).toBe(60);
  });
});

describe("formatBytes", () => {
  it("renders binary units the way registry clients report them", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 3)).toBe("1 GiB");
  });
});
