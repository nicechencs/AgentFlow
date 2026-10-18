import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeCodeDetection {
  found: boolean;
  executable?: string;
  version?: string;
  source: "configured" | "path" | "localbin" | "none";
}

export interface DetectClaudeCodeOptions {
  configuredExecutable?: string;
  pathDirs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  existsSync?: (file: string) => boolean;
  readVersion?: (executable: string) => string | undefined;
}

/** `claude --version` prints e.g. `2.1.302 (Claude Code)`. */
const VERSION_RE = /^(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)/m;

export function parseClaudeCodeVersion(output: string): string | undefined {
  const match = VERSION_RE.exec(output);
  return match?.[1];
}

function foundDetection(
  source: Exclude<ClaudeCodeDetection["source"], "none">,
  executable: string,
  version: string | undefined,
): ClaudeCodeDetection {
  return version
    ? { found: true, executable, version, source }
    : { found: true, executable, source };
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
}

/**
 * Looks at the configured path, then PATH, then the native installer's
 * `~/.local/bin` (a background service often has a PATH without it).
 */
export function detectClaudeCode(options: DetectClaudeCodeOptions = {}): ClaudeCodeDetection {
  const existsSync = options.existsSync ?? fs.existsSync;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathDirs = options.pathDirs ?? (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const names = executableNames(platform);

  if (options.configuredExecutable && existsSync(options.configuredExecutable)) {
    return foundDetection(
      "configured",
      options.configuredExecutable,
      options.readVersion?.(options.configuredExecutable),
    );
  }

  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        return foundDetection("path", candidate, options.readVersion?.(candidate));
      }
    }
  }

  const localBin = path.join(options.homedir ?? os.homedir(), ".local", "bin");
  for (const name of names) {
    const candidate = path.join(localBin, name);
    if (existsSync(candidate)) {
      return foundDetection("localbin", candidate, options.readVersion?.(candidate));
    }
  }

  return { found: false, source: "none" };
}
