import type { DesktopClient, RuntimeCapabilitiesDto, RuntimeDto } from "@workforce/desktop-client";

/** Product Host defaults to Claude Code (Codex stays selectable). UI must not present Mock as the current runtime. */
export const DEFAULT_HOST_ADAPTER_ID = "claude-code";
const LIVE_ADAPTER_IDS: readonly string[] = ["claude-code", "codex"];
export const LOCAL_HOST_TITLE = "本机 Claude Code";
export const LOCAL_HOST_RUNTIME_FIELD = "Claude Code CLI";
export const LOCAL_HOST_READY = "本机 Claude Code CLI 已就绪。";
export const LOCAL_HOST_NOT_READY =
  "Claude Code 未就绪：未检测到 CLI 或未登录。启动会失败，不会回退 Mock。";
export const LOCAL_HOST_PROBE_PENDING =
  "本机 Claude Code Host。未返回 Runtime 目录前不当成有本地执行器在干活；缺 CLI 或未登录时启动会失败。";
export const LOCAL_HOST_NOT_CODEX =
  "当前 Daemon 未组成 Claude Code / Codex Host。产品默认是 Claude Code、fail-closed；不要把测试夹具当成在干活。";

function hostFieldLabel(adapterId: string): string {
  return adapterId === "codex" ? "Codex CLI" : LOCAL_HOST_RUNTIME_FIELD;
}

export interface HostRuntimeView {
  adapterId: string;
  displayName: string;
  title: string;
  fieldLabel: string;
  summary: string;
  codingReady: boolean;
}

export function unprobedHostRuntime(): HostRuntimeView {
  return {
    adapterId: DEFAULT_HOST_ADAPTER_ID,
    displayName: LOCAL_HOST_RUNTIME_FIELD,
    title: LOCAL_HOST_TITLE,
    fieldLabel: LOCAL_HOST_RUNTIME_FIELD,
    summary: LOCAL_HOST_PROBE_PENDING,
    codingReady: false,
  };
}

export function missingHostRuntime(): HostRuntimeView {
  return {
    adapterId: DEFAULT_HOST_ADAPTER_ID,
    displayName: LOCAL_HOST_RUNTIME_FIELD,
    title: LOCAL_HOST_TITLE,
    fieldLabel: LOCAL_HOST_RUNTIME_FIELD,
    summary: LOCAL_HOST_NOT_READY,
    codingReady: false,
  };
}

export function viewFromRuntime(
  runtime: Pick<RuntimeDto, "id" | "adapterId" | "displayName">,
  capabilities: RuntimeCapabilitiesDto | null,
): HostRuntimeView {
  const adapterId = runtime.adapterId || runtime.id;
  const codingReady =
    LIVE_ADAPTER_IDS.includes(adapterId) &&
    capabilities?.capabilities.some((item) => item.name === "coding" && item.available) === true;
  if (!LIVE_ADAPTER_IDS.includes(adapterId)) {
    return {
      adapterId,
      displayName: runtime.displayName,
      title: LOCAL_HOST_TITLE,
      fieldLabel: LOCAL_HOST_RUNTIME_FIELD,
      summary: LOCAL_HOST_NOT_CODEX,
      codingReady: false,
    };
  }
  const field = hostFieldLabel(adapterId);
  return {
    adapterId,
    displayName: runtime.displayName,
    title: `本机 ${field.replace(" CLI", "")}`,
    fieldLabel: field,
    summary: codingReady
      ? `本机 ${field} 已就绪。`
      : `${field.replace(" CLI", "")} 未就绪：未检测到 CLI 或未登录。启动会失败，不会回退 Mock。`,
    codingReady,
  };
}

export async function probeHostRuntime(
  client: Pick<DesktopClient, "listRuntimes" | "getRuntimeCapabilities">,
): Promise<HostRuntimeView> {
  try {
    const page = await client.listRuntimes({ limit: 20 });
    const runtime = pickListedRuntime(page.items);
    if (!runtime) {
      return missingHostRuntime();
    }
    let capabilities: RuntimeCapabilitiesDto | null = null;
    try {
      capabilities = await client.getRuntimeCapabilities(runtime.id);
    } catch {
      capabilities = null;
    }
    return viewFromRuntime(runtime, capabilities);
  } catch {
    return missingHostRuntime();
  }
}

export function runtimeProfileLabel(profile: string): string {
  if (profile === "claude-code") {
    return "Claude Code";
  }
  if (profile === "codex") {
    return "Codex";
  }
  if (profile === "mock") {
    return "Claude Code（Host 已钉死；配置字段 mock 不是当前执行器）";
  }
  return profile;
}

export function projectRuntimeLabel(runtime: HostRuntimeView): string {
  return runtime.codingReady ? LOCAL_HOST_RUNTIME_FIELD : `${LOCAL_HOST_RUNTIME_FIELD} · 未就绪`;
}

function pickListedRuntime(items: readonly RuntimeDto[]): RuntimeDto | null {
  return (
    items.find(
      (item) => item.adapterId === DEFAULT_HOST_ADAPTER_ID || item.id === DEFAULT_HOST_ADAPTER_ID,
    ) ??
    items.find((item) => item.adapterId === "codex" || item.id === "codex") ??
    items[0] ??
    null
  );
}
