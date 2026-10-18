import { describe, expect, it } from "vitest";

import { RuntimeSdkError } from "@workforce/runtime-sdk";

import { CLAUDE_CODE_RAW_METADATA_MAX_BYTES, ClaudeCodeJsonlDecoder } from "./jsonl.js";

const NOW = new Date("2026-09-11T00:00:00.000Z");

function decoder(options: ConstructorParameters<typeof ClaudeCodeJsonlDecoder>[0] = {}) {
  return new ClaudeCodeJsonlDecoder({ now: () => NOW, ...options });
}

describe("ClaudeCodeJsonlDecoder", () => {
  it("maps a live stream-json run and keeps cost unknown", () => {
    const subject = decoder();
    const lines = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "SAFE_THOUGHT" },
            { type: "text", text: "SAFE_PROBE_OK" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "SAFE_CMD" } },
            { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/SAFE_PATH" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "SAFE_PROBE_INPUT" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "SAFE_FINAL",
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 5,
          output_tokens: 4,
        },
      },
    ].map((item) => JSON.stringify(item));
    const events = [
      ...subject.push(lines.slice(0, 3).join("\n") + "\n" + lines[3]!.slice(0, 20)),
      ...subject.push(lines[3]!.slice(20) + "\n" + lines[4] + "\n"),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "runtime.started",
      "runtime.message",
      "runtime.command.started",
      "runtime.file.changed",
      "runtime.command.output",
      "runtime.command.completed",
      "runtime.usage.updated",
      "runtime.completed",
    ]);
    expect(events[6]?.data).toMatchObject({
      usage: { inputTokens: 12, cachedInputTokens: 3, cacheWriteInputTokens: 5, outputTokens: 4 },
      monetaryCost: { status: "unknown" },
    });
    expect(events[6]?.data).not.toHaveProperty("costMinor");
    expect(events[7]?.data).toMatchObject({ candidate: true, taskCompletionClaimed: false });
    expect(events.map((event) => event.data["adapterSequence"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const serialized = JSON.stringify(events);
    for (const secret of [
      "SAFE_THOUGHT",
      "SAFE_PROBE_OK",
      "SAFE_CMD",
      "SAFE_PATH",
      "SAFE_PROBE_INPUT",
      "SAFE_FINAL",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("turns an error result into a failure and recognises a missing login", () => {
    const failed = decoder().push(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }) + "\n",
    );
    expect(failed.map((event) => event.type)).toEqual(["runtime.failed"]);
    expect(failed[0]?.data).toMatchObject({ reason: "claude_code_turn_failed" });

    const login = decoder().push(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
      }) + "\n",
    );
    expect(login[0]?.type).toBe("runtime.failed");
    expect(login[0]?.data).toMatchObject({ reason: "claude_code_not_logged_in" });
    expect(JSON.stringify(login)).not.toContain("Please run");
  });

  it("omits arbitrary text from normalized and raw event data", () => {
    const knownSecret = "fixture-known-secret";
    const events = decoder().push(
      JSON.stringify({
        type: "assistant",
        api_key: "sk-proj-abcdefghijklmnop",
        message: { content: [{ type: "text", text: `done ${knownSecret}` }] },
      }) + "\n",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "runtime.message",
      sourceCursor: "claude-code-jsonl:1:1",
      data: {
        contentRedacted: true,
        raw: {
          namespace: "anthropic.claude-code",
          payload: { redacted: true },
        },
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(knownSecret);
    expect(serialized).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it.each(["ascii", "中文内容", "emoji-🚀-🔒"])(
    "keeps the entire conservative raw envelope within its UTF-8 bound for %s input",
    (text) => {
      const events = decoder().push(
        JSON.stringify({ type: "unknown.future", text: text.repeat(100) }) + "\n",
      );
      const raw = events[0]?.data["raw"];
      expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeLessThanOrEqual(
        CLAUDE_CODE_RAW_METADATA_MAX_BYTES,
      );
      expect(JSON.stringify(raw)).not.toContain(text);
    },
  );

  it("checks an unterminated line immediately for single and accumulated chunks", () => {
    expect(() => decoder({ maxLineBytes: 8 }).push("123456789")).toThrowError(
      /exceeds adapter limit/,
    );

    const accumulated = decoder({ maxLineBytes: 8 });
    expect(() => accumulated.push("1234")).not.toThrow();
    expect(() => accumulated.push("5678")).not.toThrow();
    expect(() => accumulated.push("9")).toThrowError(/exceeds adapter limit/);

    const exactLine = '{"type":"other"}';
    const exact = decoder({ maxLineBytes: Buffer.byteLength(exactLine, "utf8") });
    expect(() => exact.push(exactLine)).not.toThrow();
    expect(exact.push("\n")).toHaveLength(1);
  });

  it("rejects malformed and oversized JSONL without echoing source text", () => {
    const malformed = decoder();
    malformed.push('{"token":"secret"');
    expect(() => malformed.flush()).toThrowError(
      expect.objectContaining<Partial<RuntimeSdkError>>({
        code: "validation_failed",
        message: "Claude Code emitted invalid JSONL",
      }),
    );

    const oversized = decoder({ maxLineBytes: 8 });
    expect(() => oversized.push('{"type":"other"}\n')).toThrowError(/exceeds adapter limit/);
  });
});
