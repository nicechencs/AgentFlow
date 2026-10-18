import type { StartRunRequest } from "@workforce/protocol";

import type { ClaudeCodeApprovalMode, ClaudeCodeSandboxMode } from "./command.js";

/**
 * Host/composition-resolved inputs. Public `StartRunRequest` stays unchanged;
 * the Adapter must not interpret `snapshotRef` or `workspaceInstanceId`.
 */
export interface ClaudeCodeResolvedStartContext {
  cwd: string;
  prompt: string;
  sandbox: ClaudeCodeSandboxMode;
  approval: ClaudeCodeApprovalMode;
  environment?: Record<string, string>;
}

export type ResolveClaudeCodeStartContext = (
  request: StartRunRequest,
) =>
  ClaudeCodeResolvedStartContext | undefined | Promise<ClaudeCodeResolvedStartContext | undefined>;

const SANDBOX_MODES = new Set<ClaudeCodeSandboxMode>(["read-only", "workspace-write"]);
const APPROVAL_MODES = new Set<ClaudeCodeApprovalMode>(["never", "on-request"]);

export function parseClaudeCodeResolvedStartContext(
  value: ClaudeCodeResolvedStartContext | undefined,
): ClaudeCodeResolvedStartContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value.cwd !== "string" || value.cwd.trim().length === 0 || value.cwd.includes("\0")) {
    return undefined;
  }
  if (typeof value.prompt !== "string" || value.prompt.length === 0) {
    return undefined;
  }
  if (!SANDBOX_MODES.has(value.sandbox) || !APPROVAL_MODES.has(value.approval)) {
    return undefined;
  }
  if (value.environment !== undefined) {
    if (typeof value.environment !== "object" || value.environment === null) {
      return undefined;
    }
    for (const [key, envValue] of Object.entries(value.environment)) {
      if (key.length === 0 || key.includes("=") || key.includes("\0")) {
        return undefined;
      }
      if (typeof envValue !== "string" || envValue.includes("\0")) {
        return undefined;
      }
    }
  }
  return {
    cwd: value.cwd,
    prompt: value.prompt,
    sandbox: value.sandbox,
    approval: value.approval,
    ...(value.environment ? { environment: { ...value.environment } } : {}),
  };
}
