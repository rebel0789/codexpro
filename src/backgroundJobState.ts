import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { GitIdentityGuard } from "./gitIdentity.js";

export const BACKGROUND_JOB_VERSION = 1 as const;

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "canceling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "canceled";

export interface BackgroundJobDefinition {
  version: typeof BACKGROUND_JOB_VERSION;
  jobId: string;
  jobKey: string;
  fingerprint: string;
  command: string;
  workspaceRoot: string;
  cwd: string;
  createdAt: string;
  timeoutMs: number;
  maxLogBytes: number;
  bashSessionId?: string;
  gitGuard?: GitIdentityGuard;
}

export interface BackgroundJobState {
  version: typeof BACKGROUND_JOB_VERSION;
  jobId: string;
  status: BackgroundJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  runnerPid?: number;
  childPid?: number;
  childPgid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  cancelRequestedAt?: string;
  timedOut?: boolean;
  gitRepositoryRoot?: string;
  gitHeadAtStart?: string;
  gitWorktreeCleanAtStart?: boolean;
  gitGuardVerifiedAt?: string;
  error?: string;
}

export interface BackgroundJobCancelRequest {
  version: typeof BACKGROUND_JOB_VERSION;
  jobId: string;
  requestedAt: string;
  reason?: string;
}

export interface BackgroundJobPaths {
  root: string;
  jobDir: string;
  definition: string;
  state: string;
  cancelRequest: string;
  stdout: string;
  stderr: string;
  runnerLock: string;
  launchLock: string;
}

export const TERMINAL_BACKGROUND_JOB_STATUSES = new Set<BackgroundJobStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "canceled"
]);

export function backgroundJobPaths(root: string, jobId: string): BackgroundJobPaths {
  const jobDir = path.join(root, jobId);
  return {
    root,
    jobDir,
    definition: path.join(jobDir, "definition.json"),
    state: path.join(jobDir, "state.json"),
    cancelRequest: path.join(jobDir, "cancel-request.json"),
    stdout: path.join(jobDir, "stdout.log"),
    stderr: path.join(jobDir, "stderr.log"),
    runnerLock: path.join(jobDir, "runner.lock"),
    launchLock: path.join(jobDir, "launch.lock")
  };
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function isTerminalBackgroundJobStatus(status: string): boolean {
  return TERMINAL_BACKGROUND_JOB_STATUSES.has(status as BackgroundJobStatus);
}
