export const packageName = "@workforce/runtime-claude-code" as const;

export {
  ClaudeCodeRuntimeAdapter,
  CLAUDE_CODE_ADAPTER_ID,
  CLAUDE_CODE_ADAPTER_VERSION,
  createClaudeCodeRuntime,
} from "./adapter.js";
export type { ClaudeCodeRuntimeAdapterOptions } from "./adapter.js";
export { buildClaudeCodeExecArgv } from "./command.js";
export type {
  ClaudeCodeApprovalMode,
  ClaudeCodeExecCommand,
  ClaudeCodeSandboxMode,
} from "./command.js";
export { detectClaudeCode, parseClaudeCodeVersion } from "./detect.js";
export type { ClaudeCodeDetection, DetectClaudeCodeOptions } from "./detect.js";
export { CLAUDE_CODE_RAW_METADATA_MAX_BYTES, ClaudeCodeJsonlDecoder } from "./jsonl.js";
export type { ClaudeCodeJsonlDecoderOptions } from "./jsonl.js";
export { parseClaudeCodeResolvedStartContext } from "./start-context.js";
export type {
  ClaudeCodeResolvedStartContext,
  ResolveClaudeCodeStartContext,
} from "./start-context.js";
