/**
 * Claude Code structured authoring proposals.
 *
 * The CLI has no dedicated proposal JSONL item. Authoring runs:
 * 1) start in waiting_input (no spawn),
 * 2) accept the Host transient handoff via sendInput,
 * 3) spawn with an authoring prompt on stdin,
 * 4) parse a single fenced JSON object after WORKFORCE_AUTHORING_PROPOSAL.
 *
 * Recorded fixtures supply that fence so Host/Daemon logic can be tested
 * without a real Anthropic login. Live Anthropic authoring is untested.
 */

import { parseAuthoringProposal, type AuthoringProposalDto } from "@workforce/protocol";
import { sha256Hex, stableJson } from "@workforce/runtime-sdk";

export const AUTHORING_PROPOSAL_MARKER = "WORKFORCE_AUTHORING_PROPOSAL";

export function buildClaudeCodeAuthoringPrompt(intent: string): string {
  const trimmed = intent.trim();
  return [
    "You are the AgentFlow workflow authoring agent.",
    "Read the user intent and emit exactly one structured AuthoringProposal.",
    "Do not run tools. Do not edit files. Do not execute a workflow.",
    "Reply with the marker line, then a single JSON object, nothing else:",
    AUTHORING_PROPOSAL_MARKER,
    "{",
    '  "id": "apr_<short>",',
    '  "projectId": "prj_pending",',
    '  "sourceRunId": "run_pending",',
    '  "summary": "<short safe summary, no secrets>",',
    '  "targets": [',
    "    {",
    '      "targetType": "workflow",',
    '      "targetId": "wf_pending",',
    '      "expectedRevision": 1,',
    '      "patchRef": "arv_<short>"',
    "    }",
    "  ]",
    "}",
    "User intent follows (do not echo it back):",
    trimmed.length > 0 ? trimmed : "(empty)",
  ].join("\n");
}

export function extractAssistantTextFromClaudeCodeJsonlLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "";
  }
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") {
    return "";
  }
  const message = record["message"];
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      continue;
    }
    const item = block as Record<string, unknown>;
    if (item["type"] === "text" && typeof item["text"] === "string") {
      parts.push(item["text"]);
    }
  }
  return parts.join("");
}

/**
 * Pulls the first JSON object after the authoring marker and validates it.
 * Returns undefined when the marker or a valid proposal is missing.
 */
export function parseClaudeCodeAuthoringProposalText(
  text: string,
): AuthoringProposalDto | undefined {
  const markerIndex = text.indexOf(AUTHORING_PROPOSAL_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const afterMarker = text.slice(markerIndex + AUTHORING_PROPOSAL_MARKER.length);
  const start = afterMarker.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  const jsonSlice = afterMarker.slice(start);
  const objectText = extractBalancedJsonObject(jsonSlice);
  if (objectText === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return undefined;
  }
  try {
    return parseAuthoringProposal(parsed);
  } catch {
    return undefined;
  }
}

export function buildRecordedAuthoringProposal(input: {
  handleId: string;
  intent: string;
}): AuthoringProposalDto {
  const digest = sha256Hex(stableJson({ intent: input.intent.trim() })).slice(0, 16);
  const proposal = {
    id: `apr_${input.handleId}`,
    projectId: "prj_pending",
    sourceRunId: "run_pending",
    summary: "Structured authoring proposal",
    targets: [
      {
        targetType: "workflow" as const,
        targetId: `wf_${digest}`,
        expectedRevision: 1,
        patchRef: `arv_claude_code_${digest}`,
      },
    ],
  };
  return parseAuthoringProposal(proposal);
}

/** JSONL stdout a Fake Process can replay for authoring tests (no live Claude). */
export function recordedAuthoringSuccessJsonl(proposal: AuthoringProposalDto): string {
  const fence = `${AUTHORING_PROPOSAL_MARKER}\n${JSON.stringify(proposal)}`;
  const assistant = {
    type: "assistant",
    message: {
      content: [{ type: "text", text: fence }],
    },
  };
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "fixture" }),
    JSON.stringify(assistant),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 8, output_tokens: 24 },
    }),
  ].join("\n");
}

function extractBalancedJsonObject(source: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(0, index + 1);
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}
