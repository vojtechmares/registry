import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PullCommand } from "./pull-command";

describe("PullCommand", () => {
  it("renders a command a visitor can paste straight into a shell", () => {
    render(<PullCommand repository="myorg/app" reference="v1" host="registry.mareshq.com" />);
    expect(screen.getByText("docker pull registry.mareshq.com/myorg/app:v1")).toBeInTheDocument();
  });

  it("uses `@` for a digest, which is what the client requires", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    render(<PullCommand repository="myorg/app" reference={digest} host="example.com" />);
    expect(screen.getByText(`docker pull example.com/myorg/app@${digest}`)).toBeInTheDocument();
  });

  it("falls back to the page's own host, so any deployment prints the right thing", () => {
    render(<PullCommand repository="a/b" reference="latest" />);
    expect(screen.getByText(`docker pull ${window.location.host}/a/b:latest`)).toBeInTheDocument();
  });

  it("offers the command for copying", () => {
    render(<PullCommand repository="a/b" reference="latest" host="h" />);
    expect(screen.getByRole("button", { name: "Copy pull command" })).toBeInTheDocument();
  });
});
