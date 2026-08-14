#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bashExecutable } from "./bashOps.js";
import { verifyGitIdentity } from "./gitIdentity.js";
import {
  BACKGROUND_JOB_VERSION,
  backgroundJobPaths,
  readJsonFile,
  writeJsonAtomic,
  type BackgroundJobCancelRequest,
  type BackgroundJobDefinition,
  type BackgroundJobState
} from "./backgroundJobState.js";

const HEARTBEAT_MS = 1_000;
const CANCEL_POLL_MS = 250;
const KILL_GRACE_MS = 5_000;

function assertDefinition(definition: BackgroundJobDefinition, definitionPath: string): void {
  if (definition.version !== BACKGROUND_JOB_VERSION) throw new Error("Unsupported background job definition version.");
  if (!/^job_[a-f0-9]{24}$/.test(definition.jobId)) throw new Error("Invalid background job id.");
  if (!definition.command?.trim()) throw new Error("Background job command is empty.");
  if (definition.gitGuard) {
    if (typeof definition.gitGuard.requireCleanWorktree !== "boolean") {
      throw new Error("Invalid background job Git clean-worktree guard.");
    }
    if (definition.gitGuard.expectedHead && !/^[0-9a-f]{40}$/i.test(definition.gitGuard.expectedHead)) {
      throw new Error("Invalid background job expected Git HEAD.");
    }
  }
  if (!path.isAbsolute(definition.workspaceRoot) || !path.isAbsolute(definition.cwd)) {
    throw new Error("Background job workspace and cwd must be absolute paths.");
  }
  const relative = path.relative(definition.workspaceRoot, definition.cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Background job cwd escapes its workspace root.");
  }
  const expectedDefinitionPath = backgroundJobPaths(path.dirname(path.dirname(definitionPath)), definition.jobId).definition;
  if (path.resolve(definitionPath) !== path.resolve(expectedDefinitionPath)) {
    throw new Error("Background job definition path does not match its job id.");
  }
}

function processError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

async function cancelRequest(paths: ReturnType<typeof backgroundJobPaths>, jobId: string): Promise<BackgroundJobCancelRequest | undefined> {
  try {
    const request = await readJsonFile<BackgroundJobCancelRequest>(paths.cancelRequest);
    if (request.version !== BACKGROUND_JOB_VERSION || request.jobId !== jobId) {
      throw new Error("Invalid background job cancellation request.");
    }
    return request;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function run(definitionPath: string): Promise<void> {
  const definition = await readJsonFile<BackgroundJobDefinition>(definitionPath);
  assertDefinition(definition, definitionPath);
  const root = path.dirname(path.dirname(definitionPath));
  const paths = backgroundJobPaths(root, definition.jobId);
  let runnerLock: fsp.FileHandle | undefined;
  try {
    runnerLock = await fsp.open(paths.runnerLock, "wx", 0o600);
    await runnerLock.writeFile(`${process.pid}\n`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }

  await fsp.unlink(paths.launchLock).catch(() => undefined);
  const createdAt = definition.createdAt;
  let state: BackgroundJobState = {
    version: BACKGROUND_JOB_VERSION,
    jobId: definition.jobId,
    status: "queued",
    createdAt,
    updatedAt: new Date().toISOString(),
    runnerPid: process.pid
  };
  let stateWrites: Promise<void> = Promise.resolve();
  const persistState = (): Promise<void> => {
    const snapshot = { ...state };
    stateWrites = stateWrites.then(() => writeJsonAtomic(paths.state, snapshot));
    return stateWrites;
  };

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let cancelTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  let cancellationStarted = false;
  let timedOut = false;
  let cancelRequestedAt: string | undefined;
  const started = Date.now();

  const beginTermination = (reason: "cancel" | "timeout", requestedAt?: string): void => {
    if (cancellationStarted || !child) return;
    cancellationStarted = true;
    timedOut = reason === "timeout";
    cancelRequestedAt = reason === "cancel" ? requestedAt ?? new Date().toISOString() : undefined;
    state = {
      ...state,
      status: reason === "cancel" ? "canceling" : "running",
      updatedAt: new Date().toISOString(),
      ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
      ...(timedOut ? { timedOut: true } : {})
    };
    void persistState();
    terminateProcessTree(child, "SIGTERM");
    killTimer = setTimeout(() => {
      if (child) terminateProcessTree(child, "SIGKILL");
    }, KILL_GRACE_MS);
    killTimer.unref();
  };

  const handleRunnerSignal = (): void => beginTermination("cancel", new Date().toISOString());
  process.on("SIGTERM", handleRunnerSignal);
  process.on("SIGINT", handleRunnerSignal);

  try {
    const preexistingCancel = await cancelRequest(paths, definition.jobId);
    if (preexistingCancel) {
      const finishedAt = new Date().toISOString();
      state = {
        ...state,
        status: "canceled",
        updatedAt: finishedAt,
        finishedAt,
        durationMs: 0,
        cancelRequestedAt: preexistingCancel.requestedAt,
        exitCode: null,
        signal: null
      };
      await persistState();
      return;
    }

    if (definition.gitGuard) {
      const observation = verifyGitIdentity(definition.workspaceRoot, definition.gitGuard);
      state = {
        ...state,
        updatedAt: observation.verifiedAt,
        gitRepositoryRoot: observation.repositoryRoot,
        gitHeadAtStart: observation.head,
        gitWorktreeCleanAtStart: observation.clean,
        gitGuardVerifiedAt: observation.verifiedAt
      };
      await persistState();
    }

    stdoutFd = fs.openSync(paths.stdout, "a", 0o600);
    stderrFd = fs.openSync(paths.stderr, "a", 0o600);
    child = spawn(bashExecutable(), ["-c", definition.command], {
      cwd: definition.cwd,
      env: { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    const childPid = child.pid;
    if (!childPid) throw new Error("Background job runner could not obtain the child process id.");
    const startedAt = new Date().toISOString();
    state = {
      ...state,
      status: "running",
      startedAt,
      updatedAt: startedAt,
      heartbeatAt: startedAt,
      childPid,
      ...(process.platform !== "win32" ? { childPgid: childPid } : {}),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false
    };
    await persistState();

    const appendLog = (stream: "stdout" | "stderr", chunk: unknown): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      const byteKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      const truncatedKey = stream === "stdout" ? "stdoutTruncated" : "stderrTruncated";
      const observed = (state[byteKey] ?? 0) + bytes.byteLength;
      const retainedBefore = Math.min(state[byteKey] ?? 0, definition.maxLogBytes);
      const remaining = Math.max(0, definition.maxLogBytes - retainedBefore);
      if (remaining > 0) {
        const fd = stream === "stdout" ? stdoutFd : stderrFd;
        if (fd !== undefined) fs.writeSync(fd, bytes.subarray(0, remaining));
      }
      state = {
        ...state,
        [byteKey]: observed,
        [truncatedKey]: observed > definition.maxLogBytes
      };
    };

    child.stdout?.on("data", (chunk) => appendLog("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendLog("stderr", chunk));

    heartbeatTimer = setInterval(() => {
      const now = new Date().toISOString();
      state = { ...state, updatedAt: now, heartbeatAt: now };
      void persistState();
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();

    cancelTimer = setInterval(() => {
      void cancelRequest(paths, definition.jobId)
        .then((request) => {
          if (request) beginTermination("cancel", request.requestedAt);
        })
        .catch((error) => {
          state = { ...state, error: processError(error), updatedAt: new Date().toISOString() };
          void persistState();
        });
    }, CANCEL_POLL_MS);
    cancelTimer.unref();

    timeoutTimer = setTimeout(() => beginTermination("timeout"), definition.timeoutMs);
    timeoutTimer.unref();

    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let settled = false;
      child?.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child?.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode, signal });
      });
    });

    const finishedAt = new Date().toISOString();
    const status = timedOut
      ? "timed_out"
      : cancelRequestedAt
        ? "canceled"
        : result.exitCode === 0
          ? "succeeded"
          : "failed";
    state = {
      ...state,
      status,
      updatedAt: finishedAt,
      heartbeatAt: finishedAt,
      finishedAt,
      durationMs: Date.now() - started,
      exitCode: result.exitCode,
      signal: result.signal,
      ...(timedOut ? { timedOut: true } : {}),
      ...(cancelRequestedAt ? { cancelRequestedAt } : {})
    };
    await persistState();
  } catch (error) {
    if (child?.pid) terminateProcessTree(child, "SIGKILL");
    const finishedAt = new Date().toISOString();
    state = {
      ...state,
      status: "failed",
      updatedAt: finishedAt,
      finishedAt,
      durationMs: Date.now() - started,
      exitCode: null,
      signal: null,
      error: processError(error)
    };
    await persistState();
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancelTimer) clearInterval(cancelTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    process.off("SIGTERM", handleRunnerSignal);
    process.off("SIGINT", handleRunnerSignal);
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    await stateWrites.catch(() => undefined);
    await runnerLock?.close().catch(() => undefined);
    await fsp.unlink(paths.runnerLock).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const definitionPath = process.argv[2];
  if (!definitionPath) throw new Error("Usage: backgroundJobRunner <definition.json>");
  await run(path.resolve(definitionPath));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(async (error) => {
    const definitionPath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
    if (definitionPath) {
      try {
        const definition = await readJsonFile<BackgroundJobDefinition>(definitionPath);
        const paths = backgroundJobPaths(path.dirname(path.dirname(definitionPath)), definition.jobId);
        const now = new Date().toISOString();
        await writeJsonAtomic(paths.state, {
          version: BACKGROUND_JOB_VERSION,
          jobId: definition.jobId,
          status: "failed",
          createdAt: definition.createdAt,
          updatedAt: now,
          finishedAt: now,
          exitCode: null,
          signal: null,
          error: processError(error)
        } satisfies BackgroundJobState);
      } catch {
        // The launcher will surface an interrupted queued job if even the failure state cannot be written.
      }
    }
    process.exitCode = 1;
  });
}

export { run as runBackgroundJobRunner };
