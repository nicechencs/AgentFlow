import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { OsProcessController, UNSUPPORTED_CAPTURED_PROCESS_PLATFORMS } from "@workforce/process";
import { protocolVersion } from "@workforce/protocol";

import { buildApi } from "../src/api/index.js";
import { SessionRegistry } from "../src/api/auth.js";
import {
  createComposedAppServices,
  type ComposedAppServices,
} from "../src/composition/index.js";
import { createIdFactory } from "../src/modules/ids.js";
import { MemoryReceiptStore } from "../src/modules/receipts.js";
import { commandHeaders } from "./helpers.js";

const fixtureExecutable = fileURLToPath(
  new URL("../../../runtimes/claude-code/fixtures/jsonl-double.mjs", import.meta.url),
);
const capturedUnsupported = (UNSUPPORTED_CAPTURED_PROCESS_PLATFORMS as readonly string[]).includes(
  process.platform,
);

interface InjectHarness {
  api: FastifyInstance;
  services: ComposedAppServices;
  stateDir: string;
  auth: Record<string, string>;
}

const injected: InjectHarness[] = [];

afterEach(async () => {
  for (const item of injected.splice(0)) {
    await item.api.close();
    await item.services.close();
    fs.rmSync(item.stateDir, { recursive: true, force: true });
  }
});

async function startInjected(
  options: Parameters<typeof createComposedAppServices>[0],
): Promise<InjectHarness> {
  const services = await createComposedAppServices(options);
  const sessions = new SessionRegistry("usr_test", "cli_test");
  const session = sessions.issue();
  const api = buildApi({
    services,
    receipts: new MemoryReceiptStore(),
    sessions,
    ids: createIdFactory(),
    now: () => new Date(),
    protocolVersion,
    pid: process.pid,
    startIdentity: `test:${process.pid}`,
    bootstrapToken: "test-bootstrap-token",
    sse: { heartbeatMs: 30, pollMs: 20 },
    getPort: () => 0,
  });
  await api.ready();
  const harness = {
    api,
    services,
    stateDir: options.stateDir,
    auth: { authorization: `Bearer ${session.token}` },
  };
  injected.push(harness);
  return harness;
}

async function injectJson(
  harness: InjectHarness,
  pathName: string,
  init: { method?: "GET" | "POST" | "PATCH"; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await harness.api.inject({
    method: init.method ?? "GET",
    url: pathName,
    headers: init.headers,
    payload: init.body,
  });
  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as unknown) : null,
  };
}

async function createProject(harness: InjectHarness): Promise<{ id: string; stateRevision: number }> {
  const created = await injectJson(harness, "/api/v1/projects", {
    method: "POST",
    headers: commandHeaders(harness.auth, `proj-${Math.random().toString(16).slice(2)}`),
    body: JSON.stringify({ name: "Direct", objective: "Chat 去做路径" }),
  });
  expect(created.status).toBe(201);
  return created.body as { id: string; stateRevision: number };
}

async function pollRun(
  harness: InjectHarness,
  runId: string,
  want: string,
): Promise<{ id: string; status: string }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await injectJson(harness, `/api/v1/runs/${runId}`, { headers: harness.auth });
    const body = current.body as { id: string; status: string };
    if (body.status === want) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${runId} did not reach ${want}`);
}

describe("整包 D：Chat 去做 → ad-hoc → Claude Code / evaluation", () => {
  it(
    "Mock Host：能力探测开、建 ad-hoc、direct Run、自动写入 pass evaluation",
    { timeout: 40_000 },
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-mock-"));
      const harness = await startInjected({ stateDir, completeAfterMs: 5 });
      const caps = await injectJson(harness, "/api/v1/capabilities", { headers: harness.auth });
      expect(caps.body).toMatchObject({ orchestration: { direct: true } });

      const project = await createProject(harness);
      const taskRes = await injectJson(harness, `/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "adhoc-1", project.stateRevision),
        body: JSON.stringify({ title: "去做一件事" }),
      });
      expect(taskRes.status).toBe(201);
      const task = taskRes.body as { id: string; stateRevision: number; expectedOutputs?: unknown };

      const runRes = await injectJson(harness, `/api/v1/tasks/${task.id}/runs`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "run-direct-1", task.stateRevision),
        body: JSON.stringify({ operationId: "op_direct_1", orchestrationMode: "direct" }),
      });
      expect(runRes.status).toBe(201);
      const run = runRes.body as { id: string; orchestrationMode: string; status: string };
      expect(run.orchestrationMode).toBe("direct");

      const finished = await pollRun(harness, run.id, "succeeded");
      expect(finished.status).toBe("succeeded");

      const evaluations = [...harness.services.app.world.evaluations.values()];
      expect(evaluations.length).toBeGreaterThan(0);
      expect(evaluations.every((item) => item.verdict === "pass")).toBe(true);

      const liveTask = harness.services.app.world.tasks.get(task.id);
      expect(liveTask?.status).toBe("completed");
      expect(liveTask?.workflowInstanceId).toBeUndefined();
    },
  );

  it(
    "Live Host：未检测到 Claude Code 时 fail-closed，中文报错，不回退 Mock",
    { timeout: 40_000 },
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-miss-"));
      const harness = await startInjected({
        stateDir,
        claudeCodeForTest: {
          detect: () => ({ found: false, source: "none" }),
          describeBlocker: () =>
            "未检测到 Claude Code 命令行（claude）。请先安装 Claude Code 并重试；不会悄悄改用模拟执行。",
        },
      });
      const project = await createProject(harness);
      const taskRes = await injectJson(harness, `/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "adhoc-miss", project.stateRevision),
        body: JSON.stringify({ title: "去做" }),
      });
      const task = taskRes.body as { id: string; stateRevision: number };
      const runRes = await injectJson(harness, `/api/v1/tasks/${task.id}/runs`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "run-miss", task.stateRevision),
        body: JSON.stringify({ operationId: "op_miss", orchestrationMode: "direct" }),
      });
      expect(runRes.status).toBe(400);
      expect(runRes.body).toMatchObject({ code: "validation_failed" });
      const detail = String((runRes.body as { detail?: string }).detail ?? "");
      expect(detail).toContain("未检测到 Claude Code");
      expect(detail).toContain("不会悄悄改用模拟执行");
      expect([...harness.services.app.world.runs.values()]).toHaveLength(0);
    },
  );

  it(
    "Live Host：未登录时 fail-closed，中文报错",
    { timeout: 40_000 },
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-nologin-"));
      const harness = await startInjected({
        stateDir,
        claudeCodeForTest: {
          detect: () => ({ found: true, executable: "/opt/claude", source: "path" }),
          describeBlocker: () =>
            "Claude Code 还没有登录。请在终端运行 claude 完成登录后重试；不会悄悄改用模拟执行。",
        },
      });
      const project = await createProject(harness);
      const taskRes = await injectJson(harness, `/api/v1/projects/${project.id}/tasks`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "adhoc-nologin", project.stateRevision),
        body: JSON.stringify({ title: "去做" }),
      });
      const task = taskRes.body as { id: string; stateRevision: number };
      const runRes = await injectJson(harness, `/api/v1/tasks/${task.id}/runs`, {
        method: "POST",
        headers: commandHeaders(harness.auth, "run-nologin", task.stateRevision),
        body: JSON.stringify({ operationId: "op_nologin", orchestrationMode: "direct" }),
      });
      expect(runRes.status).toBe(400);
      const detail = String((runRes.body as { detail?: string }).detail ?? "");
      expect(detail).toContain("还没有登录");
    },
  );

  const fixtureSuite = capturedUnsupported ? describe.skip : describe;
  fixtureSuite("录制夹具成功路径（非真实 Anthropic）", () => {
    beforeAll(async () => {
      await chmod(fixtureExecutable, 0o755);
    });

    it(
      "夹具可执行文件走 Claude Code → direct Run 成功 → evaluation 写入",
      { timeout: 60_000 },
      async () => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-direct-fix-"));
        const harness = await startInjected({
          stateDir,
          claudeCodeForTest: {
            detect: () => ({
              found: true,
              executable: fixtureExecutable,
              source: "configured",
            }),
            process: new OsProcessController(),
            describeBlocker: () => undefined,
          },
        });
        const project = await createProject(harness);
        const taskRes = await injectJson(harness, `/api/v1/projects/${project.id}/tasks`, {
          method: "POST",
          headers: commandHeaders(harness.auth, "adhoc-fix", project.stateRevision),
          body: JSON.stringify({ title: "夹具去做" }),
        });
        expect(taskRes.status).toBe(201);
        const task = taskRes.body as { id: string; stateRevision: number };

        const runRes = await injectJson(harness, `/api/v1/tasks/${task.id}/runs`, {
          method: "POST",
          headers: commandHeaders(harness.auth, "run-fix", task.stateRevision),
          body: JSON.stringify({ operationId: "op_fix", orchestrationMode: "direct" }),
        });
        expect(runRes.status).toBe(201);
        const run = runRes.body as { id: string };
        const finished = await pollRun(harness, run.id, "succeeded");
        expect(finished.status).toBe("succeeded");

        const evaluations = [...harness.services.app.world.evaluations.values()];
        expect(evaluations.length).toBeGreaterThan(0);
        expect(evaluations.every((item) => item.verdict === "pass")).toBe(true);
        expect(harness.services.app.world.tasks.get(task.id)?.status).toBe("completed");
      },
    );
  });
});
