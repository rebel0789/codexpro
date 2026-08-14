import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { assertBashCommandAllowed, assertBashSession, makeBashEnv } from "./bashOps.js";
import {
  BACKGROUND_JOB_VERSION,
  backgroundJobPaths,
  isTerminalBackgroundJobStatus,
  readJsonFile,
  writeJsonAtomic,
  type BackgroundJobCancelRequest,
  type BackgroundJobDefinition,
  type BackgroundJobState
} from "./backgroundJobState.js";
import { redactSensitiveText } from "./redact.js";
import { normalizeGitIdentityGuard, verifyGitIdentity, type GitIdentityGuard } from "./gitIdentity.js";

const JOB_ID_PATTERN = /^job_[a-f0-9]{24}$/;
const JOB_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const LAUNCH_LOCK_STALE_MS = 10_000;
const INTERRUPTED_AFTER_MS = 10_000;
const RUNNER_HEARTBEAT_STALE_MS = 15_000;
const RUNNER_PATH = fileURLToPath(new URL("./backgroundJobRunner.js", import.meta.url));

export type ObservedBackgroundJobStatus =
  | BackgroundJobState["status"]
  | "interrupted"
  | "unmonitored";

export interface BackgroundJobView {
  job_id: string;
  job_key: string;
  status: ObservedBackgroundJobStatus;
  persisted_status: BackgroundJobState["status"];
  terminal: boolean;
  command: string;
  command_fingerprint: string;
  workspace_root: string;
  cwd: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  timeout_ms: number;
  duration_ms: number | null;
  runner_pid: number | null;
  child_pid: number | null;
  child_pgid: number | null;
  runner_alive: boolean;
  child_alive: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  cancel_requested_at: string | null;
  timed_out: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  stdout_tail: string;
  stderr_tail: string;
  error: string | null;
  git_guard: {
    expected_head: string | null;
    require_clean_worktree: boolean;
    repository_root: string | null;
    verified_head: string | null;
    verified_clean: boolean | null;
    verified_at: string | null;
  } | null;
  paths: {
    state: string;
    stdout: string;
    stderr: string;
  };
  reused?: boolean;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintFor(input: {
  workspaceRoot: string;
  cwd: string;
  command: string;
  timeoutMs: number;
  maxLogBytes: number;
  gitGuard?: GitIdentityGuard;
}): string {
  const parts = [
    "codexpro-background-job-v1",
    input.workspaceRoot,
    input.cwd,
    input.command,
    String(input.timeoutMs),
    String(input.maxLogBytes)
  ];
  if (input.gitGuard) {
    parts.push(
      "git-identity-guard-v1",
      input.gitGuard.expectedHead ?? "",
      input.gitGuard.requireCleanWorktree ? "clean" : "dirty-allowed"
    );
  }
  return hash(parts.join("\0"));
}

function jobIdFor(workspaceRoot: string, jobKey: string): string {
  return `job_${hash(`${workspaceRoot}\0${jobKey}`).slice(0, 24)}`;
}

function validateJobKey(jobKey: string): string {
  const normalized = jobKey.trim();
  if (!JOB_KEY_PATTERN.test(normalized)) {
    throw new CodexProError(
      "job_key must be 1-160 characters, start with a letter or number, and use only letters, numbers, dot, underscore, colon, at, slash, or dash."
    );
  }
  return normalized;
}

function validateJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!JOB_ID_PATTERN.test(normalized)) throw new CodexProError("Invalid background job id.");
  return normalized;
}

async function ensureJobRoot(root: string): Promise<void> {
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CodexProError(`CODEXPRO_JOB_DIR must be a real directory, not a file or symlink: ${root}`);
  }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return "";
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    const length = Math.min(maxBytes, stat.size);
    if (!length) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    return redactSensitiveText(buffer.toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertDefinition(definition: BackgroundJobDefinition, workspace: Workspace, expectedJobId?: string): void {
  if (definition.version !== BACKGROUND_JOB_VERSION) throw new CodexProError("Unsupported background job definition version.");
  if (!JOB_ID_PATTERN.test(definition.jobId) || (expectedJobId && definition.jobId !== expectedJobId)) {
    throw new CodexProError("Background job definition identity mismatch.");
  }
  if (definition.workspaceRoot !== workspace.root) {
    throw new CodexProError("Background job belongs to a different allowed workspace.");
  }
  if (definition.gitGuard) {
    if (typeof definition.gitGuard.requireCleanWorktree !== "boolean") {
      throw new CodexProError("Background job Git guard is invalid.");
    }
    if (definition.gitGuard.expectedHead && !/^[0-9a-f]{40}$/i.test(definition.gitGuard.expectedHead)) {
      throw new CodexProError("Background job expected Git HEAD is invalid.");
    }
  }
}

async function readDefinition(config: CodexProConfig, workspace: Workspace, jobId: string): Promise<BackgroundJobDefinition> {
  const paths = backgroundJobPaths(config.backgroundJobDir, validateJobId(jobId));
  let definition: BackgroundJobDefinition;
  try {
    definition = await readJsonFile<BackgroundJobDefinition>(paths.definition);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexProError(`Background job not found in this workspace: ${jobId}`);
    }
    throw error;
  }
  assertDefinition(definition, workspace, jobId);
  return definition;
}

async function readState(definition: BackgroundJobDefinition, statePath: string): Promise<BackgroundJobState> {
  try {
    const state = await readJsonFile<BackgroundJobState>(statePath);
    if (
      state.version !== BACKGROUND_JOB_VERSION ||
      state.jobId !== definition.jobId ||
      typeof state.status !== "string"
    ) {
      throw new CodexProError("Background job state identity is invalid.");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: BACKGROUND_JOB_VERSION,
      jobId: definition.jobId,
      status: "queued",
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt
    };
  }
}

function observedStatus(state: BackgroundJobState, runnerAlive: boolean, childAlive: boolean): ObservedBackgroundJobStatus {
  if (isTerminalBackgroundJobStatus(state.status)) return state.status;
  const heartbeat = Date.parse(state.heartbeatAt ?? state.updatedAt ?? state.createdAt);
  const heartbeatFresh = Number.isFinite(heartbeat) && Date.now() - heartbeat < RUNNER_HEARTBEAT_STALE_MS;
  if (runnerAlive && heartbeatFresh) return state.status;
  if (childAlive) return "unmonitored";
  const updated = Date.parse(state.updatedAt || state.createdAt);
  if (Number.isFinite(updated) && Date.now() - updated < INTERRUPTED_AFTER_MS) return state.status;
  return "interrupted";
}

async function viewFor(
  config: CodexProConfig,
  workspace: Workspace,
  definition: BackgroundJobDefinition,
  tailBytes: number,
  reused?: boolean
): Promise<BackgroundJobView> {
  assertDefinition(definition, workspace);
  const paths = backgroundJobPaths(config.backgroundJobDir, definition.jobId);
  const state = await readState(definition, paths.state);
  const runnerAlive = processAlive(state.runnerPid);
  const childAlive = processAlive(state.childPid);
  const status = observedStatus(state, runnerAlive, childAlive);
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const duration = state.durationMs ?? (Number.isFinite(startedAtMs) && !isTerminalBackgroundJobStatus(status)
    ? Math.max(0, Date.now() - startedAtMs)
    : null);
  const [stdoutTail, stderrTail] = await Promise.all([
    readTail(paths.stdout, tailBytes),
    readTail(paths.stderr, tailBytes)
  ]);
  return {
    job_id: definition.jobId,
    job_key: definition.jobKey,
    status,
    persisted_status: state.status,
    terminal: isTerminalBackgroundJobStatus(status) || status === "interrupted",
    command: redactSensitiveText(definition.command),
    command_fingerprint: definition.fingerprint,
    workspace_root: definition.workspaceRoot,
    cwd: definition.cwd,
    created_at: definition.createdAt,
    started_at: state.startedAt ?? null,
    finished_at: state.finishedAt ?? null,
    heartbeat_at: state.heartbeatAt ?? null,
    timeout_ms: definition.timeoutMs,
    duration_ms: duration,
    runner_pid: state.runnerPid ?? null,
    child_pid: state.childPid ?? null,
    child_pgid: state.childPgid ?? null,
    runner_alive: runnerAlive,
    child_alive: childAlive,
    exit_code: state.exitCode ?? null,
    signal: state.signal ?? null,
    cancel_requested_at: state.cancelRequestedAt ?? null,
    timed_out: Boolean(state.timedOut),
    stdout_bytes: state.stdoutBytes ?? 0,
    stderr_bytes: state.stderrBytes ?? 0,
    stdout_truncated: Boolean(state.stdoutTruncated),
    stderr_truncated: Boolean(state.stderrTruncated),
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    error: state.error ? redactSensitiveText(state.error) : null,
    git_guard: definition.gitGuard
      ? {
          expected_head: definition.gitGuard.expectedHead ?? null,
          require_clean_worktree: definition.gitGuard.requireCleanWorktree,
          repository_root: state.gitRepositoryRoot ?? null,
          verified_head: state.gitHeadAtStart ?? null,
          verified_clean: state.gitWorktreeCleanAtStart ?? null,
          verified_at: state.gitGuardVerifiedAt ?? null
        }
      : null,
    paths: {
      state: paths.state,
      stdout: paths.stdout,
      stderr: paths.stderr
    },
    ...(reused === undefined ? {} : { reused })
  };
}

async function acquireLaunchLock(lockPath: string): Promise<fsp.FileHandle | undefined> {
  try {
    const handle = await fsp.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const stat = await fsp.stat(lockPath).catch(() => undefined);
  if (!stat || Date.now() - stat.mtimeMs < LAUNCH_LOCK_STALE_MS) return undefined;
  const stalePath = `${lockPath}.stale.${Date.now()}.${randomUUID()}`;
  await fsp.rename(lockPath, stalePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  try {
    const handle = await fsp.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

async function launchRunner(config: CodexProConfig, definition: BackgroundJobDefinition): Promise<boolean> {
  const paths = backgroundJobPaths(config.backgroundJobDir, definition.jobId);
  const lock = await acquireLaunchLock(paths.launchLock);
  if (!lock) return false;
  await lock.close();
  try {
    const runner = spawn(process.execPath, [RUNNER_PATH, paths.definition], {
      cwd: definition.workspaceRoot,
      env: makeBashEnv(config),
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    await new Promise<void>((resolve, reject) => {
      runner.once("spawn", resolve);
      runner.once("error", reject);
    });
    runner.unref();
    return true;
  } catch (error) {
    await fsp.unlink(paths.launchLock).catch(() => undefined);
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
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    } satisfies BackgroundJobState);
    throw error;
  }
}

async function waitForRunnerStart(
  config: CodexProConfig,
  workspace: Workspace,
  definition: BackgroundJobDefinition,
  timeoutMs = 1_500
): Promise<BackgroundJobView> {
  const deadline = Date.now() + timeoutMs;
  let view = await viewFor(config, workspace, definition, 0);
  while (Date.now() < deadline && view.status === "queued") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    view = await viewFor(config, workspace, definition, 0);
  }
  return view;
}

export async function startBackgroundJob(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: {
    jobKey: string;
    cwd?: string;
    timeoutMs?: number;
    sessionId?: string;
    expectedGitHead?: string;
    requireCleanWorktree?: boolean;
  }
): Promise<BackgroundJobView> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const jobKey = validateJobKey(options.jobKey);
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertBashCommandAllowed(config, command);
  const cwd = guard.resolve(workspace, options.cwd ?? ".").absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? config.backgroundJobDefaultTimeoutMs, 24 * 60 * 60_000));
  const maxLogBytes = config.backgroundJobMaxLogBytes;
  const gitGuard = normalizeGitIdentityGuard({
    expectedHead: options.expectedGitHead,
    requireCleanWorktree: options.requireCleanWorktree
  });
  const fingerprint = fingerprintFor({ workspaceRoot: workspace.root, cwd, command, timeoutMs, maxLogBytes, gitGuard });
  const jobId = jobIdFor(workspace.root, jobKey);
  const paths = backgroundJobPaths(config.backgroundJobDir, jobId);
  await ensureJobRoot(config.backgroundJobDir);
  if (gitGuard) verifyGitIdentity(workspace.root, gitGuard);

  let created = false;
  try {
    await fsp.mkdir(paths.jobDir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  if (!created) {
    const existing = await readDefinition(config, workspace, jobId);
    if (existing.jobKey !== jobKey || existing.fingerprint !== fingerprint) {
      throw new CodexProError(
        `job_key is already bound to a different command or execution contract: ${jobKey}. ` +
          "Use get_background_job to inspect it, or choose a new explicit job_key for an intentional new run."
      );
    }
    const current = await viewFor(config, workspace, existing, 0, true);
    if (current.status === "interrupted" && current.persisted_status === "queued") {
      await launchRunner(config, existing);
      const relaunched = await waitForRunnerStart(config, workspace, existing);
      return { ...relaunched, reused: true };
    }
    return current;
  }

  const createdAt = new Date().toISOString();
  const definition: BackgroundJobDefinition = {
    version: BACKGROUND_JOB_VERSION,
    jobId,
    jobKey,
    fingerprint,
    command,
    workspaceRoot: workspace.root,
    cwd,
    createdAt,
    timeoutMs,
    maxLogBytes,
    ...(bashSessionId ? { bashSessionId } : {}),
    ...(gitGuard ? { gitGuard } : {})
  };
  await writeJsonAtomic(paths.definition, definition);
  await writeJsonAtomic(paths.state, {
    version: BACKGROUND_JOB_VERSION,
    jobId,
    status: "queued",
    createdAt,
    updatedAt: createdAt
  } satisfies BackgroundJobState);
  await launchRunner(config, definition);
  const view = await waitForRunnerStart(config, workspace, definition);
  return { ...view, reused: false };
}

function jobIdFromIdentifier(workspace: Workspace, input: { jobId?: string; jobKey?: string }): string {
  if (input.jobId) return validateJobId(input.jobId);
  if (input.jobKey) return jobIdFor(workspace.root, validateJobKey(input.jobKey));
  throw new CodexProError("Provide job_id or job_key.");
}

export async function getBackgroundJob(
  config: CodexProConfig,
  workspace: Workspace,
  input: { jobId?: string; jobKey?: string; tailBytes?: number }
): Promise<BackgroundJobView> {
  await ensureJobRoot(config.backgroundJobDir);
  const jobId = jobIdFromIdentifier(workspace, input);
  const definition = await readDefinition(config, workspace, jobId);
  const tailBytes = Math.max(0, Math.min(input.tailBytes ?? 4_000, 30_000));
  return viewFor(config, workspace, definition, tailBytes);
}

export async function listBackgroundJobs(
  config: CodexProConfig,
  workspace: Workspace,
  options: { limit?: number; includeTerminal?: boolean } = {}
): Promise<BackgroundJobView[]> {
  await ensureJobRoot(config.backgroundJobDir);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const entries = await fsp.readdir(config.backgroundJobDir, { withFileTypes: true });
  const views: BackgroundJobView[] = [];
  for (const entry of entries.slice(0, 2_000)) {
    if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
    try {
      const definition = await readJsonFile<BackgroundJobDefinition>(
        backgroundJobPaths(config.backgroundJobDir, entry.name).definition
      );
      if (definition.workspaceRoot !== workspace.root) continue;
      const view = await viewFor(config, workspace, definition, 0);
      if (options.includeTerminal === false && view.terminal) continue;
      views.push(view);
    } catch {
      // Ignore malformed job directories in list output; direct lookup still reports the error.
    }
  }
  views.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return views.slice(0, limit);
}

export async function waitForBackgroundJob(
  config: CodexProConfig,
  workspace: Workspace,
  input: { jobId?: string; jobKey?: string; waitMs?: number; tailBytes?: number }
): Promise<BackgroundJobView> {
  const waitMs = Math.max(0, Math.min(input.waitMs ?? 10_000, 60_000));
  const deadline = Date.now() + waitMs;
  let view = await getBackgroundJob(config, workspace, input);
  while (!view.terminal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    view = await getBackgroundJob(config, workspace, input);
  }
  return view;
}

export async function cancelBackgroundJob(
  config: CodexProConfig,
  workspace: Workspace,
  input: { jobId?: string; jobKey?: string; reason?: string; waitMs?: number; tailBytes?: number }
): Promise<BackgroundJobView> {
  const jobId = jobIdFromIdentifier(workspace, input);
  const definition = await readDefinition(config, workspace, jobId);
  const before = await viewFor(config, workspace, definition, input.tailBytes ?? 4_000);
  if (before.terminal) return before;
  if (before.status === "unmonitored") {
    throw new CodexProError(
      "The job child is still alive but its durable runner is unavailable, so CodexPro cannot safely prove process ownership for cancellation. " +
        "Do not assume it stopped; inspect the recorded PID and logs before taking manual action."
    );
  }
  const paths = backgroundJobPaths(config.backgroundJobDir, jobId);
  let request: BackgroundJobCancelRequest;
  try {
    request = await readJsonFile<BackgroundJobCancelRequest>(paths.cancelRequest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    request = {
      version: BACKGROUND_JOB_VERSION,
      jobId,
      requestedAt: new Date().toISOString(),
      ...(input.reason?.trim() ? { reason: input.reason.trim().slice(0, 500) } : {})
    };
    await writeJsonAtomic(paths.cancelRequest, request);
  }
  return waitForBackgroundJob(config, workspace, {
    jobId,
    waitMs: Math.max(0, Math.min(input.waitMs ?? 5_000, 10_000)),
    tailBytes: input.tailBytes
  });
}
