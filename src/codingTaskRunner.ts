#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexAppServerClient } from "./codexAppServerClient.js";
import type { CodexAppServerEvent, CodexPlanSnapshot, CodexTurnResult } from "./codexAppServerTypes.js";
import {
  beginCodingTaskOperation,
  finishCodingTaskOperationFenced,
  heartbeatCodingTaskOperationFenced,
  observeCodingTask,
  readCodingTaskCancellation
} from "./codingTaskOps.js";
import { CodingTaskStore, secureCodingTaskDirectory, writeCodingTaskJsonAtomic, type CodingTaskStoreConfig } from "./codingTaskStore.js";
import { validateCodingTaskId, type CodingTaskLogMetadata, type CodingTaskState } from "./codingTaskState.js";
import { assertCodingTaskWorktree, inspectCodingTaskSource } from "./codingTaskWorktree.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

const RUNNER_PATH = fileURLToPath(new URL("./codingTaskRunner.js", import.meta.url));
const RUN_VERSION = 1 as const;
const HEARTBEAT_MS = 1_000;
const REQUEST_POLL_MS = 250;
const MAX_EVENTS = 200;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

export type CodingTaskRunStatus = "queued" | "running" | "waiting_review" | "completed" | "failed" | "canceled";

export interface CodingTaskRunnerConfig extends CodingTaskStoreConfig {
  codexBinary: string;
  /** Values are filtered through the runner's fixed runtime allowlist. */
  env?: NodeJS.ProcessEnv;
  maxLogBytes?: number;
}

export interface LaunchCodingTaskRunInput {
  operationId: string;
  prompt: string;
  expectedRevision: number;
  executorEpoch: number;
  leaseId: string;
  threadId?: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface CodingTaskRunDefinition {
  version: typeof RUN_VERSION;
  taskId: string;
  operationId: string;
  fingerprint: string;
  prompt: string;
  expectedRevision: number;
  executorEpoch: number;
  leaseId: string;
  worktreeRoot: string;
  codexBinary: string;
  threadId?: string;
  model: string;
  effort: string;
  timeoutMs: number;
  maxLogBytes: number;
  createdAt: string;
}

export interface CodingTaskRunEvent {
  at: string;
  event: CodexAppServerEvent;
}

export interface CodingTaskRunState {
  version: typeof RUN_VERSION;
  taskId: string;
  operationId: string;
  fingerprint: string;
  status: CodingTaskRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  heartbeatAt?: string;
  runnerPid?: number;
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  finalText?: string;
  latestPlan?: CodexPlanSnapshot | null;
  latestDiff?: string;
  warnings?: string[];
  errors?: string[];
  error?: string;
  approvalOrInputDeclined?: boolean;
  truncated?: boolean;
  events: CodingTaskRunEvent[];
}

export interface CodingTaskRunView extends CodingTaskRunState {
  definitionFingerprint: string;
  runnerAlive: boolean;
  reused?: boolean;
}

export interface EnqueueCodingTaskSteerInput {
  operationId: string;
  executorEpoch: number;
  leaseId: string;
  requestKey: string;
  prompt: string;
}

export interface CodingTaskSteerRequest {
  version: typeof RUN_VERSION;
  taskId: string;
  operationId: string;
  executorEpoch: number;
  leaseId: string;
  requestKey: string;
  fingerprint: string;
  prompt: string;
  requestedAt: string;
}

export interface CodingTaskSteerAck {
  version: typeof RUN_VERSION;
  taskId: string;
  operationId: string;
  requestKey: string;
  fingerprint: string;
  status: "queued" | "delivered" | "failed";
  requestedAt: string;
  acknowledgedAt?: string;
  turnId?: string;
  error?: string;
  reused?: boolean;
}

export interface SubmitCodingTaskFollowupInput {
  requestKey: string;
  prompt: string;
  expectedRevision?: number;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface CodingTaskFollowupDecision {
  version: typeof RUN_VERSION;
  taskId: string;
  requestKey: string;
  fingerprint: string;
  mode: "steer" | "run";
  operationId: string;
  executorEpoch: number;
  leaseId: string;
  expectedRevision: number;
  prompt: string;
  model: string;
  effort: string;
  timeoutMs: number;
  createdAt: string;
}

export type CodingTaskFollowupResult =
  | { mode: "steer"; decision: CodingTaskFollowupDecision; steer: CodingTaskSteerAck; reused: boolean }
  | { mode: "run"; decision: CodingTaskFollowupDecision; run: CodingTaskRunView; reused: boolean };

interface RunPaths {
  runDir: string;
  definition: string;
  state: string;
  runnerLock: string;
  steerInbox: string;
  steerAcks: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(value: string, maxBytes: number): string {
  const safe = redactSensitiveText(value);
  const bytes = Buffer.from(safe, "utf8");
  return bytes.byteLength <= maxBytes ? safe : bytes.subarray(0, maxBytes).toString("utf8");
}

function sanitizedRuntimeEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = { ...process.env, ...overrides };
  const allowed = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP", "USER", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "CI",
    "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) result[key] = source[key];
  const explicit = ["CODEX_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "no_proxy"];
  for (const key of explicit) if (overrides?.[key] !== undefined) result[key] = overrides[key];
  result.NO_COLOR = "1";
  return result;
}

function boundedEvent(event: CodexAppServerEvent): CodexAppServerEvent {
  const safe = redactStructured(event) as CodexAppServerEvent;
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") <= MAX_EVENT_BYTES) return safe;
  return { type: "warning", message: bounded(`Codex event ${safe.type} exceeded the persisted event size limit.`, MAX_EVENT_BYTES) };
}

function validateOperationId(value: string): string {
  const normalized = value.trim();
  if (!OPERATION_PATTERN.test(normalized)) throw new Error("operationId must be 1-160 safe characters.");
  return normalized;
}

function validateRequestKey(value: string): string {
  const normalized = value.trim();
  if (!REQUEST_KEY_PATTERN.test(normalized)) throw new Error("requestKey must be 1-160 safe characters.");
  return normalized;
}

function operationToken(operationId: string): string {
  return `run_${sha256(operationId).slice(0, 32)}`;
}

function runPaths(store: CodingTaskStore, taskId: string, operationId: string): RunPaths {
  const task = store.paths(taskId);
  const runDir = path.join(task.taskDir, "runs", operationToken(validateOperationId(operationId)));
  return {
    runDir,
    definition: path.join(runDir, "definition.json"),
    state: path.join(runDir, "state.json"),
    runnerLock: path.join(runDir, "runner.lock"),
    steerInbox: path.join(runDir, "steer", "inbox"),
    steerAcks: path.join(runDir, "steer", "acks")
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await secureCodingTaskDirectory(directory, "Coding task runner state directory");
}

function processAlive(pid?: number): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireRunLock(paths: RunPaths): Promise<fsp.FileHandle | undefined> {
  try {
    const handle = await fsp.open(paths.runnerLock, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number.parseInt(await fsp.readFile(paths.runnerLock, "utf8").catch(() => "0"), 10);
    if (processAlive(pid)) return undefined;
    await fsp.rename(paths.runnerLock, `${paths.runnerLock}.stale.${Date.now()}.${randomUUID()}`).catch((renameError) => {
      if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
    });
    try {
      const handle = await fsp.open(paths.runnerLock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw retryError;
    }
  }
}

function assertDefinition(definition: CodingTaskRunDefinition, definitionPath: string, dataRoot: string): void {
  const taskId = validateCodingTaskId(definition.taskId);
  const operationId = validateOperationId(definition.operationId);
  const store = new CodingTaskStore({ dataRoot });
  const expected = runPaths(store, taskId, operationId).definition;
  if (definition.version !== RUN_VERSION || path.resolve(definitionPath) !== path.resolve(expected)) {
    throw new Error("Coding task run definition identity mismatch.");
  }
  if (!/^[0-9a-f]{64}$/.test(definition.fingerprint)) throw new Error("Invalid run fingerprint.");
  if (!Number.isSafeInteger(definition.expectedRevision) || definition.expectedRevision < 1) throw new Error("Invalid expected revision.");
  if (!Number.isSafeInteger(definition.executorEpoch) || definition.executorEpoch < 1) throw new Error("Invalid executor epoch.");
  if (!path.isAbsolute(definition.worktreeRoot) || !definition.codexBinary.trim()) throw new Error("Invalid runner paths.");
  if (Buffer.byteLength(definition.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Run prompt exceeds the size limit.");
}

function definitionFingerprint(task: CodingTaskState, input: Required<Omit<LaunchCodingTaskRunInput, "threadId">> & { threadId?: string }): string {
  return sha256(JSON.stringify({
    schema: "codexpro-coding-task-run-v1",
    taskId: task.taskId,
    operationId: input.operationId,
    prompt: input.prompt,
    revision: input.expectedRevision,
    epoch: input.executorEpoch,
    leaseId: input.leaseId,
    threadId: input.threadId ?? null,
    model: input.model,
    effort: input.effort,
    timeoutMs: input.timeoutMs,
    worktreeRoot: task.worktreeRoot
  }));
}

export async function launchCodingTaskRun(
  config: CodingTaskRunnerConfig,
  taskIdInput: string,
  input: LaunchCodingTaskRunInput
): Promise<CodingTaskRunView> {
  const taskId = validateCodingTaskId(taskIdInput);
  const operationId = validateOperationId(input.operationId);
  const rawPrompt = input.prompt.trim();
  if (!rawPrompt || Buffer.byteLength(rawPrompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("prompt must be 1-262144 UTF-8 bytes.");
  const prompt = bounded(rawPrompt, MAX_PROMPT_BYTES);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, taskId, operationId);
  const existing = await readJson<CodingTaskRunDefinition>(paths.definition).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    const sameSemanticContract = existing.prompt === prompt && existing.executorEpoch === input.executorEpoch &&
      existing.leaseId === input.leaseId && existing.model === (input.model?.trim() || "gpt-5.6-sol") &&
      existing.effort === (input.effort?.trim() || "high") &&
      existing.timeoutMs === Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000));
    if (!sameSemanticContract) throw new Error("operationId is already bound to a different Codex run contract.");
    const view = await reconcileCodingTaskRun(config, taskId, operationId, { relaunchQueued: true });
    return { ...view, reused: true };
  }
  const task = await store.get(taskId);
  if (task.executor !== "codex") throw new Error("Coding task is not owned by Codex.");
  if (task.executorLease.epoch !== input.executorEpoch || task.executorLease.leaseId !== input.leaseId) {
    throw new Error("Coding task executor lease changed.");
  }
  if (task.revision !== input.expectedRevision) throw new Error(`Coding task CAS conflict: observed revision ${task.revision}.`);
  if (task.activeOperation && task.activeOperation.operationId !== operationId) throw new Error("Coding task already has an active operation.");
  await assertTaskWorktreeIdentity(store, task);
  const normalized = {
    ...input,
    operationId,
    prompt,
    threadId: input.threadId?.trim() || task.codexThreadId,
    model: input.model?.trim() || "gpt-5.6-sol",
    effort: input.effort?.trim() || "high",
    timeoutMs: Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000))
  } as Required<Omit<LaunchCodingTaskRunInput, "threadId">> & { threadId?: string };
  const fingerprint = definitionFingerprint(task, normalized);
  const definition: CodingTaskRunDefinition = {
    version: RUN_VERSION,
    taskId,
    operationId,
    fingerprint,
    prompt,
    expectedRevision: input.expectedRevision,
    executorEpoch: input.executorEpoch,
    leaseId: input.leaseId,
    worktreeRoot: task.worktreeRoot,
    codexBinary: config.codexBinary,
    ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
    model: normalized.model,
    effort: normalized.effort,
    timeoutMs: normalized.timeoutMs,
    maxLogBytes: Math.max(64 * 1024, Math.min(config.maxLogBytes ?? 2 * 1024 * 1024, 64 * 1024 * 1024)),
    createdAt: new Date().toISOString()
  };
  await ensurePrivateDirectory(path.dirname(paths.runDir));
  try {
    await fsp.mkdir(paths.runDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let raced: CodingTaskRunDefinition | undefined;
    for (let attempt = 0; attempt < 30 && !raced; attempt += 1) {
      raced = await readJson<CodingTaskRunDefinition>(paths.definition).catch(() => undefined);
      if (!raced) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!raced) throw new Error("Concurrent Codex run creation did not publish its definition.");
    if (raced.fingerprint !== fingerprint) throw new Error("operationId is already bound to a different Codex run contract.");
    return { ...(await getCodingTaskRun(config, taskId, operationId)), reused: true };
  }
  await ensurePrivateDirectory(paths.runDir);
  await writeCodingTaskJsonAtomic(paths.definition, definition);
  await writeCodingTaskJsonAtomic(paths.state, {
    version: RUN_VERSION, taskId, operationId, fingerprint, status: "queued",
    createdAt: definition.createdAt, updatedAt: definition.createdAt, events: []
  } satisfies CodingTaskRunState);
  try {
    await spawnDetachedRunner(config, definition, paths, task.worktreeRoot);
  } catch (error) {
    const now = new Date().toISOString();
    await writeCodingTaskJsonAtomic(paths.state, {
      version: RUN_VERSION, taskId, operationId, fingerprint, status: "failed",
      createdAt: definition.createdAt, updatedAt: now, finishedAt: now,
      error: bounded(errorMessage(error), 20_000), events: []
    } satisfies CodingTaskRunState);
    throw error;
  }
  return waitForCodingTaskRun(config, taskId, operationId, { timeoutMs: 1_500, terminal: false });
}

async function spawnDetachedRunner(
  config: CodingTaskRunnerConfig,
  definition: CodingTaskRunDefinition,
  paths: RunPaths,
  worktreeRoot: string
): Promise<void> {
  const runner = spawn(process.execPath, [RUNNER_PATH, paths.definition, path.resolve(config.dataRoot)], {
    cwd: worktreeRoot, env: sanitizedRuntimeEnv(config.env), shell: false, stdio: "ignore", detached: true, windowsHide: true
  });
  await new Promise<void>((resolve, reject) => { runner.once("spawn", resolve); runner.once("error", reject); });
  runner.unref();
}

export async function reconcileCodingTaskRun(
  config: CodingTaskStoreConfig & Partial<Pick<CodingTaskRunnerConfig, "codexBinary" | "env" | "maxLogBytes">>,
  taskIdInput: string,
  operationIdInput: string,
  options: { staleMs?: number; relaunchQueued?: boolean } = {}
): Promise<CodingTaskRunView> {
  const taskId = validateCodingTaskId(taskIdInput);
  const operationId = validateOperationId(operationIdInput);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, taskId, operationId);
  const definition = await readJson<CodingTaskRunDefinition>(paths.definition);
  assertDefinition(definition, paths.definition, store.dataRoot);
  let view = await getCodingTaskRun(config, taskId, operationId);
  if (!["queued", "running"].includes(view.status) || view.runnerAlive) return view;
  const task = await store.get(taskId);
  if (view.status === "queued") {
    const persistedCancel = task.activeOperation?.operationId === operationId
      ? await readCodingTaskCancellation(config, taskId, {
          operationId, executorEpoch: definition.executorEpoch
        })
      : undefined;
    if (persistedCancel && !view.runnerAlive) {
      const lock = await acquireRunLock(paths);
      if (!lock) return view;
      try {
        const gitObservation = await observeCodingTask(config, taskId, {
          executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
          operationId, maxGitOutputBytes: definition.maxLogBytes
        });
        const finished = await finishCodingTaskOperationFenced(config, taskId, {
          executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
          operationId, lifecycle: "canceled", error: persistedCancel.reason, gitObservation
        });
        const now = finished.finishedAt ?? new Date().toISOString();
        await writeCodingTaskJsonAtomic(paths.state, compactRunState({
          version: RUN_VERSION, taskId, operationId, fingerprint: definition.fingerprint, status: "canceled",
          createdAt: view.createdAt, updatedAt: now, finishedAt: now, events: view.events
        }, definition.maxLogBytes));
        return getCodingTaskRun(config, taskId, operationId);
      } finally {
        await lock.close().catch(() => undefined);
        await fsp.unlink(paths.runnerLock).catch(() => undefined);
      }
    }
    if (options.relaunchQueued !== true) return view;
    if (!config.codexBinary?.trim()) throw new Error("codexBinary is required when queued-run relaunch is authorized.");
    if (task.executor !== "codex" || task.executorLease.epoch !== definition.executorEpoch ||
        task.executorLease.leaseId !== definition.leaseId || task.revision !== definition.expectedRevision || task.activeOperation) {
      throw new Error("Queued Codex run cannot be relaunched because its immutable task lease changed.");
    }
    await assertTaskWorktreeIdentity(store, task);
    if (definition.worktreeRoot !== task.worktreeRoot || definition.codexBinary !== config.codexBinary) {
      throw new Error("Queued Codex run definition no longer matches the configured runner identity.");
    }
    await spawnDetachedRunner(config as CodingTaskRunnerConfig, definition, paths, task.worktreeRoot);
    return waitForCodingTaskRun(config, taskId, operationId, { timeoutMs: 1_500, terminal: false });
  }
  const staleMs = Math.max(0, Math.min(options.staleMs ?? 5_000, 10 * 60_000));
  if (Date.now() - Date.parse(view.heartbeatAt ?? view.updatedAt) <= staleMs) return view;
  if (task.executor !== "codex" || task.executorLease.epoch !== definition.executorEpoch ||
      task.executorLease.leaseId !== definition.leaseId || task.activeOperation?.operationId !== operationId) {
    throw new Error("Dead Codex run diverged from the authoritative CodingTask lease; refusing run-only reconciliation.");
  }
  const error = "Detached Codex runner stopped without recording a terminal result.";
  const gitObservation = await observeCodingTask(config, taskId, {
    executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
    operationId, maxGitOutputBytes: definition.maxLogBytes
  });
  const finishedTask = await finishCodingTaskOperationFenced(config, taskId, {
    executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
    operationId, lifecycle: "failed", error, gitObservation,
    codexThreadId: view.threadId, codexSessionId: view.sessionId, codexTurnId: view.turnId
  });
  const now = finishedTask.finishedAt ?? new Date().toISOString();
  const state: CodingTaskRunState = { ...view, status: finishedTask.lifecycle === "canceled" ? "canceled" : "failed",
    updatedAt: now, finishedAt: now, error: finishedTask.lifecycle === "canceled" ? undefined : error,
    events: view.events, runnerPid: view.runnerPid };
  delete (state as Partial<CodingTaskRunView>).definitionFingerprint;
  delete (state as Partial<CodingTaskRunView>).runnerAlive;
  delete (state as Partial<CodingTaskRunView>).reused;
  await writeCodingTaskJsonAtomic(paths.state, compactRunState(state, definition.maxLogBytes));
  return getCodingTaskRun(config, taskId, operationId);
}

export async function cancelQueuedCodingTaskRun(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  operationIdInput: string,
  reason?: string
): Promise<CodingTaskRunView> {
  const taskId = validateCodingTaskId(taskIdInput);
  const operationId = validateOperationId(operationIdInput);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, taskId, operationId);
  const definition = await readJson<CodingTaskRunDefinition>(paths.definition);
  assertDefinition(definition, paths.definition, store.dataRoot);
  const view = await getCodingTaskRun(config, taskId, operationId);
  if (view.status === "canceled") return { ...view, reused: true };
  if (view.status !== "queued") throw new Error(`Only a queued Codex run can use queued cancellation; observed ${view.status}.`);
  if (view.runnerAlive) throw new Error("Queued Codex run runner is alive; use active cancellation instead.");
  const lock = await acquireRunLock(paths);
  if (!lock) throw new Error("Queued Codex run became active; use active cancellation instead.");
  try {
    return await store.withTaskLock(taskId, async () => {
      const currentView = await getCodingTaskRun(config, taskId, operationId);
      if (currentView.status === "canceled") return { ...currentView, reused: true };
      if (currentView.status !== "queued" || currentView.runnerAlive) throw new Error("Queued Codex run is no longer safely cancelable.");
      const task = await store.get(taskId);
      if (task.executor !== "codex" || task.executorLease.epoch !== definition.executorEpoch ||
          task.executorLease.leaseId !== definition.leaseId || task.revision !== definition.expectedRevision || task.activeOperation) {
        throw new Error("Queued Codex run cancellation identity diverged from the authoritative CodingTask lease.");
      }
      await assertTaskWorktreeIdentity(store, task);
      if (definition.worktreeRoot !== task.worktreeRoot) {
        throw new Error("Queued Codex run cancellation definition no longer matches the task worktree identity.");
      }
      const now = new Date().toISOString();
      const canceled: CodingTaskRunState = {
        version: RUN_VERSION, taskId, operationId, fingerprint: definition.fingerprint, status: "canceled",
        createdAt: currentView.createdAt, updatedAt: now, finishedAt: now,
        ...(reason?.trim() ? { error: bounded(`Canceled before launch: ${reason.trim()}`, 20_000) } : {}),
        events: currentView.events
      };
      await writeCodingTaskJsonAtomic(paths.state, compactRunState(canceled, definition.maxLogBytes));
      return getCodingTaskRun(config, taskId, operationId);
    });
  } finally {
    await lock.close().catch(() => undefined);
    await fsp.unlink(paths.runnerLock).catch(() => undefined);
  }
}

export async function getCodingTaskRun(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  operationId: string
): Promise<CodingTaskRunView> {
  const taskId = validateCodingTaskId(taskIdInput);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, taskId, operationId);
  const [definition, state] = await Promise.all([
    readJson<CodingTaskRunDefinition>(paths.definition),
    readJson<CodingTaskRunState>(paths.state)
  ]);
  assertDefinition(definition, paths.definition, store.dataRoot);
  if (state.taskId !== taskId || state.operationId !== definition.operationId || state.fingerprint !== definition.fingerprint) {
    throw new Error("Coding task run state identity mismatch.");
  }
  return { ...state, definitionFingerprint: definition.fingerprint, runnerAlive: processAlive(state.runnerPid) };
}

export async function getLatestCodingTaskRun(
  config: CodingTaskStoreConfig,
  taskIdInput: string
): Promise<CodingTaskRunView | undefined> {
  const taskId = validateCodingTaskId(taskIdInput);
  const store = new CodingTaskStore(config);
  const runsRoot = path.join(store.paths(taskId).taskDir, "runs");
  const entries = await fsp.readdir(runsRoot, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const views: CodingTaskRunView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^run_[0-9a-f]{32}$/.test(entry.name)) continue;
    const definition = await readJson<CodingTaskRunDefinition>(path.join(runsRoot, entry.name, "definition.json")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!definition) continue;
    views.push(await getCodingTaskRun(config, taskId, definition.operationId));
  }
  return views.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function reconcileLatestCodingTaskRun(
  config: CodingTaskStoreConfig & Partial<Pick<CodingTaskRunnerConfig, "codexBinary" | "env" | "maxLogBytes">>,
  taskId: string,
  options: { staleMs?: number; relaunchQueued?: boolean } = {}
): Promise<CodingTaskRunView | undefined> {
  const latest = await getLatestCodingTaskRun(config, taskId);
  if (!latest || !["queued", "running"].includes(latest.status)) return latest;
  return reconcileCodingTaskRun(config, taskId, latest.operationId, options);
}

export async function waitForCodingTaskRun(
  config: CodingTaskStoreConfig,
  taskId: string,
  operationId: string,
  options: { timeoutMs?: number; pollMs?: number; terminal?: boolean } = {}
): Promise<CodingTaskRunView> {
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? 30_000, 10 * 60_000));
  const deadline = Date.now() + timeoutMs;
  let view = await getCodingTaskRun(config, taskId, operationId);
  const done = () => options.terminal === false ? view.status !== "queued" : !["queued", "running"].includes(view.status);
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.min(options.pollMs ?? 100, 2_000))));
    view = await getCodingTaskRun(config, taskId, operationId);
  }
  return view;
}

export async function enqueueCodingTaskSteer(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  input: EnqueueCodingTaskSteerInput
): Promise<CodingTaskSteerAck> {
  const taskId = validateCodingTaskId(taskIdInput);
  const operationId = validateOperationId(input.operationId);
  const requestKey = validateRequestKey(input.requestKey);
  const rawPrompt = input.prompt.trim();
  if (!rawPrompt || Buffer.byteLength(rawPrompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("steer prompt is invalid or too large.");
  const prompt = bounded(rawPrompt, MAX_PROMPT_BYTES);
  const store = new CodingTaskStore(config);
  const task = await store.get(taskId);
  if (task.executor !== "codex" || task.executorLease.epoch !== input.executorEpoch || task.executorLease.leaseId !== input.leaseId ||
      task.activeOperation?.operationId !== operationId || !task.codexTurnActive || task.cancelRequestedAt) {
    throw new Error("Coding task has no matching active Codex turn to steer.");
  }
  const paths = runPaths(store, taskId, operationId);
  const fingerprint = sha256(JSON.stringify({ taskId, operationId, requestKey, prompt, epoch: input.executorEpoch, leaseId: input.leaseId }));
  const token = `steer_${sha256(requestKey).slice(0, 32)}`;
  const requestPath = path.join(paths.steerInbox, `${token}.json`);
  const ackPath = path.join(paths.steerAcks, `${token}.json`);
  const priorAck = await readJson<CodingTaskSteerAck>(ackPath).catch(() => undefined);
  if (priorAck) {
    if (priorAck.fingerprint !== fingerprint) throw new Error("requestKey is already bound to a different steering prompt.");
    return { ...priorAck, reused: true };
  }
  const prior = await readJson<CodingTaskSteerRequest>(requestPath).catch(() => undefined);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error("requestKey is already bound to a different steering prompt.");
    return { version: RUN_VERSION, taskId, operationId, requestKey, fingerprint, status: "queued", requestedAt: prior.requestedAt, reused: true };
  }
  const request: CodingTaskSteerRequest = {
    version: RUN_VERSION, taskId, operationId, executorEpoch: input.executorEpoch, leaseId: input.leaseId,
    requestKey, fingerprint, prompt, requestedAt: new Date().toISOString()
  };
  await ensurePrivateDirectory(paths.steerInbox);
  await ensurePrivateDirectory(paths.steerAcks);
  await writeCodingTaskJsonAtomic(requestPath, request);
  return { version: RUN_VERSION, taskId, operationId, requestKey, fingerprint, status: "queued", requestedAt: request.requestedAt };
}

export async function getCodingTaskSteer(
  config: CodingTaskStoreConfig,
  taskId: string,
  operationId: string,
  requestKey: string
): Promise<CodingTaskSteerAck> {
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, validateCodingTaskId(taskId), validateOperationId(operationId));
  const token = `steer_${sha256(validateRequestKey(requestKey)).slice(0, 32)}`;
  const ack = await readJson<CodingTaskSteerAck>(path.join(paths.steerAcks, `${token}.json`)).catch(() => undefined);
  if (ack) return ack;
  const inbox = path.join(paths.steerInbox, `${token}.json`);
  let request = await readJson<CodingTaskSteerRequest>(inbox).catch(() => undefined);
  if (!request) {
    const claim = (await fsp.readdir(paths.steerInbox).catch(() => []))
      .find((name) => name.startsWith(`${token}.json.`) && name.endsWith(".processing"));
    if (claim) request = await readJson<CodingTaskSteerRequest>(path.join(paths.steerInbox, claim));
  }
  if (!request) {
    const racedAck = await readJson<CodingTaskSteerAck>(path.join(paths.steerAcks, `${token}.json`)).catch(() => undefined);
    if (racedAck) return racedAck;
    throw new Error(`Coding task steer request not found: ${requestKey}`);
  }
  return { version: RUN_VERSION, taskId: request.taskId, operationId: request.operationId, requestKey: request.requestKey,
    fingerprint: request.fingerprint, status: "queued", requestedAt: request.requestedAt };
}

export async function submitCodingTaskFollowup(
  config: CodingTaskRunnerConfig,
  taskIdInput: string,
  input: SubmitCodingTaskFollowupInput
): Promise<CodingTaskFollowupResult> {
  const taskId = validateCodingTaskId(taskIdInput);
  const requestKey = validateRequestKey(input.requestKey);
  const rawPrompt = input.prompt.trim();
  if (!rawPrompt || Buffer.byteLength(rawPrompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("follow-up prompt is required and must fit the size limit.");
  const prompt = bounded(rawPrompt, MAX_PROMPT_BYTES);
  const model = input.model?.trim() || "gpt-5.6-sol";
  const effort = input.effort?.trim() || "high";
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000));
  const fingerprint = sha256(JSON.stringify({ schema: "codexpro-followup-v1", taskId, requestKey, prompt, model, effort, timeoutMs }));
  const store = new CodingTaskStore(config);
  const ledgerDir = path.join(store.paths(taskId).taskDir, "followups", `request_${sha256(requestKey).slice(0, 32)}`);
  const decisionPath = path.join(ledgerDir, "decision.json");
  await ensurePrivateDirectory(path.dirname(ledgerDir));
  await ensurePrivateDirectory(ledgerDir);
  let reused = true;
  let steerPublished: CodingTaskSteerAck | undefined;
  let decision = await readJson<CodingTaskFollowupDecision>(decisionPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!decision) {
    decision = await store.withTaskLock(taskId, async () => {
      const raced = await readJson<CodingTaskFollowupDecision>(decisionPath).catch(() => undefined);
      if (raced) return raced;
      const task = await store.get(taskId);
      if (task.executor !== "codex") throw new Error("Coding task is not owned by Codex.");
      if (task.cancelRequestedAt) throw new Error("Coding task cancellation is pending; follow-up is not accepted.");
      if (input.expectedRevision !== undefined && task.revision !== input.expectedRevision) {
        throw new Error(`Coding task CAS conflict: observed revision ${task.revision}.`);
      }
      const active = task.activeOperation?.executor === "codex" && task.codexTurnActive;
      const created: CodingTaskFollowupDecision = {
        version: RUN_VERSION, taskId, requestKey, fingerprint, mode: active ? "steer" : "run",
        operationId: active ? task.activeOperation!.operationId : `followup:${requestKey}`,
        executorEpoch: task.executorLease.epoch, leaseId: task.executorLease.leaseId,
        expectedRevision: task.revision, prompt, model, effort, timeoutMs, createdAt: new Date().toISOString()
      };
      await writeCodingTaskJsonAtomic(decisionPath, created);
      if (created.mode === "steer") {
        const paths = runPaths(store, taskId, created.operationId);
        await ensurePrivateDirectory(paths.steerInbox);
        await ensurePrivateDirectory(paths.steerAcks);
        const steerFingerprint = sha256(JSON.stringify({
          taskId, operationId: created.operationId, requestKey, prompt,
          epoch: created.executorEpoch, leaseId: created.leaseId
        }));
        const token = `steer_${sha256(requestKey).slice(0, 32)}`;
        const request: CodingTaskSteerRequest = {
          version: RUN_VERSION, taskId, operationId: created.operationId, executorEpoch: created.executorEpoch,
          leaseId: created.leaseId, requestKey, fingerprint: steerFingerprint, prompt, requestedAt: created.createdAt
        };
        await writeCodingTaskJsonAtomic(path.join(paths.steerInbox, `${token}.json`), request);
        steerPublished = { version: RUN_VERSION, taskId, operationId: created.operationId, requestKey,
          fingerprint: steerFingerprint, status: "queued", requestedAt: created.createdAt };
      }
      reused = false;
      return created;
    });
  }
  if (decision.fingerprint !== fingerprint) throw new Error("requestKey is already bound to a different follow-up contract.");
  if (decision.mode === "steer") {
    let steer = steerPublished ?? await getCodingTaskSteer(config, taskId, decision.operationId, requestKey).catch(() => undefined);
    if (!steer) {
      steer = await enqueueCodingTaskSteer(config, taskId, {
        operationId: decision.operationId, executorEpoch: decision.executorEpoch, leaseId: decision.leaseId,
        requestKey, prompt: decision.prompt
      });
    }
    return { mode: "steer", decision, steer, reused };
  }
  const run = await launchCodingTaskRun(config, taskId, {
    operationId: decision.operationId, prompt: decision.prompt, expectedRevision: decision.expectedRevision,
    executorEpoch: decision.executorEpoch, leaseId: decision.leaseId, model: decision.model,
    effort: decision.effort, timeoutMs: decision.timeoutMs
  });
  return { mode: "run", decision, run, reused };
}

async function runDetached(definitionPath: string, dataRoot: string): Promise<void> {
  const definition = await readJson<CodingTaskRunDefinition>(definitionPath);
  assertDefinition(definition, definitionPath, dataRoot);
  const store = new CodingTaskStore({ dataRoot });
  const paths = runPaths(store, definition.taskId, definition.operationId);
  await ensurePrivateDirectory(paths.runDir);
  await ensurePrivateDirectory(paths.steerInbox);
  await ensurePrivateDirectory(paths.steerAcks);
  const runnerLock = await acquireRunLock(paths);
  if (!runnerLock) return;

  let runState = await readJson<CodingTaskRunState>(paths.state);
  if (["waiting_review", "completed", "failed", "canceled"].includes(runState.status)) {
    await runnerLock.close().catch(() => undefined);
    await fsp.unlink(paths.runnerLock).catch(() => undefined);
    return;
  }
  let taskState: CodingTaskState | undefined;
  let client: CodexAppServerClient | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let requestTimer: NodeJS.Timeout | undefined;
  let declined = false;
  let cancelRequested = false;
  let mutationChain: Promise<void> = Promise.resolve();
  let mutationError: Error | undefined;
  let stateWrites: Promise<void> | undefined;
  let stateDirty = false;
  let stateWriteError: Error | undefined;
  let requestPoll: Promise<void> = Promise.resolve();
  const controller = new AbortController();

  const persistRun = async (patch: Partial<CodingTaskRunState> = {}): Promise<void> => {
    runState = { ...runState, ...patch, updatedAt: new Date().toISOString(), events: runState.events.slice(-MAX_EVENTS) };
    runState = compactRunState(structuredClone(runState), definition.maxLogBytes);
    stateDirty = true;
    if (!stateWrites) {
      stateWrites = (async () => {
        while (stateDirty) {
          stateDirty = false;
          await writeCodingTaskJsonAtomic(paths.state, structuredClone(runState));
        }
      })().catch((error) => {
        stateWriteError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
        throw stateWriteError;
      }).finally(() => { stateWrites = undefined; });
    }
    await stateWrites;
    if (stateWriteError) throw stateWriteError;
  };
  const mutateTask = (fn: (current: CodingTaskState) => Promise<CodingTaskState>): void => {
    mutationChain = mutationChain.then(async () => {
      if (mutationError) return;
      if (taskState) taskState = await fn(taskState);
    }).catch((error) => {
      mutationError = error instanceof Error ? error : new Error(String(error));
      controller.abort();
    });
  };
  const heartbeat = (extra: { threadId?: string; sessionId?: string; turnId?: string; eventMessage?: string } = {}): void => {
    mutateTask(() => heartbeatCodingTaskOperationFenced({ dataRoot }, definition.taskId, {
      executor: "codex", executorEpoch: definition.executorEpoch,
      leaseId: definition.leaseId, operationId: definition.operationId, codexRunnerPid: process.pid,
      ...(extra.threadId ? { codexThreadId: extra.threadId } : {}),
      ...(extra.sessionId ? { codexSessionId: extra.sessionId } : {}),
      ...(extra.turnId ? { codexTurnId: extra.turnId } : {}),
      ...(extra.eventMessage ? { event: { kind: "state_updated", executor: "codex", epoch: definition.executorEpoch, message: extra.eventMessage } } : {})
    }));
  };

  const recordEvent = (event: CodexAppServerEvent): void => {
    const safe = boundedEvent(event);
    runState.events = [...runState.events, { at: new Date().toISOString(), event: safe }].slice(-MAX_EVENTS);
    if (event.type === "turn_started") {
      runState.threadId = event.threadId;
      runState.turnId = event.turnId;
      heartbeat({ threadId: event.threadId, sessionId: runState.sessionId, turnId: event.turnId, eventMessage: `Codex turn ${event.turnId} started.` });
    } else if (event.type === "server_request_declined") {
      declined = true;
    }
    void persistRun().catch(() => controller.abort());
  };

  const processSteerRequests = async (): Promise<void> => {
    if (!client || !runState.turnId) return;
    const entries = await fsp.readdir(paths.steerInbox, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^steer_[0-9a-f]{32}\.json(?:\.\d+\.processing)?$/.test(entry.name)) continue;
      const requestPath = path.join(paths.steerInbox, entry.name);
      const claimPath = entry.name.includes(".processing") ? requestPath : `${requestPath}.${process.pid}.processing`;
      if (claimPath !== requestPath) {
        try { await fsp.rename(requestPath, claimPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      const request = await readJson<CodingTaskSteerRequest>(claimPath);
      if (request.taskId !== definition.taskId || request.operationId !== definition.operationId ||
          request.executorEpoch !== definition.executorEpoch || request.leaseId !== definition.leaseId) continue;
      const baseName = entry.name.replace(/\.\d+\.processing$/, "");
      const ackPath = path.join(paths.steerAcks, baseName);
      if (await fsp.stat(ackPath).catch(() => undefined)) { await fsp.unlink(claimPath).catch(() => undefined); continue; }
      let ack: CodingTaskSteerAck;
      try {
        const turnId = await client.steer(request.prompt, request.requestKey);
        ack = { version: RUN_VERSION, taskId: definition.taskId, operationId: definition.operationId,
          requestKey: request.requestKey, fingerprint: request.fingerprint, status: "delivered",
          requestedAt: request.requestedAt, acknowledgedAt: new Date().toISOString(), turnId };
      } catch (error) {
        ack = { version: RUN_VERSION, taskId: definition.taskId, operationId: definition.operationId,
          requestKey: request.requestKey, fingerprint: request.fingerprint, status: "failed",
          requestedAt: request.requestedAt, acknowledgedAt: new Date().toISOString(), error: bounded(errorMessage(error), 20_000) };
      }
      await writeCodingTaskJsonAtomic(ackPath, ack);
      await fsp.unlink(claimPath).catch(() => undefined);
    }
  };

  try {
    const current = await store.get(definition.taskId);
    if (current.worktreeRoot !== definition.worktreeRoot || current.executor !== "codex" ||
        current.executorLease.epoch !== definition.executorEpoch || current.executorLease.leaseId !== definition.leaseId ||
        current.revision !== definition.expectedRevision) throw new Error("Coding task run lease or identity changed before runner start.");
    await assertTaskWorktreeIdentity(store, current);
    const realWorktree = await fsp.realpath(definition.worktreeRoot);
    if (realWorktree !== definition.worktreeRoot) throw new Error("Coding task worktree real path changed.");
    taskState = await beginCodingTaskOperation({ dataRoot }, definition.taskId, {
      expectedRevision: definition.expectedRevision, executor: "codex", executorEpoch: definition.executorEpoch,
      leaseId: definition.leaseId, operationId: definition.operationId, codexRunnerPid: process.pid,
      ...(definition.threadId ? { codexThreadId: definition.threadId } : {})
    });
    const startedAt = new Date().toISOString();
    await persistRun({ status: "running", startedAt, heartbeatAt: startedAt, runnerPid: process.pid });
    client = new CodexAppServerClient({ codexBinary: definition.codexBinary, cwd: definition.worktreeRoot,
      env: sanitizedRuntimeEnv({
        CODEX_HOME: process.env.CODEX_HOME,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        SSL_CERT_DIR: process.env.SSL_CERT_DIR,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy
      }), inheritEnv: false, turnTimeoutMs: definition.timeoutMs, onEvent: recordEvent });
    const identity = await client.startOrResumeThread({ threadId: definition.threadId, model: definition.model,
      effort: definition.effort, approvalPolicy: "never", networkAccess: false });
    runState.threadId = identity.threadId;
    runState.sessionId = identity.sessionId;
    heartbeat({ threadId: identity.threadId, sessionId: identity.sessionId });
    await mutationChain;
    heartbeatTimer = setInterval(() => {
      runState.heartbeatAt = new Date().toISOString();
      heartbeat();
      void persistRun().catch(() => controller.abort());
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();
    requestTimer = setInterval(() => {
      requestPoll = requestPoll.then(async () => {
        const request = await readCodingTaskCancellation({ dataRoot }, definition.taskId, {
        operationId: definition.operationId, executorEpoch: definition.executorEpoch
        });
        if (request) {
          if (!cancelRequested) { cancelRequested = true; controller.abort(); await client?.interrupt(); }
          return;
        }
        await processSteerRequests();
      }).catch(() => controller.abort());
    }, REQUEST_POLL_MS);
    requestTimer.unref();
    const result = await client.runTurn({ prompt: definition.prompt, model: definition.model, effort: definition.effort,
      approvalPolicy: "never", networkAccess: false, timeoutMs: definition.timeoutMs, signal: controller.signal,
      clientUserMessageId: definition.operationId });
    await mutationChain;
    if (mutationError) throw mutationError;
    await finishSuccessfulResult(result);
  } catch (error) {
    await mutationChain.catch(() => undefined);
    const message = bounded(errorMessage(error), 20_000);
    const authoritative = await store.get(definition.taskId).catch(() => undefined);
    if (!authoritative) {
      await persistRun({ status: "running", finishedAt: undefined,
        error: bounded(`${message}\nAuthoritative CodingTask readback pending reconciliation.`, 20_000),
        approvalOrInputDeclined: declined, heartbeatAt: new Date(0).toISOString() });
      return;
    }
    if (authoritative?.activeOperation?.operationId === definition.operationId) {
      try {
        const gitObservation = await observeCodingTask({ dataRoot }, definition.taskId, {
          executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
          operationId: definition.operationId, maxGitOutputBytes: definition.maxLogBytes
        });
        taskState = await finishCodingTaskOperationFenced({ dataRoot }, definition.taskId, {
          executor: "codex", executorEpoch: definition.executorEpoch,
          leaseId: definition.leaseId, operationId: definition.operationId,
          lifecycle: cancelRequested ? "canceled" : "failed", error: message, gitObservation,
          codexThreadId: runState.threadId, codexSessionId: runState.sessionId, codexTurnId: runState.turnId,
          logs: [runLogMetadata(paths, runState)]
        });
      } catch (finishError) {
        await persistRun({ status: "running", finishedAt: undefined,
          error: bounded(`${message}\nTerminal writeback pending reconciliation: ${errorMessage(finishError)}`, 20_000),
          approvalOrInputDeclined: declined, heartbeatAt: new Date(0).toISOString() });
        return;
      }
    } else if (
      authoritative.lastCompletedOperation?.operationId === definition.operationId &&
      authoritative.lastCompletedOperation.executorEpoch === definition.executorEpoch
    ) {
      taskState = authoritative;
    } else {
      await persistRun({ status: "running", finishedAt: undefined,
        error: bounded(`${message}\nCodingTask ownership diverged; terminal reconciliation is required.`, 20_000),
        approvalOrInputDeclined: declined, heartbeatAt: new Date(0).toISOString() });
      return;
    }
    const now = taskState?.finishedAt ?? new Date().toISOString();
    const status: CodingTaskRunStatus = taskState?.lifecycle === "canceled" || cancelRequested ? "canceled" : "failed";
    await persistRun({ status, finishedAt: now, error: status === "failed" ? message : undefined,
      approvalOrInputDeclined: declined });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (requestTimer) clearInterval(requestTimer);
    await client?.close().catch(() => undefined);
    await stateWrites?.catch(() => undefined);
    await runnerLock.close().catch(() => undefined);
    await fsp.unlink(paths.runnerLock).catch(() => undefined);
  }

  async function finishSuccessfulResult(result: CodexTurnResult): Promise<void> {
    const failed = declined || result.status === "failed" || result.timedOut;
    const canceled = cancelRequested || (result.status === "interrupted" && result.aborted);
    const status: CodingTaskRunStatus = canceled ? "canceled" : failed || result.status === "interrupted" ? "failed" : "waiting_review";
    const now = new Date().toISOString();
    const finalText = bounded(result.finalText, Math.min(MAX_RESULT_BYTES, definition.maxLogBytes));
    const latestDiff = bounded(result.latestDiff, Math.min(MAX_RESULT_BYTES, definition.maxLogBytes));
    const gitObservation = await observeCodingTask({ dataRoot }, definition.taskId, {
      executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
      operationId: definition.operationId, maxGitOutputBytes: definition.maxLogBytes
    });
    await persistRun({ status, finishedAt: now, heartbeatAt: now, threadId: result.threadId,
      sessionId: result.sessionId, turnId: result.turnId, finalText, latestPlan: result.latestPlan,
      latestDiff, warnings: result.warnings.slice(-100), errors: result.errors.slice(-100),
      approvalOrInputDeclined: declined,
      ...(status === "failed" ? { error: bounded(result.errors.join("\n") || "Codex turn failed or was interrupted.", 20_000) } : {}) });
    if (!taskState) throw new Error("Coding task state was unavailable at completion.");
    taskState = await finishCodingTaskOperationFenced({ dataRoot }, definition.taskId, {
      executor: "codex", executorEpoch: definition.executorEpoch,
      leaseId: definition.leaseId, operationId: definition.operationId,
      lifecycle: status === "waiting_review" ? "waiting_review" : status === "canceled" ? "canceled" : "failed",
      resultSummary: finalText.slice(0, 20_000), error: status === "failed" ? runState.error : undefined,
      codexThreadId: result.threadId, codexSessionId: result.sessionId, codexTurnId: result.turnId,
      gitObservation,
      logs: [runLogMetadata(paths, runState)]
    });
    if (taskState.lifecycle === "canceled" && runState.status !== "canceled") {
      cancelRequested = true;
      await persistRun({ status: "canceled", finishedAt: taskState.finishedAt ?? new Date().toISOString(),
        error: undefined });
    }
  }
}

async function assertTaskWorktreeIdentity(store: CodingTaskStore, task: CodingTaskState): Promise<void> {
  if (task.worktreeRoot !== store.paths(task.taskId).worktreeRoot) throw new Error("Coding task worktree path is not deterministic.");
  const stat = await fsp.lstat(task.worktreeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Coding task worktree must be a real directory.");
  const identity = await inspectCodingTaskSource({ root: task.sourceRoot }, task.baseSha);
  if (identity.commonDir !== task.sourceGitCommonDir) throw new Error("Coding task Git common-directory identity changed.");
  await assertCodingTaskWorktree(identity, task.worktreeRoot);
}

function compactRunState(state: CodingTaskRunState, maxBytes: number): CodingTaskRunState {
  const limit = Math.max(64 * 1024, maxBytes);
  let candidate = state;
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(candidate), "utf8") > limit && candidate.events.length) {
    candidate = { ...candidate, events: candidate.events.slice(Math.max(1, Math.floor(candidate.events.length / 4))) };
    truncated = true;
  }
  const fieldLimit = Math.max(4_096, Math.floor(limit / 4));
  candidate = {
    ...candidate,
    finalText: candidate.finalText ? bounded(candidate.finalText, fieldLimit) : undefined,
    latestDiff: candidate.latestDiff ? bounded(candidate.latestDiff, fieldLimit) : undefined,
    warnings: candidate.warnings?.slice(-50).map((value) => bounded(value, 4_096)),
    errors: candidate.errors?.slice(-50).map((value) => bounded(value, 4_096)),
    error: candidate.error ? bounded(candidate.error, 20_000) : undefined,
    truncated: candidate.truncated || truncated
  };
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > limit) {
    candidate = { ...candidate, latestPlan: undefined, events: [], warnings: candidate.warnings?.slice(-10), errors: candidate.errors?.slice(-10), truncated: true };
  }
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > limit) {
    candidate = { ...candidate, finalText: candidate.finalText ? bounded(candidate.finalText, 4_096) : undefined,
      latestDiff: candidate.latestDiff ? bounded(candidate.latestDiff, 4_096) : undefined, warnings: [], errors: [], truncated: true };
  }
  return candidate;
}

function runLogMetadata(paths: RunPaths, state: CodingTaskRunState): CodingTaskLogMetadata {
  return { name: `codex-run-${sha256(state.operationId).slice(0, 32)}`, relativePath: path.relative(path.dirname(path.dirname(paths.runDir)), paths.state),
    bytes: Buffer.byteLength(JSON.stringify(state), "utf8"), truncated: Boolean(state.truncated), updatedAt: state.updatedAt };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main(): Promise<void> {
  const definitionPath = process.argv[2];
  const dataRoot = process.argv[3];
  if (!definitionPath || !dataRoot || !path.isAbsolute(dataRoot)) throw new Error("Usage: codingTaskRunner <definition.json> <data-root>");
  await runDetached(path.resolve(definitionPath), path.resolve(dataRoot));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}

export { runDetached as runCodingTaskRunner };
