#!/usr/bin/env node
import { stdin } from "node:process";

const sleepMs = Number.parseInt(process.env.CLAUDE_CODE_FIXTURE_SLEEP_MS ?? "0", 10);

function writeJsonl() {
  const events = [
    { type: "system", subtype: "init", session_id: "fixture-session" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "fixture" }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ];
  for (const event of events) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

await readStdin();
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, sleepMs);
  });
}
writeJsonl();
