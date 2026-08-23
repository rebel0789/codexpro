import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export type BashTerminationReason = "normal" | "timeout" | "output_limit" | "signal";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  terminationReason: BashTerminationReason;
  observedStdoutBytes: number;
  observedStderrBytes: number;
  observedOutputBytes: number;
  retainedStdoutBytes: number;
  retainedStderrBytes: number;
  bashSessionId?: string;
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(config: CodexProConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function isUsableAbsoluteDir(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed)) return undefined;
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // Ignore unreadable candidates and keep searching.
  }
  return undefined;
}

/** Resolve a usable absolute home for restricted child processes. Rejects relative junk like "=". */
export function resolveUsableHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    isUsableAbsoluteDir(env.USERPROFILE) ??
    isUsableAbsoluteDir(env.HOME) ??
    isUsableAbsoluteDir(os.homedir()) ??
    path.resolve(os.homedir())
  );
}

export function makeRestrictedBashEnv(
  config: CodexProConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...env, NO_COLOR: "1", CI: env.CI ?? "1" };
  }
  const home = resolveUsableHomeDir(env);
  const restricted: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    USER: env.USER ?? env.USERNAME ?? "",
    SHELL: env.SHELL ?? "/bin/bash",
    TMPDIR: isUsableAbsoluteDir(env.TMPDIR) ?? isUsableAbsoluteDir(env.TMP) ?? os.tmpdir(),
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
  if (process.platform === "win32") {
    restricted.USERPROFILE = home;
    const appData = isUsableAbsoluteDir(env.APPDATA);
    const localAppData = isUsableAbsoluteDir(env.LOCALAPPDATA);
    if (appData) restricted.APPDATA = appData;
    if (localAppData) restricted.LOCALAPPDATA = localAppData;
    if (env.USERNAME) restricted.USERNAME = env.USERNAME;
    if (env.HOMEDRIVE && env.HOMEPATH && path.win32.isAbsolute(path.win32.join(env.HOMEDRIVE, env.HOMEPATH))) {
      restricted.HOMEDRIVE = env.HOMEDRIVE;
      restricted.HOMEPATH = env.HOMEPATH;
    }
  }
  return restricted;
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  return makeRestrictedBashEnv(config);
}

function bashExecutable(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function utf8PrefixByBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

function trimOutput(value: string, maxBytes: number, forceTruncated = false): { value: string; truncated: boolean } {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength <= maxBytes && !forceTruncated) return { value, truncated: false };
  const sliced = byteLength > maxBytes ? utf8PrefixByBytes(value, maxBytes) : value;
  return { value: `${sliced}\n...[output truncated to ${maxBytes} retained bytes]`, truncated: true };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Windows does not provide Unix-style cooperative signals to process trees.
    // Force the full tree while the parent PID still identifies its descendants;
    // otherwise the shell can exit first and orphan an output-heavy grandchild.
    const args = ["/pid", String(child.pid), "/t", "/f"];
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, config.maxBashTimeoutMs));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let killedByOutputLimit = false;
    let closed = false;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let observedStdoutBytes = 0;
    let observedStderrBytes = 0;
    let retainedStdoutBytes = 0;
    let retainedStderrBytes = 0;
    const retainedOutputBytes = config.maxOutputBytes + 1;
    const observedOutputLimit = Math.max(retainedOutputBytes, config.maxBashObservedOutputBytes);

    const terminate = (signal: NodeJS.Signals) => {
      if (closed) return;
      terminationStarted = true;
      terminateProcessTree(child, signal);
    };
    const terminateWithEscalation = () => {
      if (terminationStarted || closed) return;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 1_500);
      killTimer.unref();
    };
    const appendBounded = (stream: "stdout" | "stderr", current: string, chunk: unknown) => {
      const bytes = Buffer.from(String(chunk), "utf8");
      if (stream === "stdout") observedStdoutBytes += bytes.byteLength;
      else observedStderrBytes += bytes.byteLength;
      const retainedBytes = retainedStdoutBytes + retainedStderrBytes;
      const remaining = retainedOutputBytes - retainedBytes;
      if (remaining <= 0) return current;
      const retained = bytes.subarray(0, remaining);
      if (stream === "stdout") retainedStdoutBytes += retained.byteLength;
      else retainedStderrBytes += retained.byteLength;
      return current + retained.toString("utf8");
    };
    const enforceObservedOutputLimit = () => {
      if (!killedByOutputLimit && observedStdoutBytes + observedStderrBytes > observedOutputLimit) {
        killedByOutputLimit = true;
        terminateWithEscalation();
      }
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded("stdout", stdout, chunk);
      enforceObservedOutputLimit();
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded("stderr", stderr, chunk);
      enforceObservedOutputLimit();
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const observedOutputBytes = observedStdoutBytes + observedStderrBytes;
      const captureTruncated = observedOutputBytes > retainedStdoutBytes + retainedStderrBytes;
      if (killedByTimeout) {
        stderr += `\n[codexpro] Command timed out after ${timeoutMs} ms.`;
      } else if (killedByOutputLimit) {
        stderr += `\n[codexpro] Command terminated after exceeding ${observedOutputLimit} observed output bytes.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes, observedStdoutBytes > retainedStdoutBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes, observedStderrBytes > retainedStderrBytes);
      const terminationReason: BashTerminationReason = killedByOutputLimit
        ? "output_limit"
        : killedByTimeout
          ? "timeout"
          : signal
            ? "signal"
            : "normal";
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: captureTruncated || out.truncated || err.truncated,
        terminationReason,
        observedStdoutBytes,
        observedStderrBytes,
        observedOutputBytes,
        retainedStdoutBytes,
        retainedStderrBytes,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
