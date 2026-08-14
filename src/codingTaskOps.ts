import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  CODING_TASK_VERSION,
  parseCodingTaskState,
  validateCodingTaskKey,
  validateCodingTaskId,
  validateFullGitSha,
  type CodingTaskEvent,
  type CodingTaskExecutor,
  type CodingTaskLifecycle,
  type CodingTaskLogMetadata,
  type CodingTaskGitObservation,
  type CodingTaskState
} from "./codingTaskState.js";
import { CodingTaskStore, writeCodingTaskJsonAtomic, type CodingTaskListOptions, type CodingTaskStoreConfig } from "./codingTaskStore.js";
import {
  createCodingTaskWorktree,
  inspectCodingTaskSource,
  observeCodingTaskGit,
  reviewCodingTaskWorktree,
  assertCodingTaskWorktree,
  type CodingTaskReviewSnapshot,
  type CodingTaskSourceWorkspace,
  type CodingTaskWorkspaceGuard
} from "./codingTaskWorktree.js";

const MAX_EVENTS = 200;
const MAX_LOGS = 100;

export interface CodingTaskCasExpectation {
  expectedRevision: number;
  executor?: CodingTaskExecutor;
  executorEpoch?: number;
  leaseId?: string;
  operationId?: string;
}

export interface CodingTaskCancelRequest {
  version: 1;
  taskId: string;
  operationId: string;
  executorEpoch: number;
  requestedAt: string;
  reason?: string;
}

export type CodingTaskCancelInput = Omit<CodingTaskCasExpectation, "expectedRevision" | "executorEpoch" | "operationId" | "leaseId"> & {
  expectedRevision?: number;
  operationId: string;
  executorEpoch: number;
  leaseId: string;
  reason?: string;
};


export interface BeginCodingTaskOperationInput extends CodingTaskCasExpectation {
  executor: CodingTaskExecutor;
  operationId: string;
  codexThreadId?: string;
  codexSessionId?: string;
  codexTurnId?: string;
  codexRunnerPid?: number;
}

export interface HeartbeatCodingTaskOperationInput extends CodingTaskCasExpectation {
  executor: CodingTaskExecutor;
  operationId: string;
  codexThreadId?: string;
  codexSessionId?: string;
  codexTurnId?: string;
  codexRunnerPid?: number;
  logs?: CodingTaskLogMetadata[];
  event?: Omit<CodingTaskEvent, "at"> & { at?: string };
}

export interface EndCodingTaskOperationInput extends CodingTaskCasExpectation {
  executor: CodingTaskExecutor;
  operationId: string;
  lifecycle: Extract<CodingTaskLifecycle, "ready" | "waiting_review" | "completed" | "failed" | "canceled">;
  resultSummary?: string;
  error?: string;
  codexThreadId?: string;
  codexSessionId?: string;
  codexTurnId?: string;
  logs?: CodingTaskLogMetadata[];
  gitObservation?: CodingTaskGitObservation;
}

export type FinishCodingTaskOperationInput = Omit<EndCodingTaskOperationInput, "expectedRevision"> & {
  expectedRevision?: number;
};

export interface CreateCodingTaskInput {
  taskKey: string;
  title: string;
  goal: string;
  executor: CodingTaskExecutor;
  baseSha: string;
  goalId?: string;
  goalWorkId?: string;
}

export interface TransitionCodingTaskExecutorInput {
  expectedRevision: number;
  expectedExecutorEpoch: number;
  transitionKey: string;
  to: CodingTaskExecutor;
  expectedLeaseId?: string;
  maxGitOutputBytes?: number;
  recoverInterruptedAfterMs?: number;
}

export interface CodingTaskWorkspace {
  id: string;
  taskId: string;
  root: string;
  openedAt: string;
  worktreeRoot: string;
  sourceRoot: string;
  provenanceVerified: true;
}

export function codingTaskWorkspaceId(taskIdInput: string): string {
  return `taskws_${validateCodingTaskId(taskIdInput).slice(5)}`;
}

export function codingTaskStore(config: CodingTaskStoreConfig): CodingTaskStore {
  return new CodingTaskStore(config);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateTaskText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new Error(`${name} must be 1-${max} characters.`);
  }
  return normalized;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function createCodingTask(
  config: CodingTaskStoreConfig,
  workspace: CodingTaskSourceWorkspace,
  guard: CodingTaskWorkspaceGuard | undefined,
  input: CreateCodingTaskInput
): Promise<{ task: CodingTaskState; reused: boolean }> {
  const taskKey = validateCodingTaskKey(input.taskKey);
  const title = validateTaskText(input.title, "Coding task title", 500);
  const goal = validateTaskText(input.goal, "Coding task goal", 20_000);
  const goalId = input.goalId?.trim().toLowerCase();
  const goalWorkId = input.goalWorkId?.trim().toLowerCase();
  if ((goalId === undefined) !== (goalWorkId === undefined)) throw new Error("Goal-owned CodingTasks require both goalId and goalWorkId.");
  if (goalId && !/^goal_[a-f0-9]{24}$/.test(goalId)) throw new Error("Invalid Goal id for CodingTask membership.");
  if (goalWorkId && !/^work_[a-z0-9][a-z0-9_-]{0,63}$/.test(goalWorkId)) throw new Error("Invalid Goal work id for CodingTask membership.");
  if (input.executor !== "direct" && input.executor !== "codex") throw new Error("Executor must be direct or codex.");
  const identity = await inspectCodingTaskSource(workspace, validateFullGitSha(input.baseSha), guard);
  const store = new CodingTaskStore(config);
  await store.initialize();
  if (isInside(store.dataRoot, identity.sourceRoot)) {
    throw new Error("Coding task data root must be outside the source Git repository.");
  }
  const taskId = `task_${sha256(`${identity.commonDir}\0${taskKey}`).slice(0, 24)}`;
  const fingerprint = sha256([
    "codexpro-coding-task-v1",
    taskKey,
    title,
    goal,
    input.executor,
    identity.baseSha,
    identity.sourceRoot,
    identity.commonDir,
    goalId ?? "",
    goalWorkId ?? "",
    store.paths(taskId).worktreeRoot
  ].join("\0"));
  return store.withTaskLock(taskId, async () => {
    const existing = await store.getIfExists(taskId);
    if (existing) {
      if (existing.createFingerprint !== fingerprint) {
        throw new Error(`Coding task key is already bound to a different creation contract: ${taskKey}`);
      }
      return { task: existing, reused: true };
    }
    const worktreeRoot = await createCodingTaskWorktree(identity, store.paths(taskId).worktreeRoot);
    const now = new Date().toISOString();
    const task: CodingTaskState = {
      version: CODING_TASK_VERSION,
      taskId,
      taskKey,
      createFingerprint: fingerprint,
      title,
      goal,
      ...(goalId && goalWorkId ? { goalId, goalWorkId } : {}),
      executor: input.executor,
      lifecycle: "ready",
      baseSha: identity.baseSha,
      sourceRoot: identity.sourceRoot,
      sourceGitCommonDir: identity.commonDir,
      sourceUncommittedChangesIncluded: false,
      sourceDirtyAtCreation: identity.sourceDirty,
      sourceStatusEntryCountAtCreation: identity.sourceStatusEntryCount,
      worktreeRoot,
      workspaceId: codingTaskWorkspaceId(taskId),
      revision: 1,
      executorLease: {
        owner: input.executor,
        epoch: 1,
        leaseId: newCodingTaskLeaseId(),
        acquiredAt: now
      },
      codexTurnActive: false,
      createdAt: now,
      updatedAt: now,
      events: [{ at: now, kind: "created", executor: input.executor, epoch: 1 }],
      logs: []
    };
    parseCodingTaskState(task, taskId);
    await store.writeLocked(task);
    return { task, reused: false };
  });
}

export async function getCodingTask(config: CodingTaskStoreConfig, taskId: string): Promise<CodingTaskState> {
  return new CodingTaskStore(config).get(taskId);
}

export async function listCodingTasks(
  config: CodingTaskStoreConfig,
  options: CodingTaskListOptions = {}
): Promise<CodingTaskState[]> {
  return new CodingTaskStore(config).list(options);
}

export async function resolveCodingTaskWorkspace(
  config: CodingTaskStoreConfig,
  workspaceId: string,
  guard?: CodingTaskWorkspaceGuard
): Promise<CodingTaskWorkspace> {
  const match = /^taskws_([a-f0-9]{24})$/.exec(workspaceId);
  if (!match) throw new Error("Invalid coding task workspace id.");
  const task = await getCodingTask(config, `task_${match[1]}`);
  if (task.workspaceId !== workspaceId) throw new Error("Coding task workspace identity mismatch.");
  const identity = await inspectCodingTaskSource({ root: task.sourceRoot }, task.baseSha, guard);
  if (identity.commonDir !== task.sourceGitCommonDir) throw new Error("Persisted source Git common-directory identity changed.");
  await assertCodingTaskWorktree(identity, task.worktreeRoot);
  const expectedRoot = new CodingTaskStore(config).paths(task.taskId).worktreeRoot;
  if (task.worktreeRoot !== expectedRoot) throw new Error("Persisted task worktree is outside its deterministic task storage path.");
  return {
    id: task.workspaceId,
    taskId: task.taskId,
    root: task.worktreeRoot,
    openedAt: task.createdAt,
    worktreeRoot: task.worktreeRoot,
    sourceRoot: task.sourceRoot,
    provenanceVerified: true
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function recoverInterruptedState(
  state: CodingTaskState,
  minimumStaleMs: number,
  maxGitOutputBytes?: number
): Promise<CodingTaskState> {
  if (!state.activeOperation) return state;
  const heartbeat = Date.parse(state.activeOperation.heartbeatAt);
  const staleFor = Number.isFinite(heartbeat) ? Date.now() - heartbeat : Number.POSITIVE_INFINITY;
  if (processAlive(state.activeOperation.pid) || staleFor < minimumStaleMs) {
    throw new Error("Cannot transition while the active operation owner is alive or its heartbeat is not stale.");
  }
  const identity = await inspectCodingTaskSource({ root: state.sourceRoot }, state.baseSha);
  if (identity.commonDir !== state.sourceGitCommonDir) throw new Error("Persisted source Git common-directory identity changed.");
  const observation = await observeCodingTaskGit(identity, state.worktreeRoot, maxGitOutputBytes);
  return {
    ...state,
    lifecycle: "failed",
    activeOperation: undefined,
    codexTurnActive: false,
    codexRunnerPid: undefined,
    codexHeartbeatAt: undefined,
    error: `Interrupted ${state.executor} operation recovered after its owner exited and heartbeat became stale.`,
    lastGitObservation: observation,
    events: appendCodingTaskEvent(state.events, {
      kind: "operation_interrupted",
      executor: state.executor,
      epoch: state.executorLease.epoch,
      message: "Dead operation owner recovered after authoritative Git readback."
    })
  };
}

export async function recoverInterruptedCodingTaskOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: CodingTaskCasExpectation & { minimumStaleMs?: number; maxGitOutputBytes?: number }
): Promise<CodingTaskState> {
  return mutateCodingTaskState(config, taskId, input, (state) =>
    recoverInterruptedState(state as CodingTaskState, Math.max(5_000, input.minimumStaleMs ?? 120_000), input.maxGitOutputBytes)
  );
}

export async function transitionCodingTaskExecutor(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  input: TransitionCodingTaskExecutorInput
): Promise<CodingTaskState> {
  const taskId = validateCodingTaskId(taskIdInput);
  const transitionKey = validateCodingTaskKey(input.transitionKey);
  if (input.to !== "direct" && input.to !== "codex") throw new Error("Transition target must be direct or codex.");
  const store = new CodingTaskStore(config);
  return store.withTaskLock(taskId, async () => {
    let state = await store.get(taskId);
    if (
      state.lastTransition?.key === transitionKey && state.lastTransition.to === input.to &&
      state.lastTransition.fromEpoch === input.expectedExecutorEpoch
    ) return state;
    assertExpectation(state, {
      expectedRevision: input.expectedRevision,
      executorEpoch: input.expectedExecutorEpoch,
      ...(input.expectedLeaseId ? { leaseId: input.expectedLeaseId } : {})
    });
    if (state.executor === input.to) throw new Error(`Coding task is already owned by ${input.to}; use the current lease.`);
    if (state.activeOperation) {
      state = await recoverInterruptedState(
        state,
        Math.max(5_000, input.recoverInterruptedAfterMs ?? 120_000),
        input.maxGitOutputBytes
      );
    } else if (state.codexTurnActive) {
      throw new Error("Cannot transition executor ownership while a Codex turn is active.");
    }
    const identity = await inspectCodingTaskSource({ root: state.sourceRoot }, state.baseSha);
    if (identity.commonDir !== state.sourceGitCommonDir) throw new Error("Persisted source Git common-directory identity changed.");
    const observation = await observeCodingTaskGit(identity, state.worktreeRoot, input.maxGitOutputBytes);
    const now = new Date().toISOString();
    const from = state.executor;
    const fromEpoch = state.executorLease.epoch;
    const toEpoch = fromEpoch + 1;
    const next: CodingTaskState = {
      ...state,
      executor: input.to,
      revision: state.revision + 1,
      executorLease: { owner: input.to, epoch: toEpoch, leaseId: newCodingTaskLeaseId(), acquiredAt: now },
      codexTurnActive: false,
      codexRunnerPid: undefined,
      codexHeartbeatAt: undefined,
      updatedAt: now,
      lastGitObservation: observation,
      lastTransition: { key: transitionKey, from, to: input.to, fromEpoch, toEpoch, completedAt: now, observation },
      events: appendCodingTaskEvent(
        appendCodingTaskEvent(state.events, {
          at: now,
          kind: "executor_released",
          executor: from,
          epoch: fromEpoch,
          message: `Ownership released for transition ${transitionKey}.`
        }),
        {
          at: now,
          kind: "executor_acquired",
          executor: input.to,
          epoch: toEpoch,
          message: `Ownership acquired for transition ${transitionKey}.`
        }
      )
    };
    parseCodingTaskState(next, taskId);
    await store.writeLocked(next);
    return next;
  });
}

export async function reviewCodingTask(
  config: CodingTaskStoreConfig,
  taskId: string,
  options: {
    maxGitOutputBytes?: number;
    isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
  } = {}
): Promise<CodingTaskReviewSnapshot> {
  const store = new CodingTaskStore(config);
  return store.withTaskLock(taskId, async () => {
    const state = await store.get(taskId);
    if (state.activeOperation) throw new Error("Review snapshot is unavailable while a coding task operation is active.");
    const identity = await inspectCodingTaskSource({ root: state.sourceRoot }, state.baseSha);
    if (identity.commonDir !== state.sourceGitCommonDir) throw new Error("Persisted source Git common-directory identity changed.");
    return reviewCodingTaskWorktree(identity, state.worktreeRoot, {
      maxOutputBytes: options.maxGitOutputBytes,
      contentPolicy: options.isPathContentAllowed
    });
  });
}

export async function observeCodingTask(
  config: CodingTaskStoreConfig,
  taskId: string,
  scope?: { executor: CodingTaskExecutor; executorEpoch: number; leaseId: string; operationId: string; maxGitOutputBytes?: number }
): Promise<import("./codingTaskState.js").CodingTaskGitObservation> {
  const store = new CodingTaskStore(config);
  return store.withTaskLock(taskId, async () => {
    const state = await store.get(taskId);
    if (scope) {
      assertExpectation(state, {
        expectedRevision: state.revision,
        executor: scope.executor,
        executorEpoch: scope.executorEpoch,
        leaseId: scope.leaseId,
        operationId: scope.operationId
      });
    } else if (state.activeOperation) {
      throw new Error("Unfenced Git observation is unavailable while a coding task operation is active.");
    }
    const identity = await inspectCodingTaskSource({ root: state.sourceRoot }, state.baseSha);
    if (identity.commonDir !== state.sourceGitCommonDir) throw new Error("Persisted source Git common-directory identity changed.");
    return observeCodingTaskGit(identity, state.worktreeRoot, scope?.maxGitOutputBytes);
  });
}

export function appendCodingTaskEvent(
  events: readonly CodingTaskEvent[],
  event: Omit<CodingTaskEvent, "at"> & { at?: string }
): CodingTaskEvent[] {
  const next = [...events, { ...event, at: event.at ?? new Date().toISOString() }];
  return next.slice(-MAX_EVENTS);
}

export function mergeCodingTaskLogs(
  current: readonly CodingTaskLogMetadata[],
  incoming: readonly CodingTaskLogMetadata[]
): CodingTaskLogMetadata[] {
  const byName = new Map(current.map((entry) => [entry.name, entry]));
  for (const entry of incoming) byName.set(entry.name, entry);
  return [...byName.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.name.localeCompare(right.name))
    .slice(-MAX_LOGS);
}

function assertExpectation(state: CodingTaskState, expected: CodingTaskCasExpectation): void {
  if (!Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive integer.");
  }
  if (state.revision !== expected.expectedRevision) {
    throw new Error(`Coding task CAS conflict: expected revision ${expected.expectedRevision}, observed ${state.revision}.`);
  }
  if (expected.executor && state.executor !== expected.executor) {
    throw new Error(`Coding task ownership conflict: expected ${expected.executor}, observed ${state.executor}.`);
  }
  if (expected.executorEpoch !== undefined && state.executorLease.epoch !== expected.executorEpoch) {
    throw new Error(
      `Coding task epoch conflict: expected ${expected.executorEpoch}, observed ${state.executorLease.epoch}.`
    );
  }
  if (expected.leaseId !== undefined && state.executorLease.leaseId !== expected.leaseId) {
    throw new Error("Coding task lease conflict.");
  }
  if (expected.operationId !== undefined && state.activeOperation?.operationId !== expected.operationId) {
    throw new Error("Coding task operation conflict.");
  }
}

export async function mutateCodingTaskState(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  expected: CodingTaskCasExpectation,
  mutate: (current: Readonly<CodingTaskState>) => CodingTaskState | Promise<CodingTaskState>
): Promise<CodingTaskState> {
  const store = new CodingTaskStore(config);
  const taskId = validateCodingTaskId(taskIdInput);
  return store.withTaskLock(taskId, async () => {
    const current = await store.get(taskId);
    assertExpectation(current, expected);
    const candidate = await mutate(structuredClone(current));
    if (candidate.taskId !== current.taskId || candidate.version !== current.version) {
      throw new Error("Coding task mutation cannot change task identity or schema version.");
    }
    if (candidate.revision !== current.revision) {
      throw new Error("Coding task mutation must not assign revision; the store owns revision increments.");
    }
    // A repeated operation key may deliberately return the unchanged snapshot. Preserve true idempotency:
    // no write, timestamp change, or revision increment for the same completed request.
    if (JSON.stringify(candidate) === JSON.stringify(current)) return current;
    const next: CodingTaskState = {
      ...candidate,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      events: candidate.events.slice(-MAX_EVENTS),
      logs: candidate.logs.slice(-MAX_LOGS)
    };
    parseCodingTaskState(next, taskId);
    await store.writeLocked(next);
    return next;
  });
}

export async function assertCodingTaskOwner(
  config: CodingTaskStoreConfig,
  taskId: string,
  expected: Omit<CodingTaskCasExpectation, "expectedRevision"> & { expectedRevision?: number }
): Promise<CodingTaskState> {
  const state = await new CodingTaskStore(config).get(taskId);
  assertExpectation(state, { ...expected, expectedRevision: expected.expectedRevision ?? state.revision });
  return state;
}

export async function assertDirectOwner(
  config: CodingTaskStoreConfig,
  taskId: string,
  expected: { expectedRevision?: number; executorEpoch?: number; leaseId?: string } = {}
): Promise<CodingTaskState> {
  return assertCodingTaskOwner(config, taskId, { ...expected, executor: "direct" });
}

export async function beginCodingTaskOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: BeginCodingTaskOperationInput
): Promise<CodingTaskState> {
  const store = new CodingTaskStore(config);
  const normalizedTaskId = validateCodingTaskId(taskId);
  const requestFingerprint = sha256(JSON.stringify({
    executor: input.executor,
    operationId: input.operationId,
    codexThreadId: input.codexThreadId ?? null,
    codexSessionId: input.codexSessionId ?? null,
    codexTurnId: input.codexTurnId ?? null
  }));
  return store.withTaskLock(normalizedTaskId, async () => {
    const state = await store.get(normalizedTaskId);
    if (state.activeOperation) {
      if (state.activeOperation.operationId === input.operationId && state.activeOperation.executor === input.executor) {
        assertExpectation(state, {
          expectedRevision: state.revision,
          executor: input.executor,
          executorEpoch: input.executorEpoch,
          leaseId: input.leaseId,
          operationId: input.operationId
        });
        if (state.activeOperation.requestFingerprint !== requestFingerprint) throw new Error("Operation id is already bound to a different request.");
        return state;
      }
      throw new Error(`Coding task already has an active ${state.activeOperation.kind} operation.`);
    }
    assertExpectation(state, {
      expectedRevision: input.expectedRevision,
      executor: input.executor,
      executorEpoch: input.executorEpoch,
      leaseId: input.leaseId
    });
    const now = new Date().toISOString();
    const kind = input.executor === "direct" ? "direct" : "codex_run";
    const next: CodingTaskState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      lifecycle: "running",
      activeOperation: {
        operationId: input.operationId,
        executor: input.executor,
        kind,
        startedAt: now,
        heartbeatAt: now,
        pid: input.codexRunnerPid ?? process.pid,
        requestFingerprint
      },
      ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
      ...(input.codexSessionId ? { codexSessionId: input.codexSessionId } : {}),
      ...(input.codexTurnId ? { codexTurnId: input.codexTurnId } : {}),
      ...(input.codexRunnerPid ? { codexRunnerPid: input.codexRunnerPid, codexHeartbeatAt: now } : {}),
      codexTurnActive: input.executor === "codex" && Boolean(input.codexThreadId && input.codexTurnId),
      cancelRequestedAt: undefined,
      cancelReason: undefined,
      startedAt: state.startedAt ?? now,
      finishedAt: undefined,
      events: appendCodingTaskEvent(state.events, {
        kind: input.executor === "codex" ? "codex_turn_started" : "state_updated",
        executor: input.executor,
        epoch: state.executorLease.epoch,
        message: `Operation ${input.operationId} started.`
      })
    };
    parseCodingTaskState(next, normalizedTaskId);
    await store.writeLocked(next);
    return next;
  });
}

export async function heartbeatCodingTaskOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: HeartbeatCodingTaskOperationInput
): Promise<CodingTaskState> {
  return heartbeatCodingTaskOperationFenced(config, taskId, input);
}

export async function heartbeatCodingTaskOperationFenced(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  input: Omit<HeartbeatCodingTaskOperationInput, "expectedRevision"> & { expectedRevision?: number }
): Promise<CodingTaskState> {
  const taskId = validateCodingTaskId(taskIdInput);
  const store = new CodingTaskStore(config);
  return store.withTaskLock(taskId, async () => {
    const state = await store.get(taskId);
    if (!state.activeOperation) throw new Error("Coding task has no active operation to heartbeat.");
    assertExpectation(state, {
      expectedRevision: state.revision,
      executor: input.executor,
      executorEpoch: input.executorEpoch,
      leaseId: input.leaseId,
      operationId: input.operationId
    });
    const now = new Date().toISOString();
    const next: CodingTaskState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      activeOperation: { ...state.activeOperation, heartbeatAt: now },
      ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
      ...(input.codexSessionId ? { codexSessionId: input.codexSessionId } : {}),
      ...(input.codexTurnId ? { codexTurnId: input.codexTurnId } : {}),
      ...(input.executor === "codex" && (input.codexThreadId ?? state.codexThreadId) && (input.codexTurnId ?? state.codexTurnId)
        ? { codexTurnActive: true }
        : {}),
      ...(input.codexRunnerPid ? { codexRunnerPid: input.codexRunnerPid } : {}),
      ...(input.executor === "codex" ? { codexHeartbeatAt: now } : {}),
      logs: input.logs ? mergeCodingTaskLogs(state.logs, input.logs) : state.logs,
      events: input.event ? appendCodingTaskEvent(state.events, input.event) : state.events
    };
    parseCodingTaskState(next, taskId);
    await store.writeLocked(next);
    return next;
  });
}

export async function endCodingTaskOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: EndCodingTaskOperationInput
): Promise<CodingTaskState> {
  return finishCodingTaskOperationFenced(config, taskId, input);
}

export async function finishCodingTaskOperationFenced(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  input: FinishCodingTaskOperationInput
): Promise<CodingTaskState> {
  const taskId = validateCodingTaskId(taskIdInput);
  const store = new CodingTaskStore(config);
  const completionFingerprint = sha256(JSON.stringify({
    executor: input.executor,
    operationId: input.operationId,
    executorEpoch: input.executorEpoch ?? null,
    lifecycle: input.lifecycle,
    resultSummary: input.resultSummary ?? null,
    error: input.error ?? null,
    codexThreadId: input.codexThreadId ?? null,
    codexSessionId: input.codexSessionId ?? null,
    codexTurnId: input.codexTurnId ?? null,
    logs: input.logs ?? [],
    gitObservation: input.gitObservation ?? null
  }));
  return store.withTaskLock(taskId, async () => {
    const state = await store.get(taskId);
    if (!state.activeOperation) {
      if (
        state.lastCompletedOperation?.operationId === input.operationId &&
        state.lastCompletedOperation.executor === input.executor &&
        state.lastCompletedOperation.executorEpoch === input.executorEpoch
      ) {
        if (state.lastCompletedOperation.completionFingerprint !== completionFingerprint) {
          throw new Error("Completed operation id is already bound to a different terminal writeback.");
        }
        return state;
      }
      throw new Error("Coding task has no matching active operation to finish.");
    }
    assertExpectation(state, {
      expectedRevision: state.revision,
      executor: input.executor,
      executorEpoch: input.executorEpoch,
      leaseId: input.leaseId,
      operationId: input.operationId
    });
    let persistedCancellation: CodingTaskCancelRequest | undefined;
    try {
      const candidate = JSON.parse(await fsp.readFile(store.paths(taskId).cancelRequest, "utf8")) as CodingTaskCancelRequest;
      if (
        candidate.version === 1 && candidate.taskId === taskId &&
        candidate.operationId === input.operationId && candidate.executorEpoch === input.executorEpoch &&
        Number.isFinite(Date.parse(candidate.requestedAt))
      ) persistedCancellation = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const effectiveLifecycle = persistedCancellation ? "canceled" : input.lifecycle;
    const now = new Date().toISOString();
    const next: CodingTaskState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      lifecycle: effectiveLifecycle,
      activeOperation: undefined,
      lastCompletedOperation: {
        operationId: input.operationId,
        executor: input.executor,
        executorEpoch: input.executorEpoch!,
        lifecycle: effectiveLifecycle,
        endedAt: now,
        completionFingerprint
      },
      codexTurnActive: false,
      codexRunnerPid: undefined,
      codexHeartbeatAt: undefined,
      cancelRequestedAt: undefined,
      cancelReason: undefined,
      ...(input.codexThreadId ? { codexThreadId: input.codexThreadId } : {}),
      ...(input.codexSessionId ? { codexSessionId: input.codexSessionId } : {}),
      ...(input.codexTurnId ? { codexTurnId: input.codexTurnId } : {}),
      resultSummary: input.resultSummary?.slice(0, 20_000),
      error: input.error?.slice(0, 20_000),
      finishedAt: effectiveLifecycle === "ready" || effectiveLifecycle === "waiting_review" ? undefined : now,
      logs: input.logs ? mergeCodingTaskLogs(state.logs, input.logs) : state.logs,
      lastGitObservation: input.gitObservation ?? state.lastGitObservation,
      events: appendCodingTaskEvent(state.events, {
        kind: input.executor === "codex" ? "codex_turn_finished" : "state_updated",
        executor: input.executor,
        epoch: state.executorLease.epoch,
        message: persistedCancellation
          ? `Operation ${input.operationId} finished as canceled because its durable cancellation request won the operation fence.`
          : `Operation ${input.operationId} finished as ${effectiveLifecycle}.`
      })
    };
    parseCodingTaskState(next, taskId);
    await store.writeLocked(next);
    return next;
  });
}

export async function beginDirectOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: Omit<BeginCodingTaskOperationInput, "executor" | "codexThreadId" | "codexSessionId" | "codexTurnId">
): Promise<CodingTaskState> {
  return beginCodingTaskOperation(config, taskId, { ...input, executor: "direct" });
}

export async function endDirectOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: Omit<EndCodingTaskOperationInput, "executor" | "codexThreadId" | "codexSessionId" | "codexTurnId">
): Promise<CodingTaskState> {
  return endCodingTaskOperation(config, taskId, { ...input, executor: "direct" });
}

export async function finishDirectOperation(
  config: CodingTaskStoreConfig,
  taskId: string,
  input: Omit<FinishCodingTaskOperationInput, "executor" | "codexThreadId" | "codexSessionId" | "codexTurnId">
): Promise<CodingTaskState> {
  return finishCodingTaskOperationFenced(config, taskId, { ...input, executor: "direct" });
}

export async function requestCodingTaskCancellation(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  input: CodingTaskCancelInput
): Promise<{ state: CodingTaskState; request: CodingTaskCancelRequest }> {
  const taskId = validateCodingTaskId(taskIdInput);
  const store = new CodingTaskStore(config);
  return store.withTaskLock(taskId, async () => {
    const current = await store.get(taskId);
    const paths = store.paths(taskId);
    let existing: CodingTaskCancelRequest | undefined;
    try {
      existing = JSON.parse(await fsp.readFile(paths.cancelRequest, "utf8")) as CodingTaskCancelRequest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const normalizedReason = input.reason?.trim().slice(0, 1_000);
    if (
      existing?.version === 1 && existing.taskId === taskId &&
      existing.operationId === input.operationId && existing.executorEpoch === input.executorEpoch &&
      Number.isFinite(Date.parse(existing.requestedAt))
    ) {
      if ((existing.reason ?? "") !== (normalizedReason ?? "")) {
        throw new Error("Cancellation is already recorded for this operation epoch with a different reason.");
      }
      const request = existing;
      if (!current.activeOperation) return { state: current, request };
      if (current.cancelRequestedAt === existing.requestedAt && current.cancelReason === existing.reason) {
        return { state: current, request };
      }
      const repaired: CodingTaskState = {
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        cancelRequestedAt: existing.requestedAt,
        cancelReason: existing.reason
      };
      parseCodingTaskState(repaired, taskId);
      await store.writeLocked(repaired);
      return { state: repaired, request };
    }
    if (!current.activeOperation) throw new Error("Coding task has no active operation to cancel.");
    assertExpectation(current, {
      expectedRevision: current.revision,
      executor: input.executor,
      executorEpoch: input.executorEpoch,
      leaseId: input.leaseId,
      operationId: input.operationId
    });
    const request: CodingTaskCancelRequest = {
      version: 1,
      taskId,
      operationId: input.operationId,
      executorEpoch: input.executorEpoch,
      requestedAt: new Date().toISOString(),
      ...(normalizedReason ? { reason: normalizedReason } : {})
    };
    await writeCodingTaskJsonAtomic(paths.cancelRequest, request);
    const next: CodingTaskState = {
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      cancelRequestedAt: request.requestedAt,
      cancelReason: request.reason
    };
    parseCodingTaskState(next, taskId);
    await store.writeLocked(next);
    return { state: next, request };
  });
}

export async function readCodingTaskCancellation(
  config: CodingTaskStoreConfig,
  taskIdInput: string,
  scope: { operationId: string; executorEpoch: number }
): Promise<CodingTaskCancelRequest | undefined> {
  const taskId = validateCodingTaskId(taskIdInput);
  let parsed: CodingTaskCancelRequest;
  try {
    parsed = JSON.parse(await fsp.readFile(new CodingTaskStore(config).paths(taskId).cancelRequest, "utf8")) as CodingTaskCancelRequest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    parsed.version !== 1 || parsed.taskId !== taskId || parsed.operationId !== scope.operationId ||
    parsed.executorEpoch !== scope.executorEpoch || !Number.isFinite(Date.parse(parsed.requestedAt))
  ) return undefined;
  return parsed;
}

export function newCodingTaskLeaseId(): string {
  return `lease_${randomUUID()}`;
}
