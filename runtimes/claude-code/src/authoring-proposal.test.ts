import { describe, expect, it } from "vitest";

import {
  AUTHORING_PROPOSAL_MARKER,
  buildClaudeCodeAuthoringPrompt,
  buildRecordedAuthoringProposal,
  extractAssistantTextFromClaudeCodeJsonlLine,
  parseClaudeCodeAuthoringProposalText,
  recordedAuthoringSuccessJsonl,
} from "./authoring-proposal.js";

describe("Claude Code authoring proposal helpers", () => {
  it("builds a prompt that asks for the proposal fence and never echoes as success", () => {
    const prompt = buildClaudeCodeAuthoringPrompt("规划然后实现");
    expect(prompt).toContain(AUTHORING_PROPOSAL_MARKER);
    expect(prompt).toContain("规划然后实现");
    expect(prompt).toContain("Do not run tools");
  });

  it("parses a valid fenced proposal and rejects missing markers", () => {
    const proposal = buildRecordedAuthoringProposal({
      handleId: "hdl_parse",
      intent: "建一个测试流程",
    });
    const text = `${AUTHORING_PROPOSAL_MARKER}\n${JSON.stringify(proposal)}`;
    expect(parseClaudeCodeAuthoringProposalText(text)).toEqual(proposal);
    expect(parseClaudeCodeAuthoringProposalText("just chat")).toBeUndefined();
    expect(
      parseClaudeCodeAuthoringProposalText(`${AUTHORING_PROPOSAL_MARKER}\n{not json}`),
    ).toBeUndefined();
  });

  it("extracts assistant text from Claude Code JSONL and builds recorded stdout", () => {
    const proposal = buildRecordedAuthoringProposal({
      handleId: "hdl_rec",
      intent: "workflow please",
    });
    const jsonl = recordedAuthoringSuccessJsonl(proposal);
    const lines = jsonl.split("\n");
    const assistantLine = lines.find((line) => line.includes('"assistant"'));
    expect(assistantLine).toBeTruthy();
    const extracted = extractAssistantTextFromClaudeCodeJsonlLine(assistantLine ?? "");
    expect(extracted).toContain(AUTHORING_PROPOSAL_MARKER);
    expect(parseClaudeCodeAuthoringProposalText(extracted)).toEqual(proposal);
  });
});
