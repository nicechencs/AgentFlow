import { spawnSync } from "node:child_process";

import type { TaskRecord } from "@workforce/application";
import { OsProcessController } from "@workforce/process";
import type { StartRunRequest } from "@workforce/protocol";
import {
  createClaudeCodeRuntime,
  detectClaudeCode,
  type ClaudeCodeResolvedStartContext,
  type ClaudeCodeRuntimeAdapter,
  type ClaudeCodeRuntimeAdapterOptions,
} from "@workforce/runtime-claude-code";
import { RuntimeSdkError } from "@workforce/runtime-sdk";

import { buildCodexPrompt } from "./codex.js";
import type { CompositionWorktreeHost } from "./worktree-host.js";

const AUTH_PROBE_TIMEOUT_MS = 15_000;

/**
 * Composition hook: inject the captured Process port. Start stays fail-closed
 * until detect, login, and `resolveStart` all allow. A missing CLI or a missing
 * login never falls back to Mock or to another runtime.
 */
export function createComposedClaudeCodeRuntime(
  options: Pick<ClaudeCodeRuntimeAdapterOptions, "detect" | "resolveStart" | "platform"> = {},
): ClaudeCodeRuntimeAdapter {
  return createClaudeCodeRuntime({
    process: new OsProcessController(),
    ...options,
  });
}

/**
 * Asks the CLI itself (`claude auth status`, JSON) whether a login exists.
 * Only the `loggedIn` flag is read; no token or account detail is kept.
 */
export function claudeCodeLoggedIn(executable: string, run: typeof spawnSync = spawnSync): boolean {
  try {
    const result = run(executable, ["auth", "status"], {
      encoding: "utf8",
      timeout: AUTH_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0 && !result.stdout) {
      return false;
    }
    const parsed: unknown = JSON.parse(String(result.stdout));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { loggedIn?: unknown }).loggedIn === true
    );
  } catch {
    return false;
  }
}

export interface ClaudeCodeBlockerProbes {
  detect?: typeof detectClaudeCode;
  loggedIn?: (executable: string) => boolean;
}

const BLOCKER_CACHE_OK_MS = 30_000;
const BLOCKER_CACHE_BLOCKED_MS = 3_000;
let blockerCache: { at: number; value: string | undefined } | undefined;

/**
 * The login probe runs the CLI, so the default (real) probe result is cached
 * briefly. A recent "blocked" answer expires fast so a fresh login is noticed.
 */
export function describeClaudeCodeHostBlocker(
  probes?: ClaudeCodeBlockerProbes,
): string | undefined {
  if (probes) {
    return probeClaudeCodeBlocker(probes);
  }
  const now = Date.now();
  if (
    blockerCache &&
    now - blockerCache.at <
      (blockerCache.value === undefined ? BLOCKER_CACHE_OK_MS : BLOCKER_CACHE_BLOCKED_MS)
  ) {
    return blockerCache.value;
  }
  const value = probeClaudeCodeBlocker({});
  blockerCache = { at: now, value };
  return value;
}

function probeClaudeCodeBlocker(probes: ClaudeCodeBlockerProbes): string | undefined {
  const detection = (probes.detect ?? detectClaudeCode)();
  if (!detection.found || detection.executable === undefined) {
    return "未检测到 Claude Code 命令行（claude）。请先安装 Claude Code 并重试；不会悄悄改用模拟执行。";
  }
  const loggedIn = (probes.loggedIn ?? ((file: string) => claudeCodeLoggedIn(file)))(
    detection.executable,
  );
  if (!loggedIn) {
    return "Claude Code 还没有登录。请在终端运行 claude 完成登录后重试；不会悄悄改用模拟执行。";
  }
  return undefined;
}

export function resolveComposedClaudeCodeStart(input: {
  request: StartRunRequest;
  worktrees: CompositionWorktreeHost;
  task?: TaskRecord;
  objective?: string;
  blocker?: () => string | undefined;
}): ClaudeCodeResolvedStartContext | undefined {
  const blocker = (input.blocker ?? describeClaudeCodeHostBlocker)();
  if (blocker) {
    throw new RuntimeSdkError("validation_failed", blocker, {
      details: { runtime: "claude-code" },
    });
  }
  const task = input.task;
  const provisioned = task ? input.worktrees.getForTask(task.id, input.request.attempt) : undefined;
  const cwd =
    provisioned?.worktreePath ?? (task ? input.worktrees.projectCwd(task.projectId) : undefined);
  if (!cwd || cwd.trim().length === 0) {
    return undefined;
  }
  return {
    cwd,
    prompt: buildCodexPrompt({
      ...(task ? { task } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
    }),
    sandbox: task?.role === "reviewer" ? "read-only" : "workspace-write",
    approval: "never",
  };
}
