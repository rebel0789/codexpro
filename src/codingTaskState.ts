export const CODING_TASK_VERSION = 1 as const;

export const CODING_TASK_ID_PATTERN = /^task_[a-f0-9]{24}$/;
export const CODING_TASK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
export const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export type CodingTaskExecutor = "direct" | "codex";
export type CodingTaskLifecycle =
  | "ready"
  | "running"
  | "waiting_review"
  | "completed"
  | "failed"
  | "canceled";

export type CodingTaskEventKind =
  | "created"
  | "executor_released"
  | "executor_acquired"
  | "state_updated"
  | "codex_turn_started"
  | "codex_turn_finished"
  | "operation_interrupted";

export interface CodingTaskEvent {
  at: string;
  kind: CodingTaskEventKind;
  executor?: CodingTaskExecutor;
  epoch?: number;
  message?: string;
}

export interface CodingTaskLogMetadata {
  name: string;
  relativePath: string;
  bytes: number;
  truncated: boolean;
  updatedAt: string;
}

export interface CodingTaskExecutorLease {
  owner: CodingTaskExecutor;
  epoch: number;
  leaseId: string;
  acquiredAt: string;
}

export interface CodingTaskActiveOperation {
  operationId: string;
  executor: CodingTaskExecutor;
  kind: "direct" | "codex_run";
  startedAt: string;
  heartbeatAt: string;
  pid: number;
  requestFingerprint: string;
}

export interface CodingTaskCompletedOperation {
  operationId: string;
  executor: CodingTaskExecutor;
  executorEpoch: number;
  lifecycle: CodingTaskLifecycle;
  endedAt: string;
  completionFingerprint: string;
}

export interface CodingTaskGitObservation {
  capturedAt: string;
  headSha: string;
  status: string;
  diffStat: string;
  diffSha256: string;
  dirty: boolean;
}

export interface CodingTaskTransitionRecord {
  key: string;
  from: CodingTaskExecutor;
  to: CodingTaskExecutor;
  fromEpoch: number;
  toEpoch: number;
  completedAt: string;
  observation: CodingTaskGitObservation;
}

export interface CodingTaskState {
  version: typeof CODING_TASK_VERSION;
  taskId: string;
  taskKey?: string;
  createFingerprint: string;
  title: string;
  goal: string;
  goalId?: string;
  goalWorkId?: string;
  executor: CodingTaskExecutor;
  lifecycle: CodingTaskLifecycle;
  baseSha: string;
  sourceRoot: string;
  sourceGitCommonDir: string;
  sourceUncommittedChangesIncluded: false;
  sourceDirtyAtCreation: boolean;
  sourceStatusEntryCountAtCreation: number;
  worktreeRoot: string;
  workspaceId: string;
  revision: number;
  executorLease: CodingTaskExecutorLease;
  activeOperation?: CodingTaskActiveOperation;
  lastCompletedOperation?: CodingTaskCompletedOperation;
  codexThreadId?: string;
  codexSessionId?: string;
  codexTurnId?: string;
  codexTurnActive: boolean;
  codexRunnerPid?: number;
  codexHeartbeatAt?: string;
  resultSummary?: string;
  error?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  events: CodingTaskEvent[];
  logs: CodingTaskLogMetadata[];
  lastGitObservation?: CodingTaskGitObservation;
  lastTransition?: CodingTaskTransitionRecord;
}

const EXECUTORS = new Set<CodingTaskExecutor>(["direct", "codex"]);
const LIFECYCLES = new Set<CodingTaskLifecycle>([
  "ready",
  "running",
  "waiting_review",
  "completed",
  "failed",
  "canceled"
]);
const EVENT_KINDS = new Set<CodingTaskEventKind>([
  "created",
  "executor_released",
  "executor_acquired",
  "state_updated",
  "codex_turn_started",
  "codex_turn_finished",
  "operation_interrupted"
]);

function invalid(detail: string): never {
  throw new Error(`Invalid coding task state: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, name: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) invalid(name);
  return value;
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) invalid(name);
  return value;
}

function timestamp(value: unknown, name: string, optional = false): string | undefined {
  const text = stringField(value, name, 64, optional);
  if (text === undefined) return undefined;
  if (!Number.isFinite(Date.parse(text))) invalid(name);
  return text;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(name);
  return value as number;
}

function assertExecutor(value: unknown, name: string): asserts value is CodingTaskExecutor {
  if (!EXECUTORS.has(value as CodingTaskExecutor)) invalid(name);
}

function assertGitObservation(value: unknown, name: string): asserts value is CodingTaskGitObservation {
  if (!isRecord(value)) invalid(name);
  timestamp(value.capturedAt, `${name}.capturedAt`);
  if (typeof value.headSha !== "string" || !FULL_GIT_SHA_PATTERN.test(value.headSha)) invalid(`${name}.headSha`);
  boundedString(value.status, `${name}.status`, 32_000);
  boundedString(value.diffStat, `${name}.diffStat`, 32_000);
  if (typeof value.diffSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.diffSha256)) invalid(`${name}.diffSha256`);
  if (typeof value.dirty !== "boolean") invalid(`${name}.dirty`);
}

export function validateCodingTaskId(taskId: string): string {
  const normalized = taskId.trim().toLowerCase();
  if (!CODING_TASK_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid coding task id; expected task_ followed by 24 lowercase hexadecimal characters.");
  }
  return normalized;
}

export function validateCodingTaskKey(taskKey: string): string {
  const normalized = taskKey.trim();
  if (!CODING_TASK_KEY_PATTERN.test(normalized)) {
    throw new Error("Coding task key must be 1-160 safe characters and start with a letter or number.");
  }
  return normalized;
}

export function validateFullGitSha(sha: string, name = "base SHA"): string {
  const normalized = sha.trim().toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(normalized)) throw new Error(`${name} must be a full 40-character Git commit SHA.`);
  return normalized;
}

export function assertCodingTaskState(value: unknown, expectedTaskId?: string): asserts value is CodingTaskState {
  if (!isRecord(value)) invalid("root");
  if (value.version !== CODING_TASK_VERSION) invalid("version");
  if (typeof value.taskId !== "string" || !CODING_TASK_ID_PATTERN.test(value.taskId)) invalid("taskId");
  if (expectedTaskId && value.taskId !== validateCodingTaskId(expectedTaskId)) invalid("taskId identity mismatch");
  if (value.taskKey !== undefined) validateCodingTaskKey(String(value.taskKey));
  if (typeof value.createFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.createFingerprint)) invalid("createFingerprint");
  stringField(value.title, "title", 500);
  stringField(value.goal, "goal", 20_000);
  stringField(value.goalId, "goalId", 80, true);
  stringField(value.goalWorkId, "goalWorkId", 80, true);
  if ((value.goalId === undefined) !== (value.goalWorkId === undefined)) invalid("Goal membership must include both goalId and goalWorkId");
  if (value.goalId !== undefined && !/^goal_[a-f0-9]{24}$/.test(String(value.goalId))) invalid("goalId");
  if (value.goalWorkId !== undefined && !/^work_[a-z0-9][a-z0-9_-]{0,63}$/.test(String(value.goalWorkId))) invalid("goalWorkId");
  assertExecutor(value.executor, "executor");
  if (!LIFECYCLES.has(value.lifecycle as CodingTaskLifecycle)) invalid("lifecycle");
  if (typeof value.baseSha !== "string" || !FULL_GIT_SHA_PATTERN.test(value.baseSha)) invalid("baseSha");
  stringField(value.sourceRoot, "sourceRoot", 8_192);
  stringField(value.sourceGitCommonDir, "sourceGitCommonDir", 8_192);
  if (value.sourceUncommittedChangesIncluded !== false) invalid("sourceUncommittedChangesIncluded");
  if (typeof value.sourceDirtyAtCreation !== "boolean") invalid("sourceDirtyAtCreation");
  if (!Number.isSafeInteger(value.sourceStatusEntryCountAtCreation) || (value.sourceStatusEntryCountAtCreation as number) < 0) {
    invalid("sourceStatusEntryCountAtCreation");
  }
  stringField(value.worktreeRoot, "worktreeRoot", 8_192);
  if (typeof value.workspaceId !== "string" || value.workspaceId !== `taskws_${value.taskId.slice(5)}`) invalid("workspaceId");
  positiveInteger(value.revision, "revision");
  if (!isRecord(value.executorLease)) invalid("executorLease");
  assertExecutor(value.executorLease.owner, "executorLease.owner");
  if (value.executorLease.owner !== value.executor) invalid("executorLease owner mismatch");
  positiveInteger(value.executorLease.epoch, "executorLease.epoch");
  stringField(value.executorLease.leaseId, "executorLease.leaseId", 200);
  timestamp(value.executorLease.acquiredAt, "executorLease.acquiredAt");
  if (value.activeOperation !== undefined) {
    if (!isRecord(value.activeOperation)) invalid("activeOperation");
    stringField(value.activeOperation.operationId, "activeOperation.operationId", 200);
    assertExecutor(value.activeOperation.executor, "activeOperation.executor");
    if (value.activeOperation.executor !== value.executor) invalid("activeOperation executor mismatch");
    if (value.activeOperation.kind !== "direct" && value.activeOperation.kind !== "codex_run") invalid("activeOperation.kind");
    if (value.activeOperation.kind === "direct" && value.activeOperation.executor !== "direct") invalid("direct operation owner");
    if (value.activeOperation.kind === "codex_run" && value.activeOperation.executor !== "codex") invalid("Codex operation owner");
    timestamp(value.activeOperation.startedAt, "activeOperation.startedAt");
    timestamp(value.activeOperation.heartbeatAt, "activeOperation.heartbeatAt");
    positiveInteger(value.activeOperation.pid, "activeOperation.pid");
    if (typeof value.activeOperation.requestFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.activeOperation.requestFingerprint)) {
      invalid("activeOperation.requestFingerprint");
    }
  }
  if (value.lastCompletedOperation !== undefined) {
    if (!isRecord(value.lastCompletedOperation)) invalid("lastCompletedOperation");
    stringField(value.lastCompletedOperation.operationId, "lastCompletedOperation.operationId", 200);
    assertExecutor(value.lastCompletedOperation.executor, "lastCompletedOperation.executor");
    positiveInteger(value.lastCompletedOperation.executorEpoch, "lastCompletedOperation.executorEpoch");
    if (!LIFECYCLES.has(value.lastCompletedOperation.lifecycle as CodingTaskLifecycle)) invalid("lastCompletedOperation.lifecycle");
    timestamp(value.lastCompletedOperation.endedAt, "lastCompletedOperation.endedAt");
    if (typeof value.lastCompletedOperation.completionFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.lastCompletedOperation.completionFingerprint)) {
      invalid("lastCompletedOperation.completionFingerprint");
    }
  }
  stringField(value.codexThreadId, "codexThreadId", 500, true);
  stringField(value.codexSessionId, "codexSessionId", 500, true);
  stringField(value.codexTurnId, "codexTurnId", 500, true);
  if (typeof value.codexTurnActive !== "boolean") invalid("codexTurnActive");
  if (value.codexTurnActive && (!value.codexThreadId || !value.codexTurnId || value.executor !== "codex")) {
    invalid("active Codex turn ownership");
  }
  if (value.codexRunnerPid !== undefined) positiveInteger(value.codexRunnerPid, "codexRunnerPid");
  timestamp(value.codexHeartbeatAt, "codexHeartbeatAt", true);
  stringField(value.resultSummary, "resultSummary", 20_000, true);
  stringField(value.error, "error", 20_000, true);
  timestamp(value.cancelRequestedAt, "cancelRequestedAt", true);
  stringField(value.cancelReason, "cancelReason", 1_000, true);
  timestamp(value.createdAt, "createdAt");
  timestamp(value.updatedAt, "updatedAt");
  timestamp(value.startedAt, "startedAt", true);
  timestamp(value.finishedAt, "finishedAt", true);
  if (!Array.isArray(value.events) || value.events.length > 200) invalid("events");
  for (const [index, event] of value.events.entries()) {
    if (!isRecord(event)) invalid(`events[${index}]`);
    timestamp(event.at, `events[${index}].at`);
    if (!EVENT_KINDS.has(event.kind as CodingTaskEventKind)) invalid(`events[${index}].kind`);
    if (event.executor !== undefined) assertExecutor(event.executor, `events[${index}].executor`);
    if (event.epoch !== undefined) positiveInteger(event.epoch, `events[${index}].epoch`);
    stringField(event.message, `events[${index}].message`, 1_000, true);
  }
  if (!Array.isArray(value.logs) || value.logs.length > 100) invalid("logs");
  for (const [index, log] of value.logs.entries()) {
    if (!isRecord(log)) invalid(`logs[${index}]`);
    stringField(log.name, `logs[${index}].name`, 100);
    const relativePath = stringField(log.relativePath, `logs[${index}].relativePath`, 1_000)!;
    if (relativePath.startsWith("/") || relativePath.startsWith("../") || relativePath.includes("/../") || relativePath.includes("\\")) {
      invalid(`logs[${index}].relativePath`);
    }
    if (!Number.isSafeInteger(log.bytes) || (log.bytes as number) < 0) invalid(`logs[${index}].bytes`);
    if (typeof log.truncated !== "boolean") invalid(`logs[${index}].truncated`);
    timestamp(log.updatedAt, `logs[${index}].updatedAt`);
  }
  if (value.lastGitObservation !== undefined) assertGitObservation(value.lastGitObservation, "lastGitObservation");
  if (value.lastTransition !== undefined) {
    const transition = value.lastTransition;
    if (!isRecord(transition)) invalid("lastTransition");
    stringField(transition.key, "lastTransition.key", 160);
    assertExecutor(transition.from, "lastTransition.from");
    assertExecutor(transition.to, "lastTransition.to");
    positiveInteger(transition.fromEpoch, "lastTransition.fromEpoch");
    positiveInteger(transition.toEpoch, "lastTransition.toEpoch");
    timestamp(transition.completedAt, "lastTransition.completedAt");
    assertGitObservation(transition.observation, "lastTransition.observation");
  }
}

export function parseCodingTaskState(value: unknown, expectedTaskId?: string): CodingTaskState {
  assertCodingTaskState(value, expectedTaskId);
  return value;
}
