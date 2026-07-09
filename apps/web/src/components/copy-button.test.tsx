import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton } from "./copy-button";

function stubClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("CopyButton", () => {
  it("copies the whole value, not what is displayed", async () => {
    const writeText = stubClipboard();
    const digest = `sha256:${"a".repeat(64)}`;
    render(<CopyButton value={digest} />);

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(digest);
  });

  it("confirms the copy, so the click is never silent", async () => {
    stubClipboard();
    render(<CopyButton value="x" />);

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
  });

  it("reverts to its idle label after a moment", async () => {
    stubClipboard();
    vi.useFakeTimers();
    try {
      render(<CopyButton value="x" />);

      // Neither `userEvent` nor `waitFor` makes progress under fake timers -
      // both wait on timers that only this test advances. Drive the component
      // directly and flush the clipboard promise by hand.
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a custom label for screen readers", () => {
    stubClipboard();
    render(<CopyButton value="x" label="Copy token" />);
    expect(screen.getByRole("button", { name: "Copy token" })).toBeInTheDocument();
  });
});
