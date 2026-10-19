import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_ADAPTER_ID } from "@workforce/runtime-claude-code";
import { CODEX_ADAPTER_ID } from "@workforce/runtime-codex";
import { createStartRunRequest } from "@workforce/runtime-sdk";
import type { RuntimeAdapter, RuntimeHandle } from "@workforce/runtime-spi";

import {
  claudeCodeLoggedIn,
  createComposedClaudeCodeRuntime,
  describeClaudeCodeHostBlocker,
} from "../src/composition/claude-code.js";
import { DEFAULT_LIVE_RUNTIME_ID } from "../src/composition/catalog.js";
import { createComposedAppServices } from "../src/composition/index.js";
import { RoutingRuntimeAdapter } from "../src/composition/runtime-router.js";

describe("Claude Code composition", () => {
  it("says clearly (in Chinese) when the CLI is missing, without falling back", () => {
    const message = describeClaudeCodeHostBlocker({
      detect: () => ({ found: false, source: "none" }),
    });
    expect(message).toContain("未检测到 Claude Code");
    expect(message).toContain("不会悄悄改用模拟执行");
  });

  it("says clearly (in Chinese) when the CLI is not logged in", () => {
    const message = describeClaudeCodeHostBlocker({
      detect: () => ({ found: true, executable: "/opt/claude", source: "path" }),
      loggedIn: () => false,
    });
    expect(message).toContain("还没有登录");
  });

  it("has no blocker when the CLI exists and is logged in", () => {
    expect(
      describeClaudeCodeHostBlocker({
        detect: () => ({ found: true, executable: "/opt/claude", source: "path" }),
        loggedIn: () => true,
      }),
    ).toBeUndefined();
  });

  it("reads only the loggedIn flag from `claude auth status`", () => {
    const run = ((_file: string, args: string[]) => {
      expect(args).toEqual(["auth", "status"]);
      return { status: 0, stdout: '{"loggedIn":true,"authMethod":"oauth_token"}' };
    }) as never;
    expect(claudeCodeLoggedIn("/opt/claude", run)).toBe(true);
    const out = (() => ({ status: 1, stdout: '{"loggedIn":false}' })) as never;
    expect(claudeCodeLoggedIn("/opt/claude", out)).toBe(false);
    const broken = (() => ({ status: 1, stdout: "" })) as never;
    expect(claudeCodeLoggedIn("/opt/claude", broken)).toBe(false);
    const garbage = (() => ({ status: 0, stdout: "not json" })) as never;
    expect(claudeCodeLoggedIn("/opt/claude", garbage)).toBe(false);
  });

  it("refuses start without resolveStart and when the CLI is not detected", async () => {
    const noContext = createComposedClaudeCodeRuntime({
      detect: () => ({ found: true, executable: "/opt/claude", source: "path" }),
      platform: "linux",
    });
    await expect(
      noContext.start(createStartRunRequest({ runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID } })),
    ).rejects.toMatchObject({ code: "unsupported_capability" });

    const missing = createComposedClaudeCodeRuntime({
      detect: () => ({ found: false, source: "none" }),
      resolveStart: () => ({
        cwd: "/managed/run",
        prompt: "do not spawn",
        sandbox: "read-only",
        approval: "never",
      }),
      platform: "linux",
    });
    await expect(
      missing.start(createStartRunRequest({ runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID } })),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});

function stubAdapter(id: string, calls: string[]): RuntimeAdapter {
  const handle = (): RuntimeHandle => ({
    handleId: `hdl_${id}`,
    runId: `run_${id}`,
    adapterId: id,
    createdAt: "2026-10-19T00:00:00.000Z",
  });
  return {
    describe: async () => ({ adapter: { id } }) as never,
    validate: async () => ({ valid: true, checks: [] }),
    start: async () => {
      calls.push(`start:${id}`);
      return handle();
    },
    sendInput: async () => ({ accepted: true }) as never,
    cancel: async () => {
      calls.push(`cancel:${id}`);
      return { operationId: "op", accepted: true };
    },
    inspect: async (ref) => ({ handle: ref, status: "running" }),
    stream: async function* () {},
    reconcile: async (h) => ({ attached: true, status: { handle: h, status: "running" } }),
  };
}

describe("adapter id registry", () => {
  it("keeps Claude Code and Codex ids distinct so a Map cannot overwrite either", () => {
    expect(CLAUDE_CODE_ADAPTER_ID).toBe("claude-code");
    expect(CODEX_ADAPTER_ID).toBe("codex");
    expect(CLAUDE_CODE_ADAPTER_ID).not.toBe(CODEX_ADAPTER_ID);
    expect(DEFAULT_LIVE_RUNTIME_ID).toBe(CLAUDE_CODE_ADAPTER_ID);
    // Same registration shape as app-services live Host.
    const keys = [CLAUDE_CODE_ADAPTER_ID, CODEX_ADAPTER_ID];
    expect(new Set(keys).size).toBe(2);
  });

  it("registers both adapters without overwrite; default id starts Claude Code", async () => {
    const calls: string[] = [];
    const router = new RoutingRuntimeAdapter([
      [CLAUDE_CODE_ADAPTER_ID, stubAdapter(CLAUDE_CODE_ADAPTER_ID, calls)],
      [CODEX_ADAPTER_ID, stubAdapter(CODEX_ADAPTER_ID, calls)],
    ]);
    expect(router.supportsAdapterId(CLAUDE_CODE_ADAPTER_ID)).toBe(true);
    expect(router.supportsAdapterId(CODEX_ADAPTER_ID)).toBe(true);
    expect(router.supportsAdapterId(DEFAULT_LIVE_RUNTIME_ID)).toBe(true);

    await router.start(
      createStartRunRequest({ runtime: { adapterId: DEFAULT_LIVE_RUNTIME_ID } }),
    );
    await router.start(
      createStartRunRequest({ runtime: { adapterId: CODEX_ADAPTER_ID } }),
    );
    expect(calls).toEqual([
      `start:${CLAUDE_CODE_ADAPTER_ID}`,
      `start:${CODEX_ADAPTER_ID}`,
    ]);
  });
});

describe("RoutingRuntimeAdapter", () => {
  it("routes by adapter id, follows the handle, and never falls back for an unknown id", async () => {
    const calls: string[] = [];
    const router = new RoutingRuntimeAdapter([
      ["claude-code", stubAdapter("claude-code", calls)],
      ["codex", stubAdapter("codex", calls)],
    ]);
    expect(router.supportsAdapterId("codex")).toBe(true);
    expect(router.supportsAdapterId("mock")).toBe(false);

    const codexHandle = await router.start(
      createStartRunRequest({ runtime: { adapterId: "codex" } }),
    );
    await router.cancel(codexHandle);
    const ccHandle = await router.start(
      createStartRunRequest({ runtime: { adapterId: "claude-code" } }),
    );
    await router.cancel(ccHandle);
    expect(calls).toEqual([
      "start:codex",
      "cancel:codex",
      "start:claude-code",
      "cancel:claude-code",
    ]);

    await expect(
      router.start(createStartRunRequest({ runtime: { adapterId: "mock" } })),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toHaveLength(4);
  });
});

describe("live Host default runtime", () => {
  it("lists Claude Code first and keeps Codex selectable", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-cc-"));
    const services = await createComposedAppServices({ stateDir });
    try {
      const ids = services.listRuntimes({ limit: 10 } as never).items.map((item) => item.id);
      expect(ids).toEqual(["claude-code", "codex"]);
      expect(services.getRuntime("claude-code")?.displayName).toBe("Claude Code CLI");
      expect(services.getRuntime("codex")).not.toBeNull();
      expect(services.getRuntime("mock")).toBeNull();
      expect(services.getRuntimeCapabilities("claude-code")?.runtimeId).toBe("claude-code");
    } finally {
      await services.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
