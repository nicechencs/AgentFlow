import { describe, expect, it } from "vitest";

import { buildClaudeCodeExecArgv } from "./command.js";

describe("buildClaudeCodeExecArgv", () => {
  it("read-only runs get only read tools and never prompt", () => {
    expect(
      buildClaudeCodeExecArgv({
        executable: "/opt/claude",
        cwd: "/managed/run",
        sandbox: "read-only",
        approval: "never",
      }),
    ).toEqual([
      "/opt/claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-prompts",
      "none",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
    ]);
  });

  it("workspace-write runs may edit and run commands, but never bypass permissions", () => {
    const argv = buildClaudeCodeExecArgv({
      executable: "claude",
      cwd: "/managed/run",
      sandbox: "workspace-write",
      approval: "never",
    });
    expect(argv).toContain("acceptEdits");
    expect(argv).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("bypassPermissions");
  });

  it("keeps the prompt out of argv (it goes through stdin)", () => {
    const argv = buildClaudeCodeExecArgv({
      executable: "claude",
      cwd: "/managed/run",
      sandbox: "read-only",
      approval: "never",
    });
    expect(argv.some((item) => item.includes("\n"))).toBe(false);
  });

  it("rejects on-request approval because -p cannot answer prompts", () => {
    expect(() =>
      buildClaudeCodeExecArgv({
        executable: "claude",
        cwd: "/managed/run",
        sandbox: "workspace-write",
        approval: "on-request",
      }),
    ).toThrow(/approval=never/u);
  });
});
