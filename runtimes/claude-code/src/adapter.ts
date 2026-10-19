import { TextDecoder } from "node:util";

import type { CapturedProcess, ProcessController, ProcessHandle } from "@workforce/process";
import { UNSUPPORTED_CAPTURED_PROCESS_PLATFORMS } from "@workforce/process";
import type { StartRunRequest } from "@workforce/protocol";
import {
  RuntimeSdkError,
  SequentialIdGenerator,
  SystemClock,
  isTerminalStatus,
  type Clock,
  type IdGenerator,
} from "@workforce/runtime-sdk";
import type {
  EventCursor,
  InputReceipt,
  OperationReceipt,
  ReconciliationResult,
  RuntimeAdapter,
  RuntimeConfig,
  RuntimeDescriptor,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeHandleRef,
  RuntimeInput,
  RuntimeStatus,
  RuntimeStatusName,
  ValidationResult,
} from "@workforce/runtime-spi";

import {
  buildClaudeCodeAuthoringPrompt,
  extractAssistantTextFromClaudeCodeJsonlLine,
  parseClaudeCodeAuthoringProposalText,
} from "./authoring-proposal.js";
import { buildClaudeCodeExecArgv } from "./command.js";
import { detectClaudeCode, type ClaudeCodeDetection } from "./detect.js";
import { ClaudeCodeJsonlDecoder } from "./jsonl.js";
import {
  parseClaudeCodeResolvedStartContext,
  type ResolveClaudeCodeStartContext,
} from "./start-context.js";

export const CLAUDE_CODE_ADAPTER_ID = "claude-code";
export const CLAUDE_CODE_ADAPTER_VERSION = "0.1.0";

export interface ClaudeCodeRuntimeAdapterOptions {
  detect?: () => ClaudeCodeDetection;
  process?: ProcessController;
  resolveStart?: ResolveClaudeCodeStartContext;
  clock?: Clock;
  ids?: IdGenerator;
  platform?: NodeJS.Platform;
}

interface ClaudeCodeSession {
  handle: RuntimeHandle;
  operationId: string;
  /** Present only after the captured process has been spawned. */
  processHandle?: ProcessHandle;
  captured?: CapturedProcess;
  events: RuntimeEvent[];
  status: RuntimeStatusName;
  lastTrustedFactAt?: string;
  closed: boolean;
  cancelRequested: boolean;
  decoder: ClaudeCodeJsonlDecoder;
  textDecoder: TextDecoder;
  waiters: Array<() => void>;
  lastSequence: number;
  stderrObserved: boolean;
  /** Authoring runs wait for Host sendInput before spawning. */
  authoring: boolean;
  pendingAuthoringRequest?: StartRunRequest;
  authoringLineBuffer: string;
  authoringAssistantText: string;
  authoringProposalEmitted: boolean;
}

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  private readonly detectFn: () => ClaudeCodeDetection;
  private readonly process: ProcessController | undefined;
  private readonly resolveStart: ResolveClaudeCodeStartContext | undefined;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly platform: NodeJS.Platform;
  private readonly byHandle = new Map<string, ClaudeCodeSession>();
  private readonly byOperation = new Map<string, ClaudeCodeSession>();

  constructor(options: ClaudeCodeRuntimeAdapterOptions = {}) {
    this.detectFn = options.detect ?? (() => detectClaudeCode());
    this.process = options.process;
    this.resolveStart = options.resolveStart;
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new SequentialIdGenerator();
    this.platform = options.platform ?? process.platform;
  }

  async describe(): Promise<RuntimeDescriptor> {
    const detection = this.detectFn();
    const startReady = this.canAttemptStart(detection);
    return {
      adapter: {
        id: CLAUDE_CODE_ADAPTER_ID,
        name: "Claude Code Runtime",
        version: CLAUDE_CODE_ADAPTER_VERSION,
        protocolVersions: ["0.1"],
      },
      runtime: {
        id: CLAUDE_CODE_ADAPTER_ID,
        displayName: "Claude Code CLI",
        ...(detection.version ? { version: detection.version } : {}),
        transport: "process",
      },
      platforms: ["windows", "macos", "linux"],
      capabilities: [
        {
          name: "lifecycle.start",
          version: "0.1",
          available: startReady,
          constraints: {
            reason: startReady
              ? "start_via_captured_process_when_validate_allows"
              : this.startBlockReason(detection),
            liveExec: "untested",
          },
        },
        { name: "lifecycle.pause", version: "0.1", available: false },
        { name: "event.resume", version: "0.1", available: false },
        {
          name: "lifecycle.cancel",
          version: "0.1",
          available: this.process !== undefined && this.capturedProcessSupported(),
          constraints: {
            reason: "cancel_via_process_tree_kill",
          },
        },
        {
          name: "usage.reporting",
          version: "0.1",
          available: startReady,
          constraints: {
            tokenCounts: "jsonl_when_streamed",
            monetaryCost: "unknown",
            liveExec: "untested",
          },
        },
        {
          name: "authoring.proposal",
          version: "0.1",
          available: startReady,
          constraints: {
            inputTransport: "waiting_input_then_spawn_stdin",
            structuredProposal: "parse_assistant_json_fence",
            liveAnthropic: "untested",
            ...(startReady
              ? {}
              : { reason: this.startBlockReason(detection) }),
          },
        },
      ],
    };
  }

  async validate(config: RuntimeConfig): Promise<ValidationResult> {
    const detection =
      config.executable !== undefined
        ? detectClaudeCode({ configuredExecutable: config.executable })
        : this.detectFn();
    const adapterOk = config.adapterId === CLAUDE_CODE_ADAPTER_ID;
    const found = detection.found;
    const processOk = this.process !== undefined;
    const contextOk = this.resolveStart !== undefined;
    const captureOk = this.capturedProcessSupported();
    const checks: ValidationResult["checks"] = [
      {
        name: "adapterId",
        ok: adapterOk,
        ...(adapterOk ? {} : { detail: `expected ${CLAUDE_CODE_ADAPTER_ID}` }),
      },
      {
        name: "executable",
        ok: found,
        detail: found
          ? (detection.executable ?? "claude executable detected")
          : "claude executable not detected",
      },
      {
        name: "process_port",
        ok: processOk,
        detail: processOk
          ? "captured Process port injected"
          : "captured Process port is not injected",
      },
      {
        name: "start_context",
        ok: contextOk,
        detail: contextOk
          ? "resolveStart factory injected"
          : "resolved Workspace/Policy/context factory is not injected",
      },
      {
        name: "captured_process",
        ok: captureOk,
        detail: captureOk
          ? "captured Process supported on this platform"
          : `captured Process unsupported on ${this.platform}`,
      },
    ];
    return {
      valid: adapterOk && found && processOk && contextOk && captureOk,
      ...(detection.version ? { runtimeVersion: detection.version } : {}),
      checks,
    };
  }

  async start(request: StartRunRequest): Promise<RuntimeHandle> {
    const existing = this.byOperation.get(request.operationId);
    if (existing) {
      return existing.handle;
    }

    if (request.runtime.adapterId !== CLAUDE_CODE_ADAPTER_ID) {
      throw new RuntimeSdkError("validation_failed", "adapter id does not match ClaudeCode", {
        details: { expected: CLAUDE_CODE_ADAPTER_ID, actual: request.runtime.adapterId },
      });
    }

    // Authoring runs must not spawn on start: StartRunRequest never carries
    // raw intent, and stdin is one-shot at spawn. Accept the handle in
    // waiting_input, then spawn from sendInput after the Host handoff.
    if (isAuthoringSnapshotRef(request.snapshotRef)) {
      return this.startAuthoringPending(request);
    }

    const detection = this.detectFn();
    if (!detection.found || detection.executable === undefined) {
      throw new RuntimeSdkError("validation_failed", "ClaudeCode CLI was not detected", {
        details: { capability: "detect", runtime: CLAUDE_CODE_ADAPTER_ID },
      });
    }
    if (this.process === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code start requires an injected captured Process port",
        { details: { capability: "lifecycle.start", runtime: CLAUDE_CODE_ADAPTER_ID } },
      );
    }
    if (this.resolveStart === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code start requires an injected resolveStart factory for Workspace/Policy/context",
        { details: { capability: "lifecycle.start", runtime: CLAUDE_CODE_ADAPTER_ID } },
      );
    }
    if (!this.capturedProcessSupported()) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        `captured Process is unsupported on ${this.platform}`,
        { details: { capability: "process.capture", platform: this.platform } },
      );
    }

    const resolved = parseClaudeCodeResolvedStartContext(await this.resolveStart(request));
    if (resolved === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code start requires a complete resolved Workspace/Policy/context",
        { details: { capability: "lifecycle.start", runtime: CLAUDE_CODE_ADAPTER_ID } },
      );
    }

    const argv = buildClaudeCodeExecArgv({
      executable: detection.executable,
      cwd: resolved.cwd,
      sandbox: resolved.sandbox,
      approval: resolved.approval,
    });
    const stdin = new TextEncoder().encode(resolved.prompt);
    const spawnRequest = {
      argv,
      cwd: resolved.cwd,
      stdin,
      ...(resolved.environment ? { env: resolved.environment } : {}),
    };

    let captured: CapturedProcess;
    try {
      captured = await this.process.spawnCaptured(spawnRequest);
    } catch (error) {
      if (isUnsupportedCapability(error)) {
        throw new RuntimeSdkError(
          "unsupported_capability",
          error instanceof Error ? error.message : "captured Process spawn is unsupported",
          { details: { capability: "process.capture", runtime: CLAUDE_CODE_ADAPTER_ID } },
        );
      }
      throw error;
    }

    const createdAt = this.clock.now().toISOString();
    const handle: RuntimeHandle = {
      handleId: this.ids.ulid("hdl_"),
      runId: this.ids.ulid("run_"),
      adapterId: CLAUDE_CODE_ADAPTER_ID,
      createdAt,
      process: {
        pid: captured.handle.pid,
        startIdentity: captured.handle.startIdentity,
      },
    };
    const session: ClaudeCodeSession = {
      handle,
      operationId: request.operationId,
      processHandle: captured.handle,
      captured,
      events: [],
      status: "starting",
      lastTrustedFactAt: createdAt,
      closed: false,
      cancelRequested: false,
      decoder: new ClaudeCodeJsonlDecoder({ now: () => this.clock.now() }),
      textDecoder: new TextDecoder("utf-8"),
      waiters: [],
      lastSequence: 0,
      stderrObserved: false,
      authoring: false,
      authoringLineBuffer: "",
      authoringAssistantText: "",
      authoringProposalEmitted: false,
    };
    this.byHandle.set(handle.handleId, session);
    this.byOperation.set(request.operationId, session);
    void this.consume(session);
    return handle;
  }

  async sendInput(handle: RuntimeHandleRef, input: RuntimeInput): Promise<InputReceipt> {
    const session = this.byHandle.get(handle.handleId);
    if (!session) {
      throw new RuntimeSdkError("not_found", "runtime handle not found", {
        details: { handleId: handle.handleId },
      });
    }
    if (!session.authoring || session.pendingAuthoringRequest === undefined) {
      throw new RuntimeSdkError("unsupported_capability", "Claude Code mid-run input is untested", {
        details: { capability: "input" },
      });
    }
    if (session.status !== "waiting_input" || session.cancelRequested || session.closed) {
      return { operationId: input.operationId, accepted: false };
    }
    const intent = typeof input.text === "string" ? input.text : "";
    if (intent.trim().length === 0) {
      throw new RuntimeSdkError("validation_failed", "authoring intent text is required", {
        details: { capability: "authoring.proposal" },
      });
    }
    await this.spawnAuthoringSession(session, intent);
    return { operationId: input.operationId, accepted: true };
  }

  async pause(): Promise<OperationReceipt> {
    throw new RuntimeSdkError("unsupported_capability", "Claude Code has no pause command", {
      details: { capability: "lifecycle.pause" },
    });
  }

  async resume(): Promise<OperationReceipt> {
    throw new RuntimeSdkError(
      "unsupported_capability",
      "Claude Code resume restores a session, not an event cursor",
      { details: { capability: "event.resume" } },
    );
  }

  async cancel(handle: RuntimeHandleRef, reason?: string): Promise<OperationReceipt> {
    void reason;
    const session = this.byHandle.get(handle.handleId);
    if (this.process === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code cancel requires an injected captured Process port",
        { details: { capability: "lifecycle.cancel" } },
      );
    }
    if (!session) {
      throw new RuntimeSdkError("not_found", "runtime handle not found", {
        details: { handleId: handle.handleId },
      });
    }
    if (!session.cancelRequested && !isTerminalStatus(session.status)) {
      session.cancelRequested = true;
      if (session.processHandle !== undefined) {
        await this.process.cancel(session.processHandle, "force");
      } else {
        session.status = "cancelled";
        this.emitLocal(session, "runtime.cancelled", { reason: "cancelled_before_spawn" });
        session.closed = true;
        this.notify(session);
      }
    }
    return { operationId: `cancel:${handle.handleId}`, accepted: true };
  }

  async inspect(handle: RuntimeHandleRef): Promise<RuntimeStatus> {
    const session = this.byHandle.get(handle.handleId);
    if (!session) {
      return { handle, status: "unknown" };
    }
    if (!isTerminalStatus(session.status) && this.process && session.processHandle) {
      try {
        const live = await this.process.inspect(session.processHandle);
        if (!live.alive && !isTerminalStatus(session.status) && !session.cancelRequested) {
          session.status = "unknown";
        }
      } catch {
        // Identity mismatch or inspect failure stays unknown; do not invent a terminal.
        if (!isTerminalStatus(session.status)) {
          session.status = "unknown";
        }
      }
    }
    return {
      handle: { handleId: session.handle.handleId, runId: session.handle.runId },
      status: session.status,
      ...(session.lastTrustedFactAt ? { lastTrustedFactAt: session.lastTrustedFactAt } : {}),
    };
  }

  async *stream(handle: RuntimeHandleRef, cursor?: EventCursor): AsyncIterable<RuntimeEvent> {
    if (cursor) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code event cursor resume is unsupported",
        { details: { capability: "event.resume" } },
      );
    }
    if (this.process === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code event streaming requires an injected captured Process port",
        { details: { capability: "event.stream" } },
      );
    }
    const session = this.byHandle.get(handle.handleId);
    if (!session) {
      throw new RuntimeSdkError("not_found", "runtime handle not found", {
        details: { handleId: handle.handleId },
      });
    }
    let index = 0;
    while (true) {
      while (index < session.events.length) {
        const event = session.events[index];
        if (event) {
          yield event;
        }
        index += 1;
      }
      if (session.closed) {
        return;
      }
      await this.waitForMore(session, index);
    }
  }

  async reconcile(handle: RuntimeHandle): Promise<ReconciliationResult> {
    const session = this.byHandle.get(handle.handleId);
    if (!session) {
      return {
        attached: false,
        status: { handle: { handleId: handle.handleId, runId: handle.runId }, status: "unknown" },
      };
    }
    const expected = session.handle.process?.startIdentity;
    const provided = handle.process?.startIdentity;
    if (expected && provided && expected !== provided) {
      return {
        attached: false,
        status: {
          handle: { handleId: handle.handleId, runId: handle.runId },
          status: "orphaned",
          ...(session.lastTrustedFactAt ? { lastTrustedFactAt: session.lastTrustedFactAt } : {}),
        },
      };
    }
    const status = await this.inspect(handle);
    return {
      attached: !isTerminalStatus(status.status) && status.status !== "unknown",
      status,
    };
  }

  private canAttemptStart(detection: ClaudeCodeDetection): boolean {
    return (
      detection.found &&
      this.process !== undefined &&
      this.resolveStart !== undefined &&
      this.capturedProcessSupported()
    );
  }

  private startBlockReason(detection: ClaudeCodeDetection): string {
    if (!detection.found) {
      return "claude executable not detected";
    }
    if (this.process === undefined) {
      return "captured Process port is not injected";
    }
    if (this.resolveStart === undefined) {
      return "resolved Workspace/Policy/context factory is not injected";
    }
    if (!this.capturedProcessSupported()) {
      return `captured Process unsupported on ${this.platform}`;
    }
    return "start blocked";
  }

  private capturedProcessSupported(): boolean {
    return !(UNSUPPORTED_CAPTURED_PROCESS_PLATFORMS as readonly string[]).includes(this.platform);
  }

  private async consume(session: ClaudeCodeSession): Promise<void> {
    if (session.captured === undefined) {
      session.status = "failed";
      this.emitLocal(session, "runtime.failed", {
        reason: "claude_code_missing_captured_process",
        contentRedacted: true,
      });
      session.closed = true;
      this.notify(session);
      return;
    }
    try {
      for await (const item of session.captured.output) {
        if (item.source === "stderr") {
          if (item.chunk.byteLength > 0 && !session.stderrObserved) {
            session.stderrObserved = true;
            this.emitLocal(session, "runtime.message", {
              level: "error",
              stream: "stderr",
              contentRedacted: true,
            });
          }
          continue;
        }
        const text = session.textDecoder.decode(item.chunk, { stream: true });
        if (text.length > 0) {
          if (session.authoring) {
            this.accumulateAuthoringAssistantText(session, text);
          }
          this.applyDecoded(session, session.decoder.push(text));
        }
      }
      const tail = session.textDecoder.decode();
      if (tail.length > 0) {
        if (session.authoring) {
          this.accumulateAuthoringAssistantText(session, tail);
        }
        this.applyDecoded(session, session.decoder.push(tail));
      }
      if (session.authoring && session.authoringLineBuffer.length > 0) {
        const text = extractAssistantTextFromClaudeCodeJsonlLine(session.authoringLineBuffer);
        session.authoringLineBuffer = "";
        if (text.length > 0) {
          session.authoringAssistantText += text;
        }
      }
      this.applyDecoded(session, session.decoder.flush());
    } catch (error) {
      if (!isTerminalStatus(session.status)) {
        this.emitLocal(session, "runtime.failed", {
          reason: "claude_code_stream_failed",
          contentRedacted: true,
          ...(error instanceof RuntimeSdkError ? { code: error.code } : {}),
        });
        session.status = "failed";
      }
    }

    let exit: { exitCode: number | null; signal: string | null } | undefined;
    try {
      exit = session.captured ? await session.captured.wait() : undefined;
    } catch {
      exit = undefined;
    }
    this.finish(session, exit);
  }

  private finish(
    session: ClaudeCodeSession,
    exit: { exitCode: number | null; signal: string | null } | undefined,
  ): void {
    if (isTerminalStatus(session.status)) {
      session.closed = true;
      this.notify(session);
      return;
    }
    if (session.cancelRequested) {
      session.status = "cancelled";
      this.emitLocal(session, "runtime.cancelled", {});
      session.closed = true;
      this.notify(session);
      return;
    }
    session.status = "failed";
    this.emitLocal(session, "runtime.failed", {
      reason:
        exit && exit.exitCode !== 0
          ? "claude_code_process_exit"
          : "claude_code_exited_without_terminal_event",
      ...(exit ? { exitCode: exit.exitCode, signal: exit.signal } : {}),
      contentRedacted: true,
    });
    session.closed = true;
    this.notify(session);
  }

  private applyDecoded(session: ClaudeCodeSession, events: RuntimeEvent[]): void {
    for (const event of events) {
      if (
        session.authoring &&
        event.type === "runtime.completed" &&
        !session.authoringProposalEmitted
      ) {
        const proposal = parseClaudeCodeAuthoringProposalText(session.authoringAssistantText);
        if (!proposal) {
          this.emitLocal(session, "runtime.failed", {
            reason: "invalid_authoring_proposal",
            contentRedacted: true,
          });
          session.status = "failed";
          this.notify(session);
          continue;
        }
        session.authoringProposalEmitted = true;
        this.emitLocal(session, "runtime.authoring.proposal", { proposal });
      }
      session.events.push(event);
      session.lastTrustedFactAt = event.time;
      const sequence = event.data["adapterSequence"];
      if (typeof sequence === "number" && sequence > session.lastSequence) {
        session.lastSequence = sequence;
      }
      this.noteStatus(session, event.type);
      this.notify(session);
    }
  }

  private emitLocal(session: ClaudeCodeSession, type: string, data: Record<string, unknown>): void {
    session.lastSequence += 1;
    const time = this.clock.now().toISOString();
    session.lastTrustedFactAt = time;
    session.events.push({
      type,
      time,
      data: { ...data, adapterSequence: session.lastSequence },
      sourceCursor: `claude-code-local:${session.lastSequence}`,
    });
    this.noteStatus(session, type);
    this.notify(session);
  }

  private noteStatus(session: ClaudeCodeSession, type: string): void {
    if (type === "runtime.started" && session.status === "starting") {
      session.status = "running";
    }
    if (type === "runtime.completed") {
      session.status = "succeeded";
    }
    if (type === "runtime.failed") {
      session.status = "failed";
    }
    if (type === "runtime.cancelled") {
      session.status = "cancelled";
    }
  }

  private waitForMore(session: ClaudeCodeSession, seen: number): Promise<void> {
    if (session.events.length > seen || session.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      session.waiters.push(resolve);
    });
  }

  private notify(session: ClaudeCodeSession): void {
    const waiters = session.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private startAuthoringPending(request: StartRunRequest): RuntimeHandle {
    const detection = this.detectFn();
    if (!this.canAttemptStart(detection)) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code authoring start requires detect, Process, and resolveStart",
        {
          details: {
            capability: "authoring.proposal",
            reason: this.startBlockReason(detection),
          },
        },
      );
    }
    const createdAt = this.clock.now().toISOString();
    const handle: RuntimeHandle = {
      handleId: this.ids.ulid("hdl_"),
      runId: this.ids.ulid("run_"),
      adapterId: CLAUDE_CODE_ADAPTER_ID,
      createdAt,
    };
    const session: ClaudeCodeSession = {
      handle,
      operationId: request.operationId,
      events: [],
      status: "starting",
      lastTrustedFactAt: createdAt,
      closed: false,
      cancelRequested: false,
      decoder: new ClaudeCodeJsonlDecoder({ now: () => this.clock.now() }),
      textDecoder: new TextDecoder("utf-8"),
      waiters: [],
      lastSequence: 0,
      stderrObserved: false,
      authoring: true,
      pendingAuthoringRequest: request,
      authoringLineBuffer: "",
      authoringAssistantText: "",
      authoringProposalEmitted: false,
    };
    this.byHandle.set(handle.handleId, session);
    this.byOperation.set(request.operationId, session);
    this.emitLocal(session, "runtime.starting", {});
    session.status = "waiting_input";
    this.emitLocal(session, "runtime.input.requested", { kind: "text" });
    return handle;
  }

  private async spawnAuthoringSession(session: ClaudeCodeSession, intent: string): Promise<void> {
    const request = session.pendingAuthoringRequest;
    if (request === undefined) {
      throw new RuntimeSdkError("conflict", "authoring session is not waiting for input", {
        details: { handleId: session.handle.handleId },
      });
    }
    if (this.process === undefined || this.resolveStart === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code authoring spawn requires Process and resolveStart",
        { details: { capability: "authoring.proposal" } },
      );
    }
    const detection = this.detectFn();
    if (!detection.found || detection.executable === undefined) {
      throw new RuntimeSdkError("validation_failed", "ClaudeCode CLI was not detected", {
        details: { capability: "detect", runtime: CLAUDE_CODE_ADAPTER_ID },
      });
    }
    const resolved = parseClaudeCodeResolvedStartContext(await this.resolveStart(request));
    if (resolved === undefined) {
      throw new RuntimeSdkError(
        "unsupported_capability",
        "Claude Code authoring requires a complete resolved Workspace/Policy/context",
        { details: { capability: "authoring.proposal" } },
      );
    }
    const prompt = buildClaudeCodeAuthoringPrompt(intent);
    const argv = buildClaudeCodeExecArgv({
      executable: detection.executable,
      cwd: resolved.cwd,
      sandbox: "read-only",
      approval: "never",
    });
    const stdin = new TextEncoder().encode(prompt);
    const spawnRequest = {
      argv,
      cwd: resolved.cwd,
      stdin,
      ...(resolved.environment ? { env: resolved.environment } : {}),
    };
    let captured: CapturedProcess;
    try {
      captured = await this.process.spawnCaptured(spawnRequest);
    } catch (error) {
      if (isUnsupportedCapability(error)) {
        throw new RuntimeSdkError(
          "unsupported_capability",
          error instanceof Error ? error.message : "captured Process spawn is unsupported",
          { details: { capability: "process.capture", runtime: CLAUDE_CODE_ADAPTER_ID } },
        );
      }
      throw error;
    }
    session.pendingAuthoringRequest = undefined;
    session.processHandle = captured.handle;
    session.captured = captured;
    session.handle = {
      ...session.handle,
      process: {
        pid: captured.handle.pid,
        startIdentity: captured.handle.startIdentity,
      },
    };
    session.status = "running";
    this.emitLocal(session, "runtime.started", { resumedFrom: "waiting_input" });
    void this.consume(session);
  }

  private accumulateAuthoringAssistantText(session: ClaudeCodeSession, chunk: string): void {
    session.authoringLineBuffer += chunk;
    const lines = session.authoringLineBuffer.split("\n");
    session.authoringLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = extractAssistantTextFromClaudeCodeJsonlLine(line);
      if (text.length > 0) {
        session.authoringAssistantText += text;
      }
    }
  }
}

export function createClaudeCodeRuntime(
  options?: ClaudeCodeRuntimeAdapterOptions,
): ClaudeCodeRuntimeAdapter {
  return new ClaudeCodeRuntimeAdapter(options);
}

function isUnsupportedCapability(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "unsupported_capability"
  );
}

function isAuthoringSnapshotRef(snapshotRef: string): boolean {
  return snapshotRef === "authoring:proposal" || snapshotRef.startsWith("authoring:");
}
