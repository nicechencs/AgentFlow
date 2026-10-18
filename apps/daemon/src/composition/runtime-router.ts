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
  RuntimeStatus,
  ValidationResult,
} from "@workforce/runtime-spi";
import type { StartRunRequest } from "@workforce/protocol";
import { RuntimeSdkError } from "@workforce/runtime-sdk";

type RoutedAdapter = RuntimeAdapter & { dispose?: () => Promise<void> };

/**
 * Sends each Run to the adapter named by `request.runtime.adapterId`. An unknown
 * id is an error; it never falls back to another adapter. Later calls follow the
 * handle that `start` or `reconcile` registered. The first adapter is only the
 * answer for `describe`/`validate` and for handles this process never saw.
 */
export class RoutingRuntimeAdapter implements RuntimeAdapter {
  private readonly adapters = new Map<string, RoutedAdapter>();
  private readonly byHandle = new Map<string, string>();
  private readonly primary: RoutedAdapter;

  constructor(adapters: ReadonlyArray<readonly [string, RoutedAdapter]>) {
    const first = adapters[0];
    if (!first) {
      throw new Error("RoutingRuntimeAdapter needs at least one adapter");
    }
    this.primary = first[1];
    for (const [id, adapter] of adapters) {
      this.adapters.set(id, adapter);
    }
  }

  supportsAdapterId(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  describe(): Promise<RuntimeDescriptor> {
    return this.primary.describe();
  }

  validate(config: RuntimeConfig): Promise<ValidationResult> {
    return (this.adapters.get(config.adapterId) ?? this.primary).validate(config);
  }

  async start(request: StartRunRequest): Promise<RuntimeHandle> {
    const id = request.runtime.adapterId;
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new RuntimeSdkError("validation_failed", `未知的执行器：${id}`, {
        details: { adapterId: id },
      });
    }
    const handle = await adapter.start(request);
    this.byHandle.set(handle.handleId, id);
    return handle;
  }

  sendInput(
    handle: RuntimeHandleRef,
    input: Parameters<RuntimeAdapter["sendInput"]>[1],
  ): Promise<InputReceipt> {
    return this.forHandle(handle).sendInput(handle, input);
  }

  cancel(handle: RuntimeHandleRef, reason?: string): Promise<OperationReceipt> {
    return this.forHandle(handle).cancel(handle, reason);
  }

  inspect(handle: RuntimeHandleRef): Promise<RuntimeStatus> {
    return this.forHandle(handle).inspect(handle);
  }

  stream(handle: RuntimeHandleRef, cursor?: EventCursor): AsyncIterable<RuntimeEvent> {
    return this.forHandle(handle).stream(handle, cursor);
  }

  reconcile(handle: RuntimeHandle): Promise<ReconciliationResult> {
    const id = this.adapters.has(handle.adapterId) ? handle.adapterId : undefined;
    if (id) {
      this.byHandle.set(handle.handleId, id);
    }
    return this.forHandle(handle).reconcile(handle);
  }

  async dispose(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.dispose?.();
    }
  }

  private forHandle(handle: RuntimeHandleRef): RoutedAdapter {
    const id = this.byHandle.get(handle.handleId);
    return (id ? this.adapters.get(id) : undefined) ?? this.primary;
  }
}
