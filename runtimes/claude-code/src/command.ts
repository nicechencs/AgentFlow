export type ClaudeCodeSandboxMode = "read-only" | "workspace-write";
export type ClaudeCodeApprovalMode = "never" | "on-request";

export interface ClaudeCodeExecCommand {
  executable: string;
  cwd: string;
  sandbox: ClaudeCodeSandboxMode;
  approval: ClaudeCodeApprovalMode;
}

/**
 * Builds argv only. The prompt is deliberately read from stdin so it does not
 * appear in the process list. `cwd` is applied by the Process port at spawn
 * time (the `claude` CLI has no `-C` flag). Non-interactive `-p` mode cannot
 * answer permission prompts, so `approval` must be "never" and the tool set is
 * fixed up front by `sandbox`: read-only runs may only read, workspace-write
 * runs may also edit files and run shell commands inside the managed worktree.
 */
export function buildClaudeCodeExecArgv(command: ClaudeCodeExecCommand): string[] {
  if (command.executable.length === 0) {
    throw new Error("Claude Code executable is required");
  }
  if (command.cwd.length === 0) {
    throw new Error("Claude Code workspace cwd is required");
  }
  if (command.approval !== "never") {
    throw new Error("Claude Code non-interactive mode only supports approval=never");
  }
  const base = [
    command.executable,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-prompts",
    "none",
  ];
  if (command.sandbox === "read-only") {
    return [...base, "--permission-mode", "dontAsk", "--allowedTools", "Read", "Grep", "Glob"];
  }
  return [
    ...base,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "Bash",
  ];
}
