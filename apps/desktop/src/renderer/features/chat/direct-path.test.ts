import { describe, expect, it, vi } from "vitest";

import type { DesktopClient, TaskDto, RunDto } from "@workforce/desktop-client";

import { handleIntent } from "./intent.js";
import {
  DIRECT_READY_NOTE,
  DIRECT_UNSUPPORTED_NOTE,
  landStartDirect,
  startDirectIntentFromHanging,
} from "./model.js";

function task(overrides: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "tsk_1",
    projectId: "prj_1",
    title: "去做",
    status: "ready",
    role: "developer",
    stateRevision: 1,
    attempt: 1,
    maxAttempts: 2,
    priority: 50,
    requiresReview: false,
    dependsOn: [],
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  } as TaskDto;
}

function run(overrides: Partial<RunDto> = {}): RunDto {
  return {
    id: "run_1",
    projectId: "prj_1",
    taskId: "tsk_1",
    status: "running",
    orchestrationMode: "direct",
    stateRevision: 1,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  } as RunDto;
}

describe("Chat「去做」direct 路径", () => {
  it("能力未开时返回 unsupported，不建 Task/Run", async () => {
    const client = {
      createAdHocTask: vi.fn(),
      startTaskRun: vi.fn(),
    } as unknown as DesktopClient;
    const entries = await handleIntent(
      client,
      startDirectIntentFromHanging({ projectId: "prj_1", title: "去做" }),
      "去做",
      { orchestration: { direct: false, workflowBound: true } } as never,
    );
    expect(entries).toEqual([
      expect.objectContaining({ kind: "unsupported", action: "direct", code: "unsupported_capability" }),
    ]);
    expect(client.createAdHocTask).not.toHaveBeenCalled();
    expect(client.startTaskRun).not.toHaveBeenCalled();
  });

  it("无 taskId 时先建 ad-hoc 再 POST Task Run（direct）", async () => {
    const client = {
      createAdHocTask: vi.fn(async () => task()),
      startTaskRun: vi.fn(async () => run()),
      getTask: vi.fn(),
    } as unknown as DesktopClient;
    const landed = await landStartDirect(
      client,
      startDirectIntentFromHanging({ projectId: "prj_1", title: "修这个 bug" }),
    );
    expect(client.createAdHocTask).toHaveBeenCalledTimes(1);
    expect(client.startTaskRun).toHaveBeenCalledWith(
      "tsk_1",
      expect.anything(),
      expect.objectContaining({ orchestrationMode: "direct" }),
    );
    expect(landed.createdAdHocTask).toBe(true);
    expect(landed.run.id).toBe("run_1");
  });

  it("文案说明默认 Claude Code、缺 CLI 不回退", () => {
    expect(DIRECT_READY_NOTE).toContain("Claude Code");
    expect(DIRECT_READY_NOTE).toContain("不会回退 Mock");
    expect(DIRECT_UNSUPPORTED_NOTE).toContain("unsupported_capability");
  });
});
