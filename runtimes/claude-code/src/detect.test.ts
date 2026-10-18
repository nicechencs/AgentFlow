import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectClaudeCode, parseClaudeCodeVersion } from "./detect.js";

describe("Claude Code detection", () => {
  it("parses `claude --version` output", () => {
    expect(parseClaudeCodeVersion("2.1.302 (Claude Code)\n")).toBe("2.1.302");
  });

  it("prefers a configured executable over PATH", () => {
    const configured = path.join("/opt", "claude");
    const onPath = path.join("/usr", "bin", "claude");
    const found = detectClaudeCode({
      configuredExecutable: configured,
      pathDirs: [path.dirname(onPath)],
      platform: "linux",
      existsSync: (file) => file === configured || file === onPath,
    });
    expect(found).toMatchObject({ found: true, source: "configured", executable: configured });
  });

  it("searches PATH when nothing is configured", () => {
    const onPath = path.join("/usr", "local", "bin", "claude");
    const found = detectClaudeCode({
      pathDirs: [path.dirname(onPath)],
      platform: "linux",
      homedir: "/home/none",
      existsSync: (file) => file === onPath,
    });
    expect(found).toMatchObject({ found: true, source: "path", executable: onPath });
  });

  it("falls back to ~/.local/bin when PATH lacks claude", () => {
    const local = path.join("/home/chen", ".local", "bin", "claude");
    const found = detectClaudeCode({
      pathDirs: ["/usr/bin"],
      platform: "linux",
      homedir: "/home/chen",
      existsSync: (file) => file === local,
    });
    expect(found).toMatchObject({ found: true, source: "localbin", executable: local });
  });

  it("looks for claude.exe on Windows", () => {
    const local = path.join("C:", "Users", "chen", ".local", "bin", "claude.exe");
    const found = detectClaudeCode({
      pathDirs: [],
      platform: "win32",
      homedir: path.join("C:", "Users", "chen"),
      existsSync: (file) => file === local,
    });
    expect(found).toMatchObject({ found: true, source: "localbin", executable: local });
  });

  it("does not invent a binary when nothing exists", () => {
    const found = detectClaudeCode({
      pathDirs: [],
      platform: "linux",
      homedir: "/home/none",
      existsSync: () => false,
    });
    expect(found).toEqual({ found: false, source: "none" });
  });
});
