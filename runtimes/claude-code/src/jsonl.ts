import type { RuntimeEvent } from "@workforce/runtime-spi";
import { RuntimeSdkError } from "@workforce/runtime-sdk";

const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

/** Maximum UTF-8 bytes of the entire fixed `data.raw` metadata envelope. */
export const CLAUDE_CODE_RAW_METADATA_MAX_BYTES = 256;

type JsonObject = Record<string, unknown>;

export interface ClaudeCodeJsonlDecoderOptions {
  now?: () => Date;
  maxLineBytes?: number;
}

type TranslatedEvent = { type: string; data: Record<string, unknown> };

/**
 * Incrementally decodes ClaudeCode JSONL. Its cursor is only an in-memory source
 * position for dedupe; it is not resumable after the process/adapter restarts.
 */
export class ClaudeCodeJsonlDecoder {
  private readonly now: () => Date;
  private readonly maxLineBytes: number;
  private buffer = "";
  private sourceLine = 0;
  private adapterSequence = 0;
  private readonly translator = new ClaudeCodeTranslator();

  constructor(options: ClaudeCodeJsonlDecoderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (!Number.isInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new Error("maxLineBytes must be a positive integer");
    }
  }

  push(chunk: string): RuntimeEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    this.assertLineSize(this.buffer, this.sourceLine + lines.length + 1);
    return lines.flatMap((line) => this.decodeLine(line));
  }

  flush(): RuntimeEvent[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    return this.decodeLine(line);
  }

  private decodeLine(lineWithCarriageReturn: string): RuntimeEvent[] {
    const line = lineWithCarriageReturn.endsWith("\r")
      ? lineWithCarriageReturn.slice(0, -1)
      : lineWithCarriageReturn;
    this.sourceLine += 1;
    if (line.trim().length === 0) {
      return [];
    }
    this.assertLineSize(line, this.sourceLine);

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new RuntimeSdkError("validation_failed", "Claude Code emitted invalid JSONL", {
        details: { sourceLine: this.sourceLine },
      });
    }
    if (!isObject(parsed)) {
      throw new RuntimeSdkError("validation_failed", "ClaudeCode JSONL event must be an object", {
        details: { sourceLine: this.sourceLine },
      });
    }

    const translated = this.translator.translate(parsed);
    const raw = conservativeRawMetadata();
    const time = this.now().toISOString();
    return translated.map((event, index) => {
      this.adapterSequence += 1;
      return {
        type: event.type,
        time,
        sourceCursor: `claude-code-jsonl:${this.sourceLine}:${index + 1}`,
        data: {
          ...event.data,
          adapterSequence: this.adapterSequence,
          raw,
        },
      };
    });
  }

  private assertLineSize(line: string, sourceLine: number): void {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes > this.maxLineBytes) {
      throw new RuntimeSdkError(
        "validation_failed",
        "ClaudeCode JSONL line exceeds adapter limit",
        {
          details: { sourceLine, bytes, maxLineBytes: this.maxLineBytes },
        },
      );
    }
  }
}

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const LOGIN_PROBLEM_RE = /not logged in|\/login|authenticat|invalid api key|oauth|credit balance/iu;

/** Remembers which tool each tool_use id belongs to, so its result can be typed. */
class ClaudeCodeTranslator {
  private readonly toolNames = new Map<string, string>();

  translate(event: JsonObject): TranslatedEvent[] {
    const sourceType = stringValue(event["type"]) ?? "unknown";
    switch (sourceType) {
      case "system":
        return stringValue(event["subtype"]) === "init"
          ? [{ type: "runtime.started", data: {} }]
          : [];
      case "assistant":
        return this.translateAssistant(event["message"]);
      case "user":
        return this.translateToolResults(event["message"]);
      case "result":
        return translateResult(event);
      default:
        return [
          {
            type: "runtime.message",
            data: { kind: "claude_code_event", sourceType: "unrecognized" },
          },
        ];
    }
  }

  private translateAssistant(message: unknown): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    for (const block of contentBlocks(message)) {
      const blockType = stringValue(block["type"]);
      if (blockType === "text") {
        out.push({
          type: "runtime.message",
          data: { role: "assistant", contentRedacted: true },
        });
      } else if (blockType === "tool_use") {
        const name = stringValue(block["name"]) ?? "unknown";
        const id = stringValue(block["id"]);
        if (id) {
          this.toolNames.set(id, name);
        }
        if (name === "Bash") {
          out.push({ type: "runtime.command.started", data: { commandRedacted: true } });
        } else if (FILE_TOOLS.has(name)) {
          out.push({ type: "runtime.file.changed", data: { pathsRedacted: true } });
        } else {
          out.push({
            type: "runtime.message",
            data: { kind: "tool_use", toolType: "unrecognized", contentRedacted: true },
          });
        }
      }
      // "thinking" blocks are never forwarded.
    }
    return out;
  }

  private translateToolResults(message: unknown): TranslatedEvent[] {
    const out: TranslatedEvent[] = [];
    for (const block of contentBlocks(message)) {
      if (stringValue(block["type"]) !== "tool_result") {
        continue;
      }
      const id = stringValue(block["tool_use_id"]);
      const name = id ? this.toolNames.get(id) : undefined;
      if (name !== "Bash") {
        continue;
      }
      out.push({
        type: "runtime.command.output",
        data: { contentRedacted: true, observedOnCompletedItem: true },
      });
      out.push({
        type: "runtime.command.completed",
        data: { outputRedacted: true, failed: block["is_error"] === true },
      });
    }
    return out;
  }
}

function translateResult(event: JsonObject): TranslatedEvent[] {
  const failed = event["is_error"] === true || stringValue(event["subtype"]) !== "success";
  if (failed) {
    const text = stringValue(event["result"]) ?? "";
    return [
      {
        type: "runtime.failed",
        data: {
          reason: LOGIN_PROBLEM_RE.test(text)
            ? "claude_code_not_logged_in"
            : "claude_code_turn_failed",
          contentRedacted: true,
        },
      },
    ];
  }
  return [
    {
      type: "runtime.usage.updated",
      data: { usage: usageData(event["usage"]), monetaryCost: { status: "unknown" } },
    },
    { type: "runtime.completed", data: { candidate: true, taskCompletionClaimed: false } },
  ];
}

function contentBlocks(message: unknown): JsonObject[] {
  if (!isObject(message) || !Array.isArray(message["content"])) {
    return [];
  }
  return (message["content"] as unknown[]).filter(isObject);
}

function usageData(value: unknown): Record<string, number> {
  if (!isObject(value)) {
    return {};
  }
  const mappings = [
    ["inputTokens", "input_tokens"],
    ["cachedInputTokens", "cache_read_input_tokens"],
    ["cacheWriteInputTokens", "cache_creation_input_tokens"],
    ["outputTokens", "output_tokens"],
  ] as const;
  const usage: Record<string, number> = {};
  for (const [target, source] of mappings) {
    const number = nonNegativeInteger(value[source]);
    if (number !== undefined) {
      usage[target] = number;
    }
  }
  return usage;
}

function conservativeRawMetadata(): Record<string, unknown> {
  const raw = {
    namespace: "anthropic.claude-code",
    payload: { redacted: true },
    redaction: {
      applied: true,
      policyVersion: "claude-code-adapter-conservative-v1",
      categories: ["untrusted_runtime_payload"],
      replacements: 1,
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > CLAUDE_CODE_RAW_METADATA_MAX_BYTES) {
    throw new Error("Claude Code conservative raw metadata exceeds its fixed byte limit");
  }
  return raw;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
