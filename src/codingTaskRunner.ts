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
  expectedSessionId?: string;
  continuationFingerprint?: string;
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
  expectedSessionId?: string;
  continuationFingerprint?: string;
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
  runnerNonce?: string;
  runnerStartedAt?: string;
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

interface QueuedRunCancellation {
  version: typeof RUN_VERSION;
  taskId: string;
  operationId: string;
  fingerprint: string;
  executorEpoch: number;
  leaseId: string;
  requestedAt: string;
  reason?: string;
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

export interface SubmitCodingTaskContinuationInput {
  requestKey: string;
  operationId: string;
  turnOrdinal: number;
  previousOperationId: string;
  prompt: string;
  expectedRevision: number;
  executorEpoch: number;
  leaseId: string;
  expectedThreadId: string;
  expectedSessionId: string;
  expectedPreviousTurnId: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface CodingTaskContinuationDecision {
  version: typeof RUN_VERSION;
  taskId: string;
  requestKey: string;
  fingerprint: string;
  operationId: string;
  turnOrdinal: number;
  previousOperationId: string;
  expectedRevision: number;
  executorEpoch: number;
  leaseId: string;
  expectedThreadId: string;
  expectedSessionId: string;
  expectedPreviousTurnId: string;
  prompt: string;
  model: string;
  effort: string;
  timeoutMs: number;
  createdAt: string;
}

export interface CodingTaskContinuationResult {
  decision: CodingTaskContinuationDecision;
  run: CodingTaskRunView;
  reused: boolean;
}

export interface CodingTaskContinuationView {
  decision: CodingTaskContinuationDecision;
  run?: CodingTaskRunView;
}

interface RunPaths {
  runDir: string;
  definition: string;
  state: string;
  runnerLock: string;
  runnerGuard: string;
  queuedCancel: string;
  steerInbox: string;
  steerAcks: string;
}

interface RunLockRecord {
  version: typeof RUN_VERSION;
  role: "runner" | "reconcile";
  taskId: string;
  operationId: string;
  fingerprint: string;
  pid: number;
  nonce: string;
  processStartedAt: string;
  acquiredAt: string;
  heartbeatAt: string;
}

interface RunLockLease {
  child: ReturnType<typeof spawn>;
  record: RunLockRecord;
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
  for (const key of allowed) {
    const sourceKey = Object.keys(source).find((candidate) => candidate.toUpperCase() === key);
    if (sourceKey && source[sourceKey] !== undefined) result[key] = source[sourceKey];
  }
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
    runnerGuard: path.join(runDir, "runner.lock.guard"),
    queuedCancel: path.join(runDir, "queued-cancel.json"),
    steerInbox: path.join(runDir, "steer", "inbox"),
    steerAcks: path.join(runDir, "steer", "acks")
  };
}

function isAtomicTempFor(entry: string, canonicalName: string): boolean {
  const escaped = canonicalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.\\d+\\.[0-9a-f-]{16,64}\\.tmp$`, "i").test(entry);
}

async function cleanPublicationTemps(
  paths: RunPaths,
  options: { definitionExists: boolean; stateExists: boolean }
): Promise<string[]> {
  const entries = await fsp.readdir(paths.runDir);
  for (const entry of entries) {
    const staleDefinitionTemp = !options.definitionExists && isAtomicTempFor(entry, path.basename(paths.definition));
    const staleStateTemp = options.definitionExists && !options.stateExists && isAtomicTempFor(entry, path.basename(paths.state));
    if (staleDefinitionTemp || staleStateTemp) await fsp.unlink(path.join(paths.runDir, entry));
  }
  return fsp.readdir(paths.runDir);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
}

async function readQueuedRunCancellation(
  paths: RunPaths,
  definition: CodingTaskRunDefinition
): Promise<QueuedRunCancellation | undefined> {
  const request = await readJson<QueuedRunCancellation>(paths.queuedCancel).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!request) return undefined;
  if (request.version !== RUN_VERSION || request.taskId !== definition.taskId ||
      request.operationId !== definition.operationId || request.fingerprint !== definition.fingerprint ||
      request.executorEpoch !== definition.executorEpoch || request.leaseId !== definition.leaseId ||
      !Number.isFinite(Date.parse(request.requestedAt))) {
    throw new Error("Queued Codex cancellation identity mismatch.");
  }
  return request;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await secureCodingTaskDirectory(directory, "Coding task runner state directory");
}

type RunLockIdentity = Pick<CodingTaskRunDefinition, "taskId" | "operationId" | "fingerprint">;

function validRunLockRecord(value: unknown, definition: RunLockIdentity): value is RunLockRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunLockRecord>;
  return record.version === RUN_VERSION && (record.role === "runner" || record.role === "reconcile") &&
    record.taskId === definition.taskId && record.operationId === definition.operationId &&
    record.fingerprint === definition.fingerprint && Number.isSafeInteger(record.pid) && record.pid! > 0 &&
    typeof record.nonce === "string" && /^[0-9a-f-]{16,64}$/i.test(record.nonce) &&
    typeof record.processStartedAt === "string" && Number.isFinite(Date.parse(record.processStartedAt)) &&
    typeof record.acquiredAt === "string" && Number.isFinite(Date.parse(record.acquiredAt)) &&
    typeof record.heartbeatAt === "string" && Number.isFinite(Date.parse(record.heartbeatAt));
}

async function readRunLock(paths: RunPaths, definition: RunLockIdentity): Promise<RunLockRecord | undefined> {
  try {
    const value = await readJson<unknown>(paths.runnerLock);
    return validRunLockRecord(value, definition) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeRunLockRecord(paths: RunPaths, lease: RunLockLease): Promise<void> {
  await writeCodingTaskJsonAtomic(paths.runnerLock, lease.record);
}

async function acquireRunLock(
  paths: RunPaths,
  definition: CodingTaskRunDefinition,
  role: RunLockRecord["role"]
): Promise<RunLockLease | undefined> {
  const now = new Date().toISOString();
  const record: RunLockRecord = {
    version: RUN_VERSION, role, taskId: definition.taskId, operationId: definition.operationId,
    fingerprint: definition.fingerprint, pid: process.pid, nonce: randomUUID(),
    processStartedAt: now, acquiredAt: now, heartbeatAt: now
  };
  let executable: string;
  let args: string[];
  let env = sanitizedRuntimeEnv();
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    executable = systemRoot
      ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const script = [
      "$ErrorActionPreference='Stop'",
      "try {$s=[IO.File]::Open($env:CODEXPRO_RUN_LOCK_PATH,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} catch [IO.IOException] {exit 75}",
      "try {$o=[Console]::OpenStandardOutput();[byte[]]$r=76,79,67,75,69,68,10;$o.Write($r,0,$r.Length);$o.Flush();while($null -ne [Console]::In.ReadLine()) {}} finally {$s.Dispose()}"
    ].join(";");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    env = { ...env, CODEXPRO_RUN_LOCK_PATH: paths.runnerGuard };
  } else {
    await fsp.open(paths.runnerGuard, "a", 0o600).then((handle) => handle.close());
    executable = process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
    const helper = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
    args = process.platform === "darwin"
      ? ["-t", "0", paths.runnerGuard, process.execPath, "-e", helper]
      : ["-n", paths.runnerGuard, process.execPath, "-e", helper];
  }
  const child = spawn(executable, args, {
    env, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true
  });
  let output = "";
  let stderr = "";
  const acquired = await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); reject(new Error("Timed out probing the Codex run advisory lock.")); },
      process.platform === "win32" ? 5_000 : 2_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("LOCKED\n")) finish(true);
    });
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Could not start Codex advisory lock helper: ${error.message}`)); });
    child.once("exit", (code, signal) => {
      if (output.includes("LOCKED\n")) return finish(true);
      if (code === 75 || (process.platform !== "win32" && code === 1)) return finish(false);
      clearTimeout(timer);
      reject(new Error(`Codex advisory lock helper failed (${code ?? signal}): ${stderr.trim()}`));
    });
  });
  if (!acquired) return undefined;
  const lease: RunLockLease = { child, record };
  try {
    await writeRunLockRecord(paths, lease);
  } catch (error) {
    child.stdin?.end();
    child.kill();
    throw error;
  }
  return lease;
}

async function acquireRunnerLockAfterHandoff(
  paths: RunPaths,
  definition: CodingTaskRunDefinition
): Promise<RunLockLease | undefined> {
  const smokeTimeout = process.env.CODEXPRO_RUNNER_SMOKE === "1"
    ? Number.parseInt(process.env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS ?? "10000", 10) : 10_000;
  const timeoutMs = Number.isSafeInteger(smokeTimeout) ? Math.max(100, Math.min(smokeTimeout, 10_000)) : 10_000;
  const deadline = Date.now() + timeoutMs;
  do {
    const lease = await acquireRunLock(paths, definition, "runner");
    if (lease) return lease;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return undefined;
}

/** Test-only lock barrier used by the runner smoke to force a child/reconciler handoff collision. */
export async function holdCodingTaskRunLockForTest(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  operationIdInput: string,
  holdMs: number
): Promise<void> {
  if (process.env.CODEXPRO_RUNNER_SMOKE !== "1") throw new Error("Run lock barrier is available only to the runner smoke.");
  const taskId = validateCodingTaskId(taskIdInput);
  const operationId = validateOperationId(operationIdInput);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, taskId, operationId);
  const definition = await readJson<CodingTaskRunDefinition>(paths.definition);
  assertDefinition(definition, paths.definition, store.dataRoot);
  let lease: RunLockLease | undefined;
  const deadline = Date.now() + 5_000;
  while (!lease && Date.now() < deadline) {
    lease = await acquireRunLock(paths, definition, "reconcile");
    if (!lease) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!lease) throw new Error("Run lock barrier could not acquire the test lock.");
  try { await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(holdMs, 2_000)))); }
  finally { await releaseRunLock(paths, lease); }
}

async function refreshRunLock(paths: RunPaths, lease: RunLockLease): Promise<void> {
  if (lease.child.exitCode !== null) throw new Error("Detached Codex runner lost its exclusive run lock.");
  const current = await readRunLock(paths, lease.record);
  if (!current || current.nonce !== lease.record.nonce ||
      current.pid !== lease.record.pid || current.processStartedAt !== lease.record.processStartedAt || current.role !== lease.record.role) {
    throw new Error("Detached Codex runner lost its exclusive run lock.");
  }
  lease.record.heartbeatAt = new Date().toISOString();
  await writeRunLockRecord(paths, lease);
}

async function releaseRunLock(paths: RunPaths, lease: RunLockLease): Promise<void> {
  if (lease.child.exitCode === null) {
    const current = await readRunLock(paths, lease.record);
    if (current?.nonce === lease.record.nonce && current.processStartedAt === lease.record.processStartedAt) {
      await fsp.unlink(paths.runnerLock).catch(() => undefined);
    }
  }
  lease.child.stdin?.end();
  await new Promise<void>((resolve) => {
    if (lease.child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { lease.child.kill(); resolve(); }, 2_000);
    lease.child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function observedRunnerAlive(
  paths: RunPaths,
  definition: CodingTaskRunDefinition,
  state: CodingTaskRunState
): Promise<boolean> {
  if (!state.runnerNonce || !state.runnerStartedAt || !state.heartbeatAt) return false;
  const record = await readRunLock(paths, definition);
  return Boolean(record && record.role === "runner" && record.nonce === state.runnerNonce &&
    record.processStartedAt === state.runnerStartedAt && record.pid === state.runnerPid &&
    Date.now() - Date.parse(record.heartbeatAt) <= HEARTBEAT_MS * 3 &&
    Date.now() - Date.parse(state.heartbeatAt) <= HEARTBEAT_MS * 3);
}

function assertDefinition(definition: CodingTaskRunDefinition, definitionPath: string, dataRoot: string): void {
  const taskId = validateCodingTaskId(definition.taskId);
  const operationId = validateOperationId(definition.operationId);
  const store = new CodingTaskStore({ dataRoot });
  const expected = runPaths(store, taskId, operationId).definition;
  if (definition.version !== RUN_VERSION || path.resolve(definitionPath) !== path.resolve(expected)) {
    throw new Error("Coding task run definition identity mismatch.");
  }
  if (!/^[0-9a-f]{64}$/.test(definition.fingerprint) || definition.fingerprint !== runDefinitionFingerprint(definition)) {
    throw new Error("Invalid or tampered run fingerprint.");
  }
  if (!Number.isSafeInteger(definition.expectedRevision) || definition.expectedRevision < 1) throw new Error("Invalid expected revision.");
  if (!Number.isSafeInteger(definition.executorEpoch) || definition.executorEpoch < 1) throw new Error("Invalid executor epoch.");
  if (!definition.leaseId.trim() || !path.isAbsolute(definition.worktreeRoot) || !definition.codexBinary.trim()) throw new Error("Invalid runner paths.");
  if (definition.threadId !== undefined && !definition.threadId.trim()) throw new Error("Invalid runner thread identity.");
  if (definition.expectedSessionId !== undefined && !definition.expectedSessionId.trim()) throw new Error("Invalid runner session identity.");
  if (definition.continuationFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(definition.continuationFingerprint)) {
    throw new Error("Invalid continuation fingerprint.");
  }
  if (!definition.model.trim() || definition.model.length > 160 || !definition.effort.trim() || definition.effort.length > 160 ||
      !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1_000 || definition.timeoutMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(definition.maxLogBytes) || definition.maxLogBytes < 64 * 1024 ||
      definition.maxLogBytes > 64 * 1024 * 1024 || !Number.isFinite(Date.parse(definition.createdAt))) {
    throw new Error("Invalid runner model, effort, or timeout.");
  }
  if (Buffer.byteLength(definition.prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("Run prompt exceeds the size limit.");
}

function runDefinitionFingerprint(definition: Omit<CodingTaskRunDefinition, "version" | "fingerprint">): string {
  return sha256(JSON.stringify({
    schema: "codexpro-coding-task-run-v1",
    taskId: definition.taskId, operationId: definition.operationId, prompt: definition.prompt,
    revision: definition.expectedRevision, epoch: definition.executorEpoch, leaseId: definition.leaseId,
    threadId: definition.threadId ?? null, expectedSessionId: definition.expectedSessionId ?? null,
    continuationFingerprint: definition.continuationFingerprint ?? null, model: definition.model,
    effort: definition.effort, timeoutMs: definition.timeoutMs, worktreeRoot: definition.worktreeRoot,
    codexBinary: definition.codexBinary, maxLogBytes: definition.maxLogBytes, createdAt: definition.createdAt
  }));
}

function operationRequestFingerprint(definition: CodingTaskRunDefinition): string {
  return sha256(JSON.stringify({
    executor: "codex",
    operationId: definition.operationId,
    codexThreadId: definition.threadId ?? null,
    codexSessionId: null,
    codexTurnId: null
  }));
}

function assertMatchingTaskIdentity(
  task: CodingTaskState,
  definition: CodingTaskRunDefinition,
  options: { requireActive?: boolean } = {}
): void {
  if (task.executor !== "codex" || task.executorLease.epoch !== definition.executorEpoch ||
      task.executorLease.leaseId !== definition.leaseId || task.worktreeRoot !== definition.worktreeRoot) {
    throw new Error("Codex run diverged from the authoritative CodingTask lease or worktree identity.");
  }
  if (options.requireActive) {
    const active = task.activeOperation;
    if (!active || active.operationId !== definition.operationId || active.executor !== "codex" ||
        active.kind !== "codex_run" || active.requestFingerprint !== operationRequestFingerprint(definition)) {
      throw new Error("Codex run diverged from the authoritative active operation identity.");
    }
  }
}

function terminalLifecycle(status: CodingTaskRunStatus): "waiting_review" | "completed" | "failed" | "canceled" {
  if (status === "waiting_review" || status === "completed" || status === "failed" || status === "canceled") return status;
  throw new Error(`Codex run status ${status} is not terminal.`);
}

function stateWithoutViewFields(view: CodingTaskRunView): CodingTaskRunState {
  const state = { ...view } as CodingTaskRunState & Partial<CodingTaskRunView>;
  delete state.definitionFingerprint;
  delete state.runnerAlive;
  delete state.reused;
  return state;
}

function continuationDecisionFingerprint(input: Omit<CodingTaskContinuationDecision, "version" | "fingerprint">): string {
  return sha256(JSON.stringify({
    schema: "codexpro-continuation-v1", taskId: input.taskId, requestKey: input.requestKey,
    operationId: input.operationId, turnOrdinal: input.turnOrdinal,
    previousOperationId: input.previousOperationId, prompt: input.prompt,
    expectedRevision: input.expectedRevision, executorEpoch: input.executorEpoch, leaseId: input.leaseId,
    expectedThreadId: input.expectedThreadId, expectedSessionId: input.expectedSessionId ?? null,
    expectedPreviousTurnId: input.expectedPreviousTurnId, model: input.model,
    effort: input.effort, timeoutMs: input.timeoutMs, createdAt: input.createdAt
  }));
}

function continuationDecisionMatchesInput(
  decision: CodingTaskContinuationDecision,
  input: Omit<CodingTaskContinuationDecision, "version" | "fingerprint" | "createdAt">
): boolean {
  return decision.taskId === input.taskId && decision.requestKey === input.requestKey &&
    decision.operationId === input.operationId && decision.turnOrdinal === input.turnOrdinal &&
    decision.previousOperationId === input.previousOperationId && decision.prompt === input.prompt &&
    decision.expectedRevision === input.expectedRevision && decision.executorEpoch === input.executorEpoch &&
    decision.leaseId === input.leaseId && decision.expectedThreadId === input.expectedThreadId &&
    decision.expectedSessionId === input.expectedSessionId &&
    decision.expectedPreviousTurnId === input.expectedPreviousTurnId && decision.model === input.model &&
    decision.effort === input.effort && decision.timeoutMs === input.timeoutMs;
}

function definitionMatchesLaunch(
  definition: CodingTaskRunDefinition,
  config: CodingTaskRunnerConfig,
  input: LaunchCodingTaskRunInput,
  prompt: string,
  worktreeRoot: string
): boolean {
  return definition.prompt === prompt && definition.executorEpoch === input.executorEpoch &&
    definition.leaseId === input.leaseId && definition.expectedRevision === input.expectedRevision &&
    definition.threadId === (input.threadId?.trim() || undefined) &&
    definition.model === (input.model?.trim() || "gpt-5.6-sol") &&
    definition.expectedSessionId === (input.expectedSessionId?.trim() || undefined) &&
    definition.continuationFingerprint === (input.continuationFingerprint?.trim() || undefined) &&
    definition.effort === (input.effort?.trim() || "high") &&
    definition.timeoutMs === Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000)) &&
    definition.worktreeRoot === worktreeRoot && definition.codexBinary === config.codexBinary &&
    definition.maxLogBytes === Math.max(64 * 1024,
      Math.min(config.maxLogBytes ?? 2 * 1024 * 1024, 64 * 1024 * 1024));
}

function assertContinuationDecision(
  decision: CodingTaskContinuationDecision,
  expected: { taskId: string; requestKey: string }
): void {
  if (decision.version !== RUN_VERSION || decision.taskId !== expected.taskId || decision.requestKey !== expected.requestKey ||
      validateCodingTaskId(decision.taskId) !== decision.taskId || validateRequestKey(decision.requestKey) !== decision.requestKey ||
      validateOperationId(decision.operationId) !== decision.operationId ||
      validateOperationId(decision.previousOperationId) !== decision.previousOperationId ||
      decision.operationId === decision.previousOperationId || !Number.isSafeInteger(decision.turnOrdinal) ||
      decision.turnOrdinal < 2 || decision.turnOrdinal > 100 || !Number.isSafeInteger(decision.expectedRevision) ||
      decision.expectedRevision < 1 || !Number.isSafeInteger(decision.executorEpoch) || decision.executorEpoch < 1 ||
      !decision.leaseId.trim() || !decision.expectedThreadId.trim() || !decision.expectedPreviousTurnId.trim() ||
      typeof decision.expectedSessionId !== "string" || !decision.expectedSessionId.trim() ||
      !decision.prompt.trim() || Buffer.byteLength(decision.prompt, "utf8") > MAX_PROMPT_BYTES ||
      !decision.model.trim() || decision.model.length > 160 || !decision.effort.trim() || decision.effort.length > 160 ||
      !Number.isSafeInteger(decision.timeoutMs) || decision.timeoutMs < 1_000 || decision.timeoutMs > 24 * 60 * 60_000 ||
      !Number.isFinite(Date.parse(decision.createdAt)) ||
      decision.fingerprint !== continuationDecisionFingerprint({
        taskId: decision.taskId, requestKey: decision.requestKey, operationId: decision.operationId,
        turnOrdinal: decision.turnOrdinal, previousOperationId: decision.previousOperationId,
        expectedRevision: decision.expectedRevision, executorEpoch: decision.executorEpoch,
        leaseId: decision.leaseId, expectedThreadId: decision.expectedThreadId,
        expectedSessionId: decision.expectedSessionId,
        expectedPreviousTurnId: decision.expectedPreviousTurnId, prompt: decision.prompt,
        model: decision.model, effort: decision.effort, timeoutMs: decision.timeoutMs,
        createdAt: decision.createdAt
      })) {
    throw new Error("Coding task continuation decision identity or fingerprint mismatch.");
  }
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
  if (input.continuationFingerprint !== undefined && !/^[0-9a-f]{64}$/.test(input.continuationFingerprint.trim())) {
    throw new Error("continuationFingerprint must be a SHA-256 hex digest.");
  }
  const publication = await store.withTaskLock(taskId, async () => {
    const task = await store.get(taskId);
    const existing = await readJson<CodingTaskRunDefinition>(paths.definition).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const stateExists = Boolean(await fsp.stat(paths.state).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }));
    if (existing) {
      assertDefinition(existing, paths.definition, store.dataRoot);
      if (!definitionMatchesLaunch(existing, config, input, prompt, task.worktreeRoot)) {
        throw new Error("operationId is already bound to a different Codex run contract.");
      }
      if (stateExists) return { definition: existing, reused: true };
      if (task.executor !== "codex" || task.executorLease.epoch !== input.executorEpoch ||
          task.executorLease.leaseId !== input.leaseId || task.revision !== input.expectedRevision || task.activeOperation ||
          task.worktreeRoot !== existing.worktreeRoot) {
        throw new Error("Definition-only Codex run recovery diverged from the authoritative task reservation.");
      }
      await assertTaskWorktreeIdentity(store, task);
      const entries = await cleanPublicationTemps(paths, { definitionExists: true, stateExists: false });
      const allowedHandoffArtifacts = new Set([
        path.basename(paths.definition), path.basename(paths.runnerGuard), path.basename(paths.runnerLock)
      ]);
      if (entries.some((entry) => !allowedHandoffArtifacts.has(entry))) {
        throw new Error("Definition-only Codex run recovery found ambiguous run artifacts.");
      }
      await writeCodingTaskJsonAtomic(paths.state, {
        version: RUN_VERSION, taskId, operationId, fingerprint: existing.fingerprint, status: "queued",
        createdAt: existing.createdAt, updatedAt: new Date().toISOString(), events: []
      } satisfies CodingTaskRunState);
      return { definition: existing, reused: true };
    }
    if (stateExists) throw new Error("Codex run state exists without its immutable definition.");
    if (task.executor !== "codex") throw new Error("Coding task is not owned by Codex.");
    if (task.executorLease.epoch !== input.executorEpoch || task.executorLease.leaseId !== input.leaseId) {
      throw new Error("Coding task executor lease changed.");
    }
    if (task.revision !== input.expectedRevision) throw new Error(`Coding task CAS conflict: observed revision ${task.revision}.`);
    if (input.threadId !== undefined && input.threadId.trim() !== task.codexThreadId) {
      throw new Error("Requested Codex thread does not match the task thread identity.");
    }
    if (input.expectedSessionId !== undefined && input.expectedSessionId.trim() !== task.codexSessionId) {
      throw new Error("Requested Codex session does not match the task session identity.");
    }
    if (task.activeOperation) throw new Error("Coding task already has an active operation.");
    await assertTaskWorktreeIdentity(store, task);
    await ensurePrivateDirectory(path.dirname(paths.runDir));
    const runDirStat = await fsp.lstat(paths.runDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (runDirStat) {
      await ensurePrivateDirectory(paths.runDir);
      if ((await cleanPublicationTemps(paths, { definitionExists: false, stateExists: false })).length !== 0) {
        throw new Error("Codex run directory exists without a definition and contains ambiguous artifacts.");
      }
    } else {
      await fsp.mkdir(paths.runDir, { mode: 0o700 });
      await ensurePrivateDirectory(paths.runDir);
    }
    const normalizedThreadId = input.threadId?.trim() || task.codexThreadId;
    const definitionFields = {
      taskId, operationId, prompt, expectedRevision: input.expectedRevision,
      executorEpoch: input.executorEpoch, leaseId: input.leaseId, worktreeRoot: task.worktreeRoot,
      ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
      ...(input.expectedSessionId?.trim() ? { expectedSessionId: input.expectedSessionId.trim() } : {}),
      ...(input.continuationFingerprint?.trim() ? { continuationFingerprint: input.continuationFingerprint.trim() } : {}),
      model: input.model?.trim() || "gpt-5.6-sol", effort: input.effort?.trim() || "high",
      timeoutMs: Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000)),
      codexBinary: config.codexBinary,
      maxLogBytes: Math.max(64 * 1024, Math.min(config.maxLogBytes ?? 2 * 1024 * 1024, 64 * 1024 * 1024)),
      createdAt: new Date().toISOString()
    };
    const definition: CodingTaskRunDefinition = {
      version: RUN_VERSION, ...definitionFields, fingerprint: runDefinitionFingerprint(definitionFields)
    };
    await writeCodingTaskJsonAtomic(paths.definition, definition);
    await writeCodingTaskJsonAtomic(paths.state, {
      version: RUN_VERSION, taskId, operationId, fingerprint: definition.fingerprint, status: "queued",
      createdAt: definition.createdAt, updatedAt: new Date().toISOString(), events: []
    } satisfies CodingTaskRunState);
    return { definition, reused: false };
  });
  const view = await reconcileCodingTaskRun(config, taskId, operationId, { relaunchQueued: true });
  return { ...view, ...(publication.reused ? { reused: true } : {}) };
}

async function spawnDetachedRunner(
  config: CodingTaskRunnerConfig,
  definition: CodingTaskRunDefinition,
  paths: RunPaths,
  worktreeRoot: string
): Promise<void> {
  const env = sanitizedRuntimeEnv(config.env);
  if (process.env.CODEXPRO_RUNNER_SMOKE === "1") {
    env.CODEXPRO_RUNNER_SMOKE = "1";
    if (process.env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS) {
      env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS = process.env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS;
    }
  }
  const runner = spawn(process.execPath, [RUNNER_PATH, paths.definition, path.resolve(config.dataRoot)], {
    cwd: worktreeRoot, env, shell: false, stdio: "ignore", detached: true, windowsHide: true
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
  let task = await store.get(taskId);

  if (["waiting_review", "completed", "failed", "canceled"].includes(view.status)) {
    if (!task.activeOperation) {
      if (task.lastCompletedOperation?.operationId === operationId &&
          (task.lastCompletedOperation.executorEpoch !== definition.executorEpoch ||
           task.lastCompletedOperation.lifecycle !== terminalLifecycle(view.status))) {
        throw new Error("Terminal Codex run diverged from the authoritative completed operation outcome.");
      }
      if ((view.status === "waiting_review" || view.status === "completed") &&
          task.lastCompletedOperation?.operationId !== operationId) {
        throw new Error("Terminal Codex run has no matching authoritative completed operation.");
      }
      return view;
    }
    assertMatchingTaskIdentity(task, definition, { requireActive: true });
    const lock = await acquireRunLock(paths, definition, "reconcile");
    if (!lock) return { ...view, runnerAlive: true };
    try {
      view = await getCodingTaskRunState(config, taskId, operationId);
      if (!["waiting_review", "completed", "failed", "canceled"].includes(view.status)) {
        return { ...view, runnerAlive: false };
      }
      task = await store.get(taskId);
      assertMatchingTaskIdentity(task, definition, { requireActive: true });
      await assertTaskWorktreeIdentity(store, task);
      const gitObservation = await observeCodingTask(config, taskId, {
        executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
        operationId, maxGitOutputBytes: definition.maxLogBytes
      });
      const finished = await finishCodingTaskOperationFenced(config, taskId, {
        executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
        operationId, lifecycle: terminalLifecycle(view.status), resultSummary: view.finalText?.slice(0, 20_000),
        error: view.status === "failed" ? view.error : undefined, codexThreadId: view.threadId,
        codexSessionId: view.sessionId, codexTurnId: view.turnId, gitObservation,
        logs: [runLogMetadata(paths, stateWithoutViewFields(view))]
      });
      const effectiveStatus: CodingTaskRunStatus = finished.lifecycle === "canceled" ? "canceled" : view.status;
      if (effectiveStatus !== view.status) {
        const now = finished.finishedAt ?? new Date().toISOString();
        await writeCodingTaskJsonAtomic(paths.state, compactRunState({
          ...stateWithoutViewFields(view), status: effectiveStatus, updatedAt: now, finishedAt: now,
          error: effectiveStatus === "canceled" ? undefined : view.error
        }, definition.maxLogBytes));
      }
      return { ...(await getCodingTaskRunState(config, taskId, operationId)), runnerAlive: false };
    } finally {
      await releaseRunLock(paths, lock);
    }
  }

  if (view.runnerAlive) return view;
  if (view.status === "queued") {
    const persistedCancel = task.activeOperation?.operationId === operationId
      ? await readCodingTaskCancellation(config, taskId, {
          operationId, executorEpoch: definition.executorEpoch
        })
      : undefined;
    if (persistedCancel && !view.runnerAlive) {
      const lock = await acquireRunLock(paths, definition, "reconcile");
      if (!lock) return view;
      try {
        view = await getCodingTaskRunState(config, taskId, operationId);
        task = await store.get(taskId);
        if (view.status !== "queued") return { ...view, runnerAlive: false };
        assertMatchingTaskIdentity(task, definition, { requireActive: true });
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
        return { ...(await getCodingTaskRunState(config, taskId, operationId)), runnerAlive: false };
      } finally {
        await releaseRunLock(paths, lock);
      }
    }
    if (options.relaunchQueued !== true) return view;
    if (!config.codexBinary?.trim()) throw new Error("codexBinary is required when queued-run relaunch is authorized.");
    const initialStaleMs = Math.max(0, Math.min(options.staleMs ?? 5_000, 10 * 60_000));
    if (view.runnerNonce?.startsWith("launch:") &&
        Date.now() - Date.parse(view.heartbeatAt ?? view.updatedAt) <= initialStaleMs) {
      return waitForCodingTaskRun(config, taskId, operationId, { timeoutMs: 12_000, terminal: false });
    }
    const lock = await acquireRunLock(paths, definition, "reconcile");
    if (!lock) return { ...view, runnerAlive: true };
    let launchNonce: string | undefined;
    let handoffPending = false;
    try {
      view = await getCodingTaskRunState(config, taskId, operationId);
      task = await store.get(taskId);
      if (view.status !== "queued") return { ...view, runnerAlive: false };
      assertMatchingTaskIdentity(task, definition, { requireActive: Boolean(task.activeOperation) });
      if (!task.activeOperation && task.revision !== definition.expectedRevision) {
        throw new Error("Queued Codex run cannot be relaunched because its immutable task revision changed.");
      }
      await assertTaskWorktreeIdentity(store, task);
      if (definition.worktreeRoot !== task.worktreeRoot || definition.codexBinary !== config.codexBinary) {
        throw new Error("Queued Codex run definition no longer matches the configured runner identity.");
      }
      const staleMs = Math.max(0, Math.min(options.staleMs ?? 5_000, 10 * 60_000));
      if (view.runnerNonce?.startsWith("launch:") && Date.now() - Date.parse(view.heartbeatAt ?? view.updatedAt) <= staleMs) {
        handoffPending = true;
      } else {
        launchNonce = `launch:${randomUUID()}`;
        const now = new Date().toISOString();
        await writeCodingTaskJsonAtomic(paths.state, compactRunState({
          ...stateWithoutViewFields(view), heartbeatAt: now, updatedAt: now,
          runnerNonce: launchNonce, runnerStartedAt: now, runnerPid: undefined
        }, definition.maxLogBytes));
      }
    } finally {
      await releaseRunLock(paths, lock);
    }
    if (handoffPending) {
      return waitForCodingTaskRun(config, taskId, operationId, { timeoutMs: 12_000, terminal: false });
    }
    try {
      const testDelay = process.env.CODEXPRO_RUNNER_SMOKE === "1"
        ? Number.parseInt(process.env.CODEXPRO_RUNNER_HANDOFF_DELAY_MS ?? "0", 10) : 0;
      if (Number.isSafeInteger(testDelay) && testDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 2_000)));
      }
      await spawnDetachedRunner(config as CodingTaskRunnerConfig, definition, paths, task.worktreeRoot);
    } catch (error) {
      const current = await getCodingTaskRunState(config, taskId, operationId);
      if (current.status === "queued" && current.runnerNonce === launchNonce) {
        await writeCodingTaskJsonAtomic(paths.state, compactRunState({ ...stateWithoutViewFields(current),
          status: "running", heartbeatAt: new Date(0).toISOString(), error: bounded(errorMessage(error), 20_000)
        }, definition.maxLogBytes));
      }
      throw error;
    }
    const launched = await waitForCodingTaskRun(config, taskId, operationId, { timeoutMs: 12_000, terminal: false });
    if (launched.status === "queued") {
      throw new Error(`Detached Codex runner launch handoff did not become authoritative: ${launched.error ?? "no runner acknowledgement"}`);
    }
    return launched;
  }
  const staleMs = Math.max(0, Math.min(options.staleMs ?? 5_000, 10 * 60_000));
  if (Date.now() - Date.parse(view.heartbeatAt ?? view.updatedAt) <= staleMs) return view;
  assertMatchingTaskIdentity(task, definition, { requireActive: true });
  const lock = await acquireRunLock(paths, definition, "reconcile");
  if (!lock) return { ...view, runnerAlive: true };
  try {
    view = await getCodingTaskRunState(config, taskId, operationId);
    task = await store.get(taskId);
    if (view.status !== "running") return { ...view, runnerAlive: false };
    assertMatchingTaskIdentity(task, definition, { requireActive: true });
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
    const state: CodingTaskRunState = { ...stateWithoutViewFields(view),
      status: finishedTask.lifecycle === "canceled" ? "canceled" : "failed",
      updatedAt: now, finishedAt: now, error: finishedTask.lifecycle === "canceled" ? undefined : error };
    await writeCodingTaskJsonAtomic(paths.state, compactRunState(state, definition.maxLogBytes));
    return { ...(await getCodingTaskRunState(config, taskId, operationId)), runnerAlive: false };
  } finally {
    await releaseRunLock(paths, lock);
  }
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
  return store.withTaskLock(taskId, async () => {
      const currentView = await getCodingTaskRunState(config, taskId, operationId);
      if (currentView.status === "canceled") return { ...currentView, reused: true };
      if (currentView.status !== "queued") throw new Error("Queued Codex run is no longer safely cancelable.");
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
      const queuedCancel: QueuedRunCancellation = {
        version: RUN_VERSION, taskId, operationId, fingerprint: definition.fingerprint,
        executorEpoch: definition.executorEpoch, leaseId: definition.leaseId, requestedAt: now,
        ...(reason?.trim() ? { reason: bounded(reason.trim(), 20_000) } : {})
      };
      try {
        const handle = await fsp.open(paths.queuedCancel, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(queuedCancel)}\n`, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await readQueuedRunCancellation(paths, definition);
      }
      const canceled: CodingTaskRunState = {
        version: RUN_VERSION, taskId, operationId, fingerprint: definition.fingerprint, status: "canceled",
        createdAt: currentView.createdAt, updatedAt: now, finishedAt: now,
        ...(reason?.trim() ? { error: bounded(`Canceled before launch: ${reason.trim()}`, 20_000) } : {}),
        events: currentView.events
      };
      await writeCodingTaskJsonAtomic(paths.state, compactRunState(canceled, definition.maxLogBytes));
      return { ...(await getCodingTaskRunState(config, taskId, operationId)), runnerAlive: false };
  });
}

export async function getCodingTaskRun(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  operationId: string
): Promise<CodingTaskRunView> {
  const view = await getCodingTaskRunState(config, taskIdInput, operationId);
  const store = new CodingTaskStore(config);
  const paths = runPaths(store, view.taskId, view.operationId);
  const definition = await readJson<CodingTaskRunDefinition>(paths.definition);
  return { ...view, runnerAlive: await observedRunnerAlive(paths, definition, view) };
}

async function getCodingTaskRunState(
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
  return { ...state, definitionFingerprint: definition.fingerprint, runnerAlive: false };
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

export async function submitCodingTaskContinuation(
  config: CodingTaskRunnerConfig,
  taskIdInput: string,
  input: SubmitCodingTaskContinuationInput
): Promise<CodingTaskContinuationResult> {
  const taskId = validateCodingTaskId(taskIdInput);
  const requestKey = validateRequestKey(input.requestKey);
  const operationId = validateOperationId(input.operationId);
  const previousOperationId = validateOperationId(input.previousOperationId);
  if (operationId === previousOperationId) throw new Error("Continuation operationId must differ from previousOperationId.");
  if (!Number.isSafeInteger(input.turnOrdinal) || input.turnOrdinal < 2 || input.turnOrdinal > 100) {
    throw new Error("Continuation turnOrdinal must be an integer from 2 through 100.");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.executorEpoch) || input.executorEpoch < 1 || !input.leaseId.trim()) {
    throw new Error("Continuation task revision and executor lease identity are required.");
  }
  const expectedThreadId = input.expectedThreadId.trim();
  if (typeof input.expectedSessionId !== "string") throw new Error("Continuation expectedSessionId is required.");
  const expectedSessionId = input.expectedSessionId.trim();
  const expectedPreviousTurnId = input.expectedPreviousTurnId.trim();
  if (!expectedThreadId) throw new Error("Continuation expectedThreadId is required.");
  if (!expectedSessionId) throw new Error("Continuation expectedSessionId is required.");
  if (!expectedPreviousTurnId) throw new Error("Continuation expectedPreviousTurnId is required.");
  const rawPrompt = input.prompt.trim();
  if (!rawPrompt || Buffer.byteLength(rawPrompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("continuation prompt is required and must fit the size limit.");
  }
  const prompt = bounded(rawPrompt, MAX_PROMPT_BYTES);
  const model = input.model?.trim() || "gpt-5.6-sol";
  const effort = input.effort?.trim() || "high";
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs ?? 30 * 60_000, 24 * 60 * 60_000));
  const normalizedDecisionInput = {
    taskId, requestKey, operationId, turnOrdinal: input.turnOrdinal, previousOperationId,
    expectedRevision: input.expectedRevision, executorEpoch: input.executorEpoch, leaseId: input.leaseId,
    expectedThreadId, expectedSessionId, expectedPreviousTurnId,
    prompt, model, effort, timeoutMs
  };
  const store = new CodingTaskStore(config);
  const ledgerDir = path.join(store.paths(taskId).taskDir, "continuations", `request_${sha256(requestKey).slice(0, 32)}`);
  const decisionPath = path.join(ledgerDir, "decision.json");
  let reused = true;
  let decision = await readJson<CodingTaskContinuationDecision>(decisionPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!decision) {
    decision = await store.withTaskLock(taskId, async () => {
      const raced = await readJson<CodingTaskContinuationDecision>(decisionPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (raced) return raced;
      const task = await store.get(taskId);
      if (task.executor !== "codex" || task.executorLease.epoch !== input.executorEpoch ||
          task.executorLease.leaseId !== input.leaseId) {
        throw new Error("Coding task continuation executor lease changed.");
      }
      if (task.revision !== input.expectedRevision) {
        throw new Error(`Coding task CAS conflict: observed revision ${task.revision}.`);
      }
      if (task.lifecycle !== "waiting_review" || task.activeOperation || task.codexTurnActive) {
        throw new Error("Coding task continuation requires an idle waiting_review task.");
      }
      if (task.cancelRequestedAt) throw new Error("Coding task cancellation is pending; continuation is not accepted.");
      if (task.lastCompletedOperation?.operationId !== previousOperationId ||
          task.lastCompletedOperation.executor !== "codex" ||
          task.lastCompletedOperation.executorEpoch !== input.executorEpoch ||
          task.lastCompletedOperation.lifecycle !== "waiting_review") {
        throw new Error("Coding task continuation previous operation identity changed.");
      }
      if (task.codexThreadId !== expectedThreadId ||
          task.codexSessionId !== expectedSessionId ||
          task.codexTurnId !== expectedPreviousTurnId) {
        throw new Error("Coding task continuation thread, session, or previous turn identity changed.");
      }
      const previousRun = await getCodingTaskRunState(config, taskId, previousOperationId);
      if (previousRun.status !== "waiting_review" || previousRun.threadId !== expectedThreadId ||
          previousRun.turnId !== expectedPreviousTurnId ||
          previousRun.sessionId !== expectedSessionId) {
        throw new Error("Coding task continuation previous terminal run identity changed.");
      }
      const created: CodingTaskContinuationDecision = {
        version: RUN_VERSION, ...normalizedDecisionInput,
        fingerprint: "",
        createdAt: new Date().toISOString()
      };
      created.fingerprint = continuationDecisionFingerprint(created);
      await ensurePrivateDirectory(path.dirname(ledgerDir));
      await ensurePrivateDirectory(ledgerDir);
      await writeCodingTaskJsonAtomic(decisionPath, created);
      reused = false;
      return created;
    });
  }
  assertContinuationDecision(decision, { taskId, requestKey });
  if (!continuationDecisionMatchesInput(decision, normalizedDecisionInput)) {
    throw new Error("requestKey is already bound to a different continuation contract.");
  }
  const run = await launchCodingTaskRun(config, taskId, {
    operationId: decision.operationId, prompt: decision.prompt, expectedRevision: decision.expectedRevision,
    executorEpoch: decision.executorEpoch, leaseId: decision.leaseId, threadId: decision.expectedThreadId,
    expectedSessionId: decision.expectedSessionId,
    continuationFingerprint: decision.fingerprint,
    model: decision.model, effort: decision.effort, timeoutMs: decision.timeoutMs
  });
  return { decision, run, reused };
}

export async function getCodingTaskContinuation(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  requestKeyInput: string
): Promise<CodingTaskContinuationView> {
  const taskId = validateCodingTaskId(taskIdInput);
  const requestKey = validateRequestKey(requestKeyInput);
  const store = new CodingTaskStore(config);
  const decisionPath = path.join(store.paths(taskId).taskDir, "continuations",
    `request_${sha256(requestKey).slice(0, 32)}`, "decision.json");
  const decision = await readJson<CodingTaskContinuationDecision>(decisionPath);
  assertContinuationDecision(decision, { taskId, requestKey });
  const run = await getCodingTaskRun(config, taskId, decision.operationId).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (run && run.definitionFingerprint && run.operationId !== decision.operationId) {
    throw new Error("Coding task continuation run identity mismatch.");
  }
  return { decision, ...(run ? { run } : {}) };
}

async function runDetached(definitionPath: string, dataRoot: string): Promise<void> {
  const definition = await readJson<CodingTaskRunDefinition>(definitionPath);
  assertDefinition(definition, definitionPath, dataRoot);
  const store = new CodingTaskStore({ dataRoot });
  const paths = runPaths(store, definition.taskId, definition.operationId);
  await ensurePrivateDirectory(paths.runDir);
  await ensurePrivateDirectory(paths.steerInbox);
  await ensurePrivateDirectory(paths.steerAcks);
  // A relaunch authority writes the launch marker while holding the same advisory lock, then
  // releases it immediately before spawning us. Concurrent idempotent reconcilers may briefly
  // probe that lock during the handoff, so a one-shot acquisition could strand an exact queued run.
  const runnerLock = await acquireRunnerLockAfterHandoff(paths, definition);
  // A losing child must not mutate queued/canceled state without the advisory lease. The persisted
  // launch marker becomes stale and a later execution-authorized reconciliation may relaunch it.
  if (!runnerLock) return;

  let runState = await readJson<CodingTaskRunState>(paths.state);
  if (["waiting_review", "completed", "failed", "canceled"].includes(runState.status)) {
    await releaseRunLock(paths, runnerLock);
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
  let lockRefresh: Promise<void> = Promise.resolve();
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
        const cancellation = await readCodingTaskCancellation({ dataRoot }, definition.taskId, {
          operationId: definition.operationId, executorEpoch: definition.executorEpoch
        });
        if (cancellation) {
          cancelRequested = true;
          controller.abort();
          await client.interrupt();
          throw new Error("Coding task cancellation won before the steering request was delivered.");
        }
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
      if (cancelRequested) return;
    }
  };

  try {
    const current = await store.get(definition.taskId);
    if (current.worktreeRoot !== definition.worktreeRoot || current.executor !== "codex" ||
        current.executorLease.epoch !== definition.executorEpoch || current.executorLease.leaseId !== definition.leaseId) {
      throw new Error("Coding task run lease or identity changed before runner start.");
    }
    if (current.activeOperation) {
      assertMatchingTaskIdentity(current, definition, { requireActive: true });
    } else if (current.revision !== definition.expectedRevision) {
      throw new Error("Coding task run revision changed before runner start.");
    }
    await assertTaskWorktreeIdentity(store, current);
    const realWorktree = await fsp.realpath(definition.worktreeRoot);
    if (realWorktree !== definition.worktreeRoot) throw new Error("Coding task worktree real path changed.");
    const queuedCancellation = await readQueuedRunCancellation(paths, definition);
    if (queuedCancellation && !current.activeOperation) {
      const now = new Date().toISOString();
      await persistRun({ status: "canceled", finishedAt: now, heartbeatAt: now,
        error: queuedCancellation.reason ? bounded(`Canceled before launch: ${queuedCancellation.reason}`, 20_000) : undefined });
      return;
    }
    taskState = await beginCodingTaskOperation({ dataRoot }, definition.taskId, {
      expectedRevision: definition.expectedRevision, executor: "codex", executorEpoch: definition.executorEpoch,
      leaseId: definition.leaseId, operationId: definition.operationId, codexRunnerPid: process.pid,
      ...(definition.threadId ? { codexThreadId: definition.threadId } : {})
    });
    const cancellationAfterBegin = await readQueuedRunCancellation(paths, definition);
    if (cancellationAfterBegin) {
      const gitObservation = await observeCodingTask({ dataRoot }, definition.taskId, {
        executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
        operationId: definition.operationId, maxGitOutputBytes: definition.maxLogBytes
      });
      taskState = await finishCodingTaskOperationFenced({ dataRoot }, definition.taskId, {
        executor: "codex", executorEpoch: definition.executorEpoch, leaseId: definition.leaseId,
        operationId: definition.operationId, lifecycle: "canceled", error: cancellationAfterBegin.reason,
        gitObservation
      });
      const canceledAt = taskState.finishedAt ?? new Date().toISOString();
      await persistRun({ status: "canceled", finishedAt: canceledAt, heartbeatAt: canceledAt,
        error: cancellationAfterBegin.reason ? bounded(`Canceled before launch: ${cancellationAfterBegin.reason}`, 20_000) : undefined });
      return;
    }
    const startedAt = new Date().toISOString();
    await persistRun({ status: "running", startedAt, heartbeatAt: startedAt, runnerPid: process.pid,
      runnerNonce: runnerLock.record.nonce, runnerStartedAt: runnerLock.record.processStartedAt });
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
    if (definition.expectedSessionId && identity.sessionId !== definition.expectedSessionId) {
      throw new Error("Codex thread resume returned an unexpected session identity.");
    }
    runState.threadId = identity.threadId;
    runState.sessionId = identity.sessionId;
    heartbeat({ threadId: identity.threadId, sessionId: identity.sessionId });
    await mutationChain;
    heartbeatTimer = setInterval(() => {
      runState.heartbeatAt = new Date().toISOString();
      lockRefresh = lockRefresh.then(() => refreshRunLock(paths, runnerLock)).catch((error) => {
        mutationError = error instanceof Error ? error : new Error(String(error));
        controller.abort();
      });
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
    await lockRefresh;
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
    await lockRefresh.catch(() => undefined);
    await releaseRunLock(paths, runnerLock);
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
