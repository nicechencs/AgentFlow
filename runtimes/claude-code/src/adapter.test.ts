import { describe, expect, it } from "vitest";

import type {
  CapturedProcess,
  CapturedSpawnRequest,
  ProcessController,
  ProcessHandle,
  ProcessOutput,
  ProcessStatus,
  SpawnRequest,
} from "@workforce/process";
import { createStartRunRequest, RuntimeSdkError } from "@workforce/runtime-sdk";

import {
  ClaudeCodeRuntimeAdapter,
  CLAUDE_CODE_ADAPTER_ID,
  createClaudeCodeRuntime,
} from "./adapter.js";
import {
  buildClaudeCodeAuthoringPrompt,
  buildRecordedAuthoringProposal,
  recordedAuthoringSuccessJsonl,
} from "./authoring-proposal.js";
import { buildClaudeCodeExecArgv } from "./command.js";
import type { ClaudeCodeResolvedStartContext } from "./start-context.js";

const PROMPT = "Read only the fixture. Reply exactly SAFE_PROBE_OK.";
const CWD = "/managed/run";

const SUCCESS_JSONL = [
  '{"type":"system","subtype":"init","session_id":"omitted"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"omitted"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":2,"output_tokens":1}}',
].join("\n");

function detected() {
  return {
    found: true as const,
    executable: "/opt/claude",
    source: "path" as const,
    version: "0.154.0",
  };
}

function context(
  overrides: Partial<ClaudeCodeResolvedStartContext> = {},
): ClaudeCodeResolvedStartContext {
  return {
    cwd: CWD,
    prompt: PROMPT,
    sandbox: "read-only",
    approval: "never",
    ...overrides,
  };
}

function startRequest() {
  return createStartRunRequest({ runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID } });
}

class FakeProcessController implements ProcessController {
  readonly spawned: CapturedSpawnRequest[] = [];
  readonly cancelled: ProcessHandle[] = [];
  private nextPid = 7100;
  private readonly byKey = new Map<string, FakeCaptured>();
  constructor(
    private readonly script: (req: CapturedSpawnRequest) => {
      chunks: ProcessOutput[];
      exit?: { exitCode: number | null; signal: string | null };
      hang?: boolean;
    },
  ) {}

  async spawn(_req: SpawnRequest): Promise<ProcessHandle> {
    void _req;
    throw new Error("Claude Code adapter must use spawnCaptured");
  }

  async spawnCaptured(req: CapturedSpawnRequest): Promise<CapturedProcess> {
    this.spawned.push(req);
    const handle = {
      pid: this.nextPid,
      startIdentity: `fake:${this.nextPid}:2026-09-11T00:00:00.000Z`,
    };
    this.nextPid += 1;
    const planned = this.script(req);
    const captured = new FakeCaptured(handle, planned);
    this.byKey.set(keyOf(handle), captured);
    return captured;
  }

  async cancel(handle: ProcessHandle): Promise<void> {
    this.cancelled.push(handle);
    this.byKey.get(keyOf(handle))?.cancel();
  }

  async inspect(handle: ProcessHandle): Promise<ProcessStatus> {
    const captured = this.byKey.get(keyOf(handle));
    return {
      alive: captured?.alive ?? false,
      startIdentity: handle.startIdentity,
    };
  }
}

class FakeCaptured implements CapturedProcess {
  readonly handle: ProcessHandle;
  readonly output: AsyncIterable<ProcessOutput> = this;
  alive = true;
  private readonly chunks: ProcessOutput[];
  private readonly exitResult: { exitCode: number | null; signal: string | null };
  private readonly hang: boolean;
  private cancelled = false;
  private readonly hangPromise: Promise<void>;
  private resolveHang!: () => void;

  constructor(
    handle: ProcessHandle,
    planned: {
      chunks: ProcessOutput[];
      exit?: { exitCode: number | null; signal: string | null };
      hang?: boolean;
    },
  ) {
    this.handle = handle;
    this.chunks = planned.chunks;
    this.exitResult = planned.exit ?? { exitCode: 0, signal: null };
    this.hang = planned.hang === true;
    this.hangPromise = new Promise((resolve) => {
      this.resolveHang = resolve;
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProcessOutput> {
    for (const chunk of this.chunks) {
      if (this.cancelled) {
        return;
      }
      yield chunk;
    }
    if (this.hang) {
      await this.hangPromise;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.alive = false;
    this.exitResult.signal = "SIGKILL";
    this.exitResult.exitCode = null;
    this.resolveHang();
  }

  async wait(): Promise<{ exitCode: number | null; signal: string | null }> {
    if (this.hang) {
      await this.hangPromise;
    }
    this.alive = false;
    return this.exitResult;
  }
}

function keyOf(handle: ProcessHandle): string {
  return `${handle.pid}\n${handle.startIdentity}`;
}

function stdout(text: string): ProcessOutput {
  return { source: "stdout", chunk: new TextEncoder().encode(text) };
}

function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const items: unknown[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    return items;
  })();
}

describe("ClaudeCodeRuntimeAdapter", () => {
  it("uses adapter id claude-code, distinct from Codex", () => {
    expect(CLAUDE_CODE_ADAPTER_ID).toBe("claude-code");
    expect(CLAUDE_CODE_ADAPTER_ID).not.toBe("codex");
  });

  it("describes start/cancel blocked when Process or resolveStart is missing", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
    });
    const descriptor = await adapter.describe();
    expect(descriptor.adapter.id).toBe(CLAUDE_CODE_ADAPTER_ID);
    expect(descriptor.adapter.id).toBe("claude-code");
    expect(descriptor.runtime.id).toBe("claude-code");
    expect(descriptor.runtime.transport).toBe("process");
    expect(descriptor.capabilities.find((item) => item.name === "lifecycle.start")).toMatchObject({
      available: false,
      constraints: { reason: "captured Process port is not injected", liveExec: "untested" },
    });
    expect(descriptor.capabilities.find((item) => item.name === "lifecycle.pause")?.available).toBe(
      false,
    );
    expect(descriptor.capabilities.find((item) => item.name === "event.resume")?.available).toBe(
      false,
    );
    expect(
      descriptor.capabilities.find((item) => item.name === "lifecycle.cancel")?.available,
    ).toBe(false);
    expect(descriptor.capabilities.find((item) => item.name === "usage.reporting")).toMatchObject({
      available: false,
      constraints: { monetaryCost: "unknown" },
    });
    expect(
      descriptor.capabilities.find((item) => item.name === "authoring.proposal"),
    ).toMatchObject({
      available: false,
      constraints: {
        inputTransport: "waiting_input_then_spawn_stdin",
        structuredProposal: "parse_assistant_json_fence",
        liveAnthropic: "untested",
        reason: "captured Process port is not injected",
      },
    });
  });

  it("validate is false when the executable is missing", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => ({ found: false, source: "none" }),
      process: new FakeProcessController(() => ({ chunks: [] })),
      resolveStart: () => context(),
    });
    const result = await adapter.validate({ adapterId: CLAUDE_CODE_ADAPTER_ID });
    expect(result.valid).toBe(false);
    expect(result.checks.some((check) => check.name === "executable" && !check.ok)).toBe(true);
  });

  it("refuses start when CLI is detected but Process is not injected", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
    });
    await expect(adapter.start(startRequest())).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining("captured Process port"),
    });
    const result = await adapter.validate({ adapterId: CLAUDE_CODE_ADAPTER_ID });
    expect(result.valid).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "process_port", ok: false }),
    );
  });

  it("refuses start when Process is injected but resolveStart is missing", async () => {
    const processPort = new FakeProcessController(() => ({ chunks: [] }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
    });
    await expect(adapter.start(startRequest())).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining("resolveStart"),
    });
    expect(processPort.spawned).toHaveLength(0);
  });

  it("accepts authoring start in waiting_input without spawning until sendInput", async () => {
    const processPort = new FakeProcessController(() => ({ chunks: [] }));
    let resolved = false;
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => {
        resolved = true;
        return context();
      },
      platform: "linux",
    });

    const handle = await adapter.start(
      createStartRunRequest({
        runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID },
        snapshotRef: "authoring:proposal",
      }),
    );
    expect(await adapter.inspect(handle)).toMatchObject({ status: "waiting_input" });
    expect(resolved).toBe(false);
    expect(processPort.spawned).toHaveLength(0);

    const events: string[] = [];
    const stream = (async () => {
      for await (const event of adapter.stream(handle)) {
        events.push(event.type);
        if (event.type === "runtime.input.requested") {
          break;
        }
      }
    })();
    await stream;
    expect(events).toContain("runtime.input.requested");
  });

  it("spawns on authoring sendInput and emits a proposal from recorded fixture JSONL", async () => {
    const intent = "Create a plan then implement workflow";
    const processPort = new FakeProcessController((req) => {
      const stdin = new TextDecoder().decode(req.stdin ?? new Uint8Array());
      expect(stdin).toContain("WORKFORCE_AUTHORING_PROPOSAL");
      expect(stdin).toContain(intent);
      // Placeholder proposal; adapter will parse whatever is in stdout.
      const proposal = buildRecordedAuthoringProposal({ handleId: "fixture", intent });
      const jsonl = recordedAuthoringSuccessJsonl(proposal);
      return {
        chunks: [{ source: "stdout" as const, chunk: new TextEncoder().encode(jsonl) }],
        exit: { exitCode: 0, signal: null },
      };
    });
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context({ prompt: "should be replaced by authoring prompt" }),
      platform: "linux",
    });

    const handle = await adapter.start(
      createStartRunRequest({
        runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID },
        snapshotRef: "authoring:proposal",
      }),
    );
    const receipt = await adapter.sendInput(handle, {
      operationId: "op_authoring_input",
      text: intent,
    });
    expect(receipt.accepted).toBe(true);
    expect(processPort.spawned).toHaveLength(1);
    const stdin = new TextDecoder().decode(processPort.spawned[0]?.stdin ?? new Uint8Array());
    expect(stdin).toBe(buildClaudeCodeAuthoringPrompt(intent));

    const types: string[] = [];
    let proposalSummary: string | undefined;
    for await (const event of adapter.stream(handle)) {
      types.push(event.type);
      if (event.type === "runtime.authoring.proposal") {
        proposalSummary = (event.data as { proposal?: { summary?: string } }).proposal?.summary;
      }
      if (event.type === "runtime.completed" || event.type === "runtime.failed") {
        break;
      }
    }
    expect(types).toContain("runtime.authoring.proposal");
    expect(types).toContain("runtime.completed");
    expect(proposalSummary).toBe("Structured authoring proposal");
    expect(await adapter.inspect(handle)).toMatchObject({ status: "succeeded" });
  });

  it("fails closed when recorded authoring output has no proposal fence", async () => {
    const processPort = new FakeProcessController(() => ({
      chunks: [{ source: "stdout" as const, chunk: new TextEncoder().encode(SUCCESS_JSONL) }],
      exit: { exitCode: 0, signal: null },
    }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context(),
      platform: "linux",
    });
    const handle = await adapter.start(
      createStartRunRequest({
        runtime: { adapterId: CLAUDE_CODE_ADAPTER_ID },
        snapshotRef: "authoring:proposal",
      }),
    );
    await adapter.sendInput(handle, { operationId: "op_bad", text: "make a workflow" });
    const types: string[] = [];
    for await (const event of adapter.stream(handle)) {
      types.push(event.type);
      if (event.type === "runtime.failed" || event.type === "runtime.completed") {
        break;
      }
    }
    expect(types).toContain("runtime.failed");
    expect(types).not.toContain("runtime.authoring.proposal");
    expect(await adapter.inspect(handle)).toMatchObject({ status: "failed" });
  });

  it("refuses start with validation_failed when the CLI is missing", async () => {
    const processPort = new FakeProcessController(() => ({ chunks: [] }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => ({ found: false, source: "none" }),
      process: processPort,
      resolveStart: () => context(),
    });
    await expect(adapter.start(startRequest())).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("not detected"),
    });
    expect(processPort.spawned).toHaveLength(0);
  });

  it("refuses incomplete resolved context without spawning", async () => {
    const processPort = new FakeProcessController(() => ({ chunks: [] }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => ({ ...context(), prompt: "" }),
      // This case exercises the resolved-context guard, not the win32 capture guard.
      platform: "linux",
    });
    await expect(adapter.start(startRequest())).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining("complete resolved"),
    });
    expect(processPort.spawned).toHaveLength(0);
  });

  it("starts on win32 captured Process when inputs are present", async () => {
    const processPort = new FakeProcessController(() => ({ chunks: [] }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context(),
      platform: "win32",
    });
    const handle = await adapter.start(startRequest());
    expect(handle.adapterId).toBe(CLAUDE_CODE_ADAPTER_ID);
    expect(processPort.spawned).toHaveLength(1);
    const result = await adapter.validate({ adapterId: CLAUDE_CODE_ADAPTER_ID });
    expect(result.valid).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "captured_process", ok: true }),
    );
  });

  it("starts, streams JSONL, and inspects through the captured Process port", async () => {
    const processPort = new FakeProcessController(() => ({
      chunks: [stdout(`${SUCCESS_JSONL}\n`)],
    }));
    const adapter = createClaudeCodeRuntime({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context(),
      platform: "linux",
    });
    const valid = await adapter.validate({ adapterId: CLAUDE_CODE_ADAPTER_ID });
    expect(valid.valid).toBe(true);
    const descriptor = await adapter.describe();
    expect(descriptor.capabilities.find((item) => item.name === "lifecycle.start")?.available).toBe(
      true,
    );

    const handle = await adapter.start(startRequest());
    expect(handle.adapterId).toBe(CLAUDE_CODE_ADAPTER_ID);
    expect(handle.process).toEqual({
      pid: 7100,
      startIdentity: "fake:7100:2026-09-11T00:00:00.000Z",
    });
    expect(processPort.spawned).toHaveLength(1);
    expect(processPort.spawned[0]?.argv).toEqual(
      buildClaudeCodeExecArgv({
        executable: "/opt/claude",
        cwd: CWD,
        sandbox: "read-only",
        approval: "never",
      }),
    );
    expect(new TextDecoder().decode(processPort.spawned[0]?.stdin)).toBe(PROMPT);
    expect(processPort.spawned[0]?.cwd).toBe(CWD);

    const events = (await collect(adapter.stream(handle))) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual([
      "runtime.started",
      "runtime.message",
      "runtime.usage.updated",
      "runtime.completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("SAFE_PROBE_OK");
    await expect(adapter.inspect(handle)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("returns the same handle for a repeated operationId without a second spawn", async () => {
    const processPort = new FakeProcessController(() => ({
      chunks: [stdout(`${SUCCESS_JSONL}\n`)],
    }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context(),
      platform: "linux",
    });
    const request = startRequest();
    const first = await adapter.start(request);
    const second = await adapter.start(request);
    expect(second).toEqual(first);
    expect(processPort.spawned).toHaveLength(1);
  });

  it("cancels through Process and maps the exit to runtime.cancelled", async () => {
    const processPort = new FakeProcessController(() => ({
      chunks: [stdout('{"type":"system","subtype":"init","session_id":"omitted"}\n')],
      hang: true,
    }));
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: processPort,
      resolveStart: () => context(),
      platform: "linux",
    });
    const handle = await adapter.start(startRequest());
    const iterator = adapter.stream(handle)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "runtime.started" } });
    await expect(adapter.cancel(handle)).resolves.toMatchObject({ accepted: true });
    expect(processPort.cancelled).toEqual([handle.process]);
    const events: string[] = ["runtime.started"];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push((next.value as { type: string }).type);
    }
    expect(events.at(-1)).toBe("runtime.cancelled");
    await expect(adapter.inspect(handle)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("fails stream with not_found instead of an empty iterator when the handle is unknown", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: new FakeProcessController(() => ({ chunks: [] })),
      resolveStart: () => context(),
      platform: "linux",
    });
    const iterator = adapter.stream({ handleId: "hdl_1", runId: "run_1" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps stream fail-closed when Process is missing", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
    });
    const iterator = adapter.stream({ handleId: "hdl_1", runId: "run_1" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining("captured Process port"),
    });
  });

  it("rejects event cursor resume and mid-run input", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: new FakeProcessController(() => ({
        chunks: [stdout(SUCCESS_JSONL)],
        exit: { exitCode: 0, signal: null },
      })),
      resolveStart: () => context(),
      platform: "linux",
    });
    await expect(adapter.pause()).rejects.toBeInstanceOf(RuntimeSdkError);
    await expect(
      collect(adapter.stream({ handleId: "hdl_1", runId: "run_1" }, { sourceCursor: "x" })),
    ).rejects.toMatchObject({ code: "unsupported_capability" });
    const handle = await adapter.start(startRequest());
    await expect(
      adapter.sendInput(handle, { operationId: "op_in", text: "mid-run" }),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      message: expect.stringContaining("mid-run input"),
    });
  });

  it("reconcile cannot re-attach a missing in-memory session", async () => {
    const adapter = new ClaudeCodeRuntimeAdapter({
      detect: () => detected(),
      process: new FakeProcessController(() => ({ chunks: [] })),
      resolveStart: () => context(),
      platform: "linux",
    });
    await expect(
      adapter.reconcile({
        handleId: "hdl_missing",
        runId: "run_missing",
        adapterId: CLAUDE_CODE_ADAPTER_ID,
        createdAt: "2026-09-11T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      attached: false,
      status: { handle: { handleId: "hdl_missing", runId: "run_missing" }, status: "unknown" },
    });
  });
});
