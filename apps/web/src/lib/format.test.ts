import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatRelativeTime, pullCommand, shortDigest } from "./format";

describe("formatBytes", () => {
  it("uses binary units, as container tooling does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12 MiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
  });

  it("drops the decimal once the number is large enough not to need it", () => {
    expect(formatBytes(9.5 * 1024)).toBe("9.5 KiB");
    expect(formatBytes(10 * 1024)).toBe("10 KiB");
  });

  it("renders nonsense as a dash rather than NaN", () => {
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });
});

describe("shortDigest", () => {
  it("keeps the algorithm and truncates the hex", () => {
    expect(shortDigest(`sha256:${"a".repeat(64)}`)).toBe(`sha256:${"a".repeat(12)}`);
    expect(shortDigest(`sha256:${"a".repeat(64)}`, 6)).toBe(`sha256:${"a".repeat(6)}`);
  });

  it("tolerates a value that is not a digest", () => {
    expect(shortDigest("latest")).toBe("latest");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);

  it("describes the recent past", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("30 seconds ago");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 minutes ago");
    expect(formatRelativeTime(now - 5 * 3_600_000, now)).toBe("5 hours ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
  });

  it("describes the future", () => {
    expect(formatRelativeTime(now + 2 * 86_400_000, now)).toBe("in 2 days");
  });
});

describe("formatDate", () => {
  it("renders a stable, sortable timestamp", () => {
    expect(formatDate(Date.UTC(2026, 6, 9, 18, 30, 5))).toBe("2026-07-09 18:30:05");
  });
});

describe("pullCommand", () => {
  it("separates a tag with a colon", () => {
    expect(pullCommand("myorg/app", "v1", "registry.mareshq.com")).toBe(
      "docker pull registry.mareshq.com/myorg/app:v1",
    );
  });

  it("separates a digest with an at sign, which is what the client requires", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(pullCommand("myorg/app", digest, "registry.mareshq.com")).toBe(
      `docker pull registry.mareshq.com/myorg/app@${digest}`,
    );
  });
});
