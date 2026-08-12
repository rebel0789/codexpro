#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beginCodingTaskOperation, createCodingTask, finishCodingTaskOperationFenced, getCodingTask, requestCodingTaskCancellation, reviewCodingTask, transitionCodingTaskExecutor } from "./codingTaskOps.js";
import { cancelQueuedCodingTaskRun, getCodingTaskContinuation, getCodingTaskRun, launchCodingTaskRun, reconcileCodingTaskRun, submitCodingTaskContinuation, type CodingTaskRunView } from "./codingTaskRunner.js";
import { secureCodingTaskDirectory, writeCodingTaskJsonAtomic } from "./codingTaskStore.js";
import { GoalStore, type GoalStoreConfig } from "./goalStore.js";
import { assertGoalContentPolicySnapshot, isGoalPathContentAllowed, unionGoalContentPolicySnapshots } from "./goalPolicy.js";
import { buildGoalWorkerPrompt } from "./goalPrompt.js";
import { applyGoalWorkerPatch, ensureGoalIntegrationWorktree, getGoalIntegrationHead } from "./goalWorktree.js";
import { computeGoalInitialIntentFingerprint, parseGoalState, validateGoalId, type GoalContentPolicySnapshot, type GoalSchedulerAuthority, type GoalState, type GoalWorkItem, type GoalWorkTurn } from "./goalState.js";
import { minimatch } from "minimatch";
import { assertGoalContractIntegrity } from "./goalOps.js";

const SCHEDULER_VERSION = 1 as const;
const SCHEDULER_PATH = fileURLToPath(new URL("./goalScheduler.js", import.meta.url));
const DEFINITION_MAX_BYTES = 256 * 1024;
const RUNTIME_MAX_BYTES = 32 * 1024;
const POLL_MS = 250;

export interface GoalSchedulerConfig extends GoalStoreConfig {
  codexBinary: string;
  codexDir: string;
  maxOutputBytes: number;
}

export interface StartPersistentGoalInput {
  expectedRevision: number;
  startKey: string;
  runtimeContentPolicy?: GoalContentPolicySnapshot;
}

export interface ResumePersistentGoalInput {
  expectedRevision: number;
  resumeKey: string;
  runtimeContentPolicy?: GoalContentPolicySnapshot;
}

export interface CancelPersistentGoalInput {
  expectedRevision: number;
  cancelKey: string;
  reason?: string;
}

export interface GoalSchedulerDefinition {
  version: typeof SCHEDULER_VERSION;
  goalId: string;
  startKey: string;
  fingerprint: string;
  contractFingerprint: string;
  dataRoot: string;
  codexBinary: string;
  codexBinaryIdentity: { device: number; inode: number; size: number; mtimeMs: number; mode: number };
  codexDir: string;
  maxOutputBytes: number;
  contentPolicy: GoalContentPolicySnapshot;
  createdAt: string;
}

export interface GoalSchedulerRuntime {
  version: typeof SCHEDULER_VERSION;
  goalId: string;
  definitionFingerprint: string;
  epoch: number;
  leaseId: string;
  status: "starting" | "running" | "stopped" | "failed";
  pid: number;
  processNonce: string;
  startedAt: string;
  heartbeatAt: string;
  stoppedAt?: string;
  stopReason?: string;
  error?: string;
}

export interface GoalSchedulerView {
  goal: GoalState;
  definition?: GoalSchedulerDefinition;
  runtime?: GoalSchedulerRuntime;
  schedulerAlive: boolean;
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function key(value: string, name: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(normalized)) throw new Error(`${name} must be 1-160 safe identifier characters.`);
  return normalized;
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 20_000); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function opId(goalId: string, workId: string, turnIndex = 1): string { return `goal:${goalId.slice(5)}:${workId}:run:${turnIndex}`; }
function continuationKey(goalId: string, workId: string, turnIndex: number): string { return `goal:${goalId}:${workId}:turn:${turnIndex}`; }
function launchKey(goalId: string, workId: string): string { return `goal:${goalId}:${workId}:launch:1`; }
function integrationKey(goalId: string, workId: string): string { return `goal:${goalId}:${workId}:integrate:1`; }
function taskKey(goalId: string, workId: string): string { return `goal:${goalId}:${workId}`; }
function deterministicTaskId(goal: GoalState, workId: string): string { return `task_${sha256(`${goal.sourceGitCommonDir}\0${taskKey(goal.goalId, workId)}`).slice(0, 24)}`; }
async function retireCanceledTask(config: GoalStoreConfig, task: Awaited<ReturnType<typeof getCodingTask>>, goalId: string, workId: string): Promise<void> {
  if (task.executor !== "codex" || task.activeOperation) return;
  await transitionCodingTaskExecutor(config, task.taskId, { expectedRevision: task.revision, expectedExecutorEpoch: task.executorLease.epoch, expectedLeaseId: task.executorLease.leaseId, transitionKey: `goal:${goalId}:${workId}:cancel-retire`, to: "direct" });
}

function definitionPayload(value: Omit<GoalSchedulerDefinition, "fingerprint">): string {
  return JSON.stringify(value);
}

function assertDefinition(value: unknown, expectedGoalId?: string): asserts value is GoalSchedulerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Goal scheduler definition.");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || validateGoalId(String(item.goalId ?? "")) !== (expectedGoalId ? validateGoalId(expectedGoalId) : item.goalId)) throw new Error("Invalid Goal scheduler definition identity.");
  if (typeof item.startKey !== "string" || typeof item.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.fingerprint) || typeof item.contractFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(item.contractFingerprint)) throw new Error("Invalid Goal scheduler definition fingerprint.");
  if (typeof item.dataRoot !== "string" || !path.isAbsolute(item.dataRoot) || typeof item.codexBinary !== "string" || !item.codexBinary || typeof item.codexDir !== "string" || !path.isAbsolute(item.codexDir)) throw new Error("Invalid Goal scheduler definition paths.");
  if (!Number.isSafeInteger(item.maxOutputBytes) || (item.maxOutputBytes as number) < 65_536 || (item.maxOutputBytes as number) > 104_857_600) throw new Error("Invalid Goal scheduler output bound.");
  const identity = item.codexBinaryIdentity as Record<string, unknown> | undefined;
  if (!identity || ![identity.device, identity.inode, identity.size, identity.mtimeMs, identity.mode].every((field) => typeof field === "number" && Number.isFinite(field))) throw new Error("Invalid Goal scheduler executable identity.");
  assertGoalContentPolicySnapshot(item.contentPolicy as GoalContentPolicySnapshot);
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error("Invalid Goal scheduler creation time.");
  const { fingerprint, ...payload } = item as unknown as GoalSchedulerDefinition;
  if (sha256(`codexpro-goal-scheduler-v1\0${definitionPayload(payload)}`) !== fingerprint) throw new Error("Goal scheduler definition fingerprint mismatch.");
}

function assertRuntime(value: GoalSchedulerRuntime, goalId: string): void {
  if (!value || value.version !== 1 || value.goalId !== goalId || !/^[0-9a-f]{64}$/.test(value.definitionFingerprint) || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || typeof value.leaseId !== "string" || !value.leaseId || !["starting", "running", "stopped", "failed"].includes(value.status) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.processNonce !== "string" || value.processNonce.length < 16 || value.processNonce.length > 160 || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.heartbeatAt)) || (value.stoppedAt !== undefined && !Number.isFinite(Date.parse(value.stoppedAt)))) {
    throw new Error("Invalid Goal scheduler runtime authority.");
  }
  if (["stopped", "failed"].includes(value.status) && !value.stoppedAt) throw new Error("Terminal Goal scheduler runtime is missing stoppedAt.");
  if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 20_000 || value.error.includes("\0"))) throw new Error("Invalid Goal scheduler runtime error.");
}

async function boundedJson<T>(filename: string, max: number): Promise<T | undefined> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max || (stat.mode & 0o077) !== 0) throw new Error(`Unsafe or oversized Goal scheduler artifact: ${filename}`);
    return JSON.parse(await handle.readFile("utf8")) as T;
  } finally { await handle.close(); }
}

async function publishImmutable(filename: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > DEFINITION_MAX_BYTES) throw new Error("Goal scheduler definition exceeds 256KiB.");
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await secureCodingTaskDirectory(path.dirname(filename), "Goal scheduler directory");
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    try { await fsp.link(temporary, filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await fsp.unlink(temporary).catch(() => undefined); }
  if (await fsp.readFile(filename, "utf8") !== text) throw new Error("Goal scheduler definition is already bound to another contract.");
}

async function readDefinition(store: GoalStore, goalId: string): Promise<GoalSchedulerDefinition | undefined> {
  const state = await store.get(goalId);
  if (!state.scheduler) return undefined;
  const definition = await boundedJson<GoalSchedulerDefinition>(store.schedulerDefinitionPath(goalId, state.scheduler.definitionFingerprint), DEFINITION_MAX_BYTES);
  if (definition) assertDefinition(definition, goalId);
  return definition;
}

function runtimeEnv(definition: GoalSchedulerDefinition): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    LANG: "C", LC_ALL: "C", NO_COLOR: "1", CODEX_HOME: definition.codexDir
  };
}

async function spawnScheduler(definition: GoalSchedulerDefinition, definitionPath: string): Promise<number> {
  await assertExecutableIdentity(definition);
  const child = spawn(process.execPath, [SCHEDULER_PATH, definitionPath, definition.dataRoot], {
    cwd: definition.dataRoot, env: runtimeEnv(definition), shell: false, stdio: "ignore", detached: true, windowsHide: true
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  if (!child.pid) throw new Error("Persistent Goal scheduler did not receive a process identity.");
  child.unref();
  return child.pid;
}

async function assertExecutableIdentity(definition: GoalSchedulerDefinition): Promise<void> {
  const stat = await fsp.lstat(definition.codexBinary);
  if (!stat.isFile() || stat.isSymbolicLink() || await fsp.realpath(definition.codexBinary) !== definition.codexBinary || (stat.mode & 0o111) === 0) throw new Error("Persistent Goal Codex binary must remain an executable canonical regular file.");
  const expected = definition.codexBinaryIdentity;
  if (stat.dev !== expected.device || stat.ino !== expected.inode || stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs || stat.mode !== expected.mode) throw new Error("Persistent Goal Codex binary identity changed after scheduler approval.");
  const dirStat = await fsp.lstat(definition.codexDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || await fsp.realpath(definition.codexDir) !== definition.codexDir) throw new Error("Persistent Goal CODEX_HOME must be a canonical real directory.");
}

async function makeDefinition(config: GoalSchedulerConfig, goal: GoalState, startKey: string, runtimePolicy?: GoalContentPolicySnapshot): Promise<GoalSchedulerDefinition> {
  if (!goal.contentPolicy) throw new Error("Persistent Goal is missing its approved content policy.");
  assertGoalContractIntegrity(goal);
  if (!path.isAbsolute(config.codexBinary) || path.resolve(config.codexBinary) !== config.codexBinary) throw new Error("Persistent Goal Codex binary must be an absolute canonical path.");
  const stat = await fsp.lstat(config.codexBinary);
  if (!stat.isFile() || stat.isSymbolicLink() || await fsp.realpath(config.codexBinary) !== config.codexBinary || (stat.mode & 0o111) === 0) throw new Error("Persistent Goal Codex binary must be an executable canonical regular file.");
  const codexDir = path.resolve(config.codexDir);
  const dirStat = await fsp.lstat(codexDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || await fsp.realpath(codexDir) !== codexDir) throw new Error("Persistent Goal CODEX_HOME must be a canonical real directory.");
  const payload: Omit<GoalSchedulerDefinition, "fingerprint"> = {
    version: 1, goalId: goal.goalId, startKey, contractFingerprint: goal.contractFingerprint, dataRoot: path.resolve(config.dataRoot), codexBinary: config.codexBinary,
    codexBinaryIdentity: { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode },
    codexDir, maxOutputBytes: config.maxOutputBytes,
    contentPolicy: unionGoalContentPolicySnapshots(goal.contentPolicy, runtimePolicy), createdAt: goal.createdAt
  };
  return { ...payload, fingerprint: sha256(`codexpro-goal-scheduler-v1\0${definitionPayload(payload)}`) };
}

async function queueScheduler(config: GoalSchedulerConfig, goalId: string, input: StartPersistentGoalInput | ResumePersistentGoalInput, resume: boolean): Promise<{ goal: GoalState; definition: GoalSchedulerDefinition; reused: boolean }> {
  if (process.platform === "win32") throw new Error("Persistent Goal scheduling requires POSIX advisory locking.");
  const store = new GoalStore(config);
  const requestedKey = key(resume ? (input as ResumePersistentGoalInput).resumeKey : (input as StartPersistentGoalInput).startKey, resume ? "Goal resume key" : "Goal start key");
  let existingGoal = await store.get(goalId);
  if (existingGoal.executionPolicy !== "persistent" || existingGoal.workspacePolicy !== "isolated") throw new Error("Only an approved persistent isolated Goal can use the detached scheduler.");
  const durableStartKey = resume ? existingGoal.startKey : requestedKey;
  if (!durableStartKey) throw new Error("Persistent Goal resume requires a prior start authority.");
  const definition = await makeDefinition(config, existingGoal, durableStartKey, input.runtimeContentPolicy);
  const definitionText = `${JSON.stringify(definition, null, 2)}\n`;
  const definitionPath = store.schedulerDefinitionPath(goalId, definition.fingerprint);
  const fastIdempotent = existingGoal.scheduler?.definitionFingerprint === definition.fingerprint && ((!resume && existingGoal.startKey === requestedKey) || (resume && existingGoal.resumeKey === requestedKey && existingGoal.lifecycle === "running"));
  if (fastIdempotent) {
    await publishImmutable(definitionPath, definitionText);
    if (!["waiting_review", "canceled", "failed", "completed", "paused"].includes(existingGoal.lifecycle)) await spawnScheduler(definition, definitionPath);
    return { goal: existingGoal, definition, reused: true };
  }
  if (existingGoal.scheduler && existingGoal.scheduler.definitionFingerprint !== definition.fingerprint && ((!resume && existingGoal.startKey === requestedKey) || (resume && existingGoal.lifecycle === "paused"))) {
    const oldDefinition = await readDefinition(store, goalId);
    if (!oldDefinition) throw new Error("Existing persistent scheduler definition is missing.");
    const nextGlobs = new Set(definition.contentPolicy.blockedGlobs);
    if (oldDefinition.contentPolicy.blockedGlobs.some((glob) => !nextGlobs.has(glob))) throw new Error("Persistent scheduler content policy cannot be loosened during recovery.");
    const upgraded = await store.tryWithSchedulerLock(goalId, async () => store.withGoalLock(goalId, async () => {
      const state = await store.get(goalId); assertGoalContractIntegrity(state);
      if (state.scheduler?.definitionFingerprint !== oldDefinition.fingerprint || (!resume && state.startKey !== requestedKey)) throw new Error("Persistent scheduler recovery authority changed.");
      if (resume ? state.lifecycle !== "paused" : state.lifecycle !== "running") throw new Error(resume ? "Only explicit persistent resume may adopt stricter policy while paused." : "Paused persistent Goals require resumePersistentGoal before scheduler recovery.");
      await publishImmutable(definitionPath, definitionText);
      const now = new Date().toISOString();
      const next: GoalState = { ...state, lifecycle: "running", ...(resume ? { resumeKey: requestedKey } : {}), scheduler: { epoch: state.scheduler.epoch + 1, leaseId: randomUUID(), startKey: durableStartKey, definitionFingerprint: definition.fingerprint, status: "queued", requestedAt: now }, revision: state.revision + 1, updatedAt: now, events: [...state.events, { at: now, kind: "scheduler_updated" as const, message: `Persistent scheduler ${resume ? "resume" : "recovery"} adopted a monotonic stricter content policy.` }].slice(-500) };
      await store.writeLocked(next); return next;
    }));
    if (!upgraded.acquired) throw new Error("Persistent scheduler is still active; retry stricter policy recovery after it releases authority.");
    await spawnScheduler(definition, definitionPath);
    return { goal: upgraded.value, definition, reused: true };
  }
  const updated = await store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.executionPolicy !== "persistent" || state.workspacePolicy !== "isolated") throw new Error("Goal is not a persistent isolated contract.");
    assertGoalContractIntegrity(state);
    if (definition.contractFingerprint !== state.contractFingerprint) throw new Error("Goal scheduler definition contract fingerprint mismatch.");
    const idempotent = (!resume && state.startKey === requestedKey && state.scheduler?.definitionFingerprint === definition.fingerprint) || (resume && state.resumeKey === requestedKey && state.scheduler?.definitionFingerprint === definition.fingerprint && state.lifecycle === "running");
    if (idempotent) {
      await publishImmutable(definitionPath, definitionText);
      if (!["waiting_review", "canceled", "failed", "completed", "paused"].includes(state.lifecycle)) {
        await ensureGoalIntegrationWorktree(state);
        await spawnScheduler(definition, definitionPath);
      }
      return { goal: state, reused: true };
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (resume) {
      if (state.lifecycle !== "paused") throw new Error("Only a paused persistent Goal can be resumed.");
    } else if (state.lifecycle !== "approved" || state.approval.status !== "approved") throw new Error("Persistent Goal start requires an approved contract.");
    const now = new Date().toISOString();
    const epoch = (state.scheduler?.epoch ?? 0) + 1;
    const authority: GoalSchedulerAuthority = {
      epoch, leaseId: randomUUID(), startKey: durableStartKey, definitionFingerprint: definition.fingerprint,
      status: "queued", requestedAt: now
    };
    await publishImmutable(definitionPath, definitionText);
    const goal: GoalState = {
      ...state, startKey: durableStartKey, ...(resume ? { resumeKey: requestedKey } : {}), lifecycle: "running", scheduler: authority,
      integrationHeadSha: state.integrationHeadSha ?? state.baseSha, startedAt: state.startedAt ?? now,
      work: state.work.map((work) => work.status === "planned" && work.dependsOn.length === 0 ? { ...work, status: "ready" as const } : work),
      revision: state.revision + 1, updatedAt: now,
      events: [...state.events, { at: now, kind: resume ? "resumed" as const : "started" as const, message: resume ? "Persistent Goal scheduler wake requested." : "Persistent Goal scheduler start requested." }].slice(-500)
    };
    parseGoalState(goal, goalId);
    await store.writeLocked(goal);
    await ensureGoalIntegrationWorktree(goal);
    await spawnScheduler(definition, definitionPath);
    return { goal, reused: false };
  });
  return { goal: updated.goal, definition, reused: updated.reused };
}

export async function startPersistentGoal(config: GoalSchedulerConfig, goalIdInput: string, input: StartPersistentGoalInput): Promise<{ goal: GoalState; definition: GoalSchedulerDefinition; reused: boolean }> {
  return queueScheduler(config, validateGoalId(goalIdInput), input, false);
}

export async function resumePersistentGoal(config: GoalSchedulerConfig, goalIdInput: string, input: ResumePersistentGoalInput): Promise<{ goal: GoalState; definition: GoalSchedulerDefinition; reused: boolean }> {
  const goalId = validateGoalId(goalIdInput);
  const store = new GoalStore(config);
  const observed = await store.get(goalId);
  let normalizedInput = input;
  if (observed.lifecycle === "paused") {
    if (observed.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${observed.revision}.`);
    // Linearize behind the old scheduler owner. That owner persists its terminal runtime
    // before releasing this lock, so it cannot overwrite the new resume authority.
    await store.withSchedulerLock(goalId, async () => undefined);
    const quiescent = await store.get(goalId);
    if (quiescent.revision !== observed.revision) {
      const exactSchedulerStop = quiescent.revision === observed.revision + 1 && quiescent.lifecycle === "paused" && quiescent.pauseKey === observed.pauseKey && quiescent.scheduler?.status === "stopped" && quiescent.scheduler.stopReason === "paused" && quiescent.scheduler.epoch === observed.scheduler?.epoch && quiescent.scheduler.leaseId === observed.scheduler?.leaseId;
      if (!exactSchedulerStop) throw new Error(`Goal revision conflict while waiting for scheduler quiescence: expected ${observed.revision} or its exact paused-stop successor, found ${quiescent.revision}.`);
    }
    normalizedInput = { ...input, expectedRevision: quiescent.revision };
  }
  return queueScheduler(config, goalId, normalizedInput, true);
}

export async function requestPersistentGoalCancel(config: GoalStoreConfig, goalIdInput: string, input: CancelPersistentGoalInput): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput); const cancelKey = key(input.cancelKey, "Goal cancel key"); const store = new GoalStore(config);
  const goal = await store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    const reason = input.reason?.trim().slice(0, 2_000);
    if (state.cancelRequest?.cancelKey === cancelKey) {
      if ((state.cancelRequest.reason ?? undefined) !== (reason || undefined)) throw new Error("Goal cancel key is already bound to a different reason.");
      return state;
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (state.executionPolicy !== "persistent" || !["running", "paused"].includes(state.lifecycle)) throw new Error("Only a running or paused persistent Goal can be canceled.");
    const now = new Date().toISOString();
    const next: GoalState = { ...state, lifecycle: "canceling", cancelKey, cancelRequest: { cancelKey, ...(reason ? { reason } : {}), requestedAt: now }, revision: state.revision + 1, updatedAt: now, events: [...state.events, { at: now, kind: "cancel_requested" as const, message: "Persistent Goal cancellation requested; scheduler will drain fenced workers." }].slice(-500) };
    await store.writeLocked(next); return next;
  });
  let reconciled = await reconcilePersistentGoalCancellation(config, goalId);
  const deadline = Date.now() + 10_000;
  while (reconciled.lifecycle === "canceling" && Date.now() < deadline) {
    await wait(100);
    reconciled = await reconcilePersistentGoalCancellation(config, goalId);
  }
  return reconciled;
}

export async function reconcilePersistentGoalCancellation(config: GoalStoreConfig, goalIdInput: string): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput); const store = new GoalStore(config); let state = await store.get(goalId);
  if (state.lifecycle === "canceled") return state;
  if (state.lifecycle !== "canceling" || !state.cancelRequest) throw new Error("Goal has no persistent cancellation request to reconcile.");
  let allTerminal = true;
  for (const work of state.work) {
    const taskId = work.codingTaskId ?? work.launch?.taskId;
    const operationId = work.operationId ?? work.launch?.operationId;
    if (!taskId || !operationId || !work.launch || ["integrated", "canceled", "failed"].includes(work.status)) continue;
    let task: Awaited<ReturnType<typeof getCodingTask>>;
    try { task = await getCodingTask(config, taskId); }
    catch (error) {
      if ((error instanceof Error && error.message.startsWith("Coding task not found:")) && work.status === "launching" && !work.codingTaskId) continue;
      throw new Error(`Could not authoritatively reconcile cancellation for ${work.workId}: ${errorText(error)}`);
    }
    if (task.goalId !== goalId || task.goalWorkId !== work.workId) throw new Error(`Cancellation refused CodingTask membership mismatch for ${work.workId}.`);
    let run: CodingTaskRunView;
    try { run = await getCodingTaskRun(config, taskId, operationId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && ["launching", "continuing"].includes(work.status)) {
        if (task.lastCompletedOperation?.operationId === operationId && task.lifecycle === "canceled" && !task.activeOperation) { await retireCanceledTask(config, task, goalId, work.workId); continue; }
        if (task.activeOperation && (task.activeOperation.operationId !== operationId || task.activeOperation.executor !== "codex")) throw new Error(`Unstarted child ${work.workId} has divergent active operation authority.`);
        const begun = task.activeOperation ? task : await beginCodingTaskOperation(config, taskId, { expectedRevision: task.revision, executor: "codex", executorEpoch: task.executorLease.epoch, leaseId: task.executorLease.leaseId, operationId });
        const finished = await finishCodingTaskOperationFenced(config, taskId, { executor: "codex", executorEpoch: begun.executorLease.epoch, leaseId: begun.executorLease.leaseId, operationId, lifecycle: "canceled", error: state.cancelRequest.reason ?? `Goal ${goalId} canceled before worker launch.` });
        await retireCanceledTask(config, finished, goalId, work.workId);
        continue;
      }
      throw new Error(`Could not authoritatively read run for ${work.workId}: ${errorText(error)}`);
    }
    if (["queued", "running"].includes(run.status)) {
      allTerminal = false;
      if (task.activeOperation?.operationId === operationId) await requestCodingTaskCancellation(config, taskId, { executor: "codex", executorEpoch: task.executorLease.epoch, leaseId: task.executorLease.leaseId, operationId, reason: state.cancelRequest.reason ?? `Goal ${goalId} canceled` });
      else if (run.status === "queued" && !run.runnerAlive) await cancelQueuedCodingTaskRun(config, taskId, operationId, state.cancelRequest.reason);
      else throw new Error(`Goal worker ${work.workId} is active without matching cancellable authority.`);
      continue;
    }
    if (task.activeOperation?.operationId === operationId) {
      await requestCodingTaskCancellation(config, taskId, { executor: "codex", executorEpoch: task.executorLease.epoch, leaseId: task.executorLease.leaseId, operationId, reason: state.cancelRequest.reason ?? `Goal ${goalId} canceled` });
      await reconcileCodingTaskRun(config, taskId, operationId, { relaunchQueued: false, staleMs: 0 });
      const reconciledTask = await getCodingTask(config, taskId);
      if (reconciledTask.activeOperation?.operationId === operationId) { allTerminal = false; continue; }
      await retireCanceledTask(config, reconciledTask, goalId, work.workId);
      continue;
    }
    await retireCanceledTask(config, task, goalId, work.workId);
  }
  if (!allTerminal) return store.get(goalId);
  return store.withGoalLock(goalId, async () => {
    state = await store.get(goalId); if (state.lifecycle === "canceled") return state;
    if (state.lifecycle !== "canceling" || !state.cancelRequest) throw new Error("Goal cancellation authority changed during reconciliation.");
    const now = new Date().toISOString();
    const next: GoalState = { ...state, lifecycle: "canceled", finishedAt: now, ...(state.scheduler ? { scheduler: { ...state.scheduler, status: "stopped" as const, acquiredAt: state.scheduler.acquiredAt ?? now, stoppedAt: now, stopReason: "canceled" as const, error: undefined } } : {}), revision: state.revision + 1, updatedAt: now, work: state.work.map((work) => work.status === "integrated" ? work : { ...work, status: "canceled" as const, finishedAt: work.finishedAt ?? now }), events: [...state.events, { at: now, kind: "canceled" as const, message: "Persistent Goal child operations were authoritatively drained before cancellation." }].slice(-500) };
    await store.writeLocked(next); return next;
  });
}

export async function getPersistentGoalScheduler(config: GoalStoreConfig, goalIdInput: string): Promise<GoalSchedulerView> {
  const goalId = validateGoalId(goalIdInput); const store = new GoalStore(config); const goal = await store.get(goalId);
  const definition = await readDefinition(store, goalId);
  const runtime = await boundedJson<GoalSchedulerRuntime>(store.paths(goalId).schedulerRuntime, RUNTIME_MAX_BYTES);
  if (runtime) assertRuntime(runtime, goalId);
  const schedulerAlive = Boolean(runtime && ["starting", "running"].includes(runtime.status) && alive(runtime.pid) && Date.now() - Date.parse(runtime.heartbeatAt) < 5_000);
  return { goal, ...(definition ? { definition } : {}), ...(runtime ? { runtime } : {}), schedulerAlive };
}

function schedulerFence(state: GoalState, authority: GoalSchedulerAuthority): boolean {
  return state.executionPolicy === "persistent" && state.scheduler?.epoch === authority.epoch && state.scheduler.leaseId === authority.leaseId && state.scheduler.definitionFingerprint === authority.definitionFingerprint;
}

function pathAllowed(pathname: string, goal: GoalState, work: GoalWorkItem, policy: GoalContentPolicySnapshot): boolean {
  const goalAllowed = goal.permissions.fileGlobs.some((pattern) => minimatch(pathname, pattern, { dot: true, nocase: false }));
  const workAllowed = !work.fileGlobs.length || work.fileGlobs.some((pattern) => minimatch(pathname, pattern, { dot: true, nocase: false }));
  return goalAllowed && workAllowed && isGoalPathContentAllowed(policy, pathname);
}

async function updateRuntime(store: GoalStore, runtime: GoalSchedulerRuntime): Promise<void> {
  assertRuntime(runtime, runtime.goalId);
  const text = JSON.stringify(runtime); if (Buffer.byteLength(text) > RUNTIME_MAX_BYTES) throw new Error("Goal scheduler runtime exceeds 32KiB.");
  await writeCodingTaskJsonAtomic(store.paths(runtime.goalId).schedulerRuntime, runtime);
}

async function claimScheduler(store: GoalStore, definition: GoalSchedulerDefinition): Promise<{ goal: GoalState; authority: GoalSchedulerAuthority; acquiredAuthority: boolean }> {
  return store.withGoalLock(definition.goalId, async () => {
    const state = await store.get(definition.goalId);
    assertGoalContractIntegrity(state);
    if (state.contractFingerprint !== definition.contractFingerprint) throw new Error("Goal scheduler definition no longer matches the approved Goal contract.");
    const old = state.scheduler;
    if (!old || old.definitionFingerprint !== definition.fingerprint || old.startKey !== definition.startKey) throw new Error("Goal scheduler definition has no matching persisted authority.");
    if (["waiting_review", "completed", "failed", "canceled", "paused"].includes(state.lifecycle)) return { goal: state, authority: old, acquiredAuthority: false };
    const now = new Date().toISOString();
    const authority: GoalSchedulerAuthority = old.status === "queued"
      ? { ...old, status: "running", acquiredAt: now, stoppedAt: undefined, stopReason: undefined, error: undefined }
      : { ...old, epoch: old.epoch + 1, leaseId: randomUUID(), status: "running", acquiredAt: now, stoppedAt: undefined, stopReason: undefined, error: undefined };
    const next: GoalState = { ...state, scheduler: authority, revision: state.revision + 1, updatedAt: now, events: [...state.events, { at: now, kind: "scheduler_updated" as const, message: `Persistent scheduler epoch ${authority.epoch} acquired.` }].slice(-500) };
    await store.writeLocked(next); return { goal: next, authority, acquiredAuthority: true };
  });
}

async function persistStop(store: GoalStore, goalId: string, authority: GoalSchedulerAuthority, reason: NonNullable<GoalSchedulerAuthority["stopReason"]>, error?: unknown): Promise<GoalState> {
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId); if (!schedulerFence(state, authority)) return state;
    if (state.scheduler?.status === "stopped" && state.scheduler.stopReason === reason) return state;
    const now = new Date().toISOString();
    const next: GoalState = { ...state, ...(error ? { lifecycle: "failed" as const, error: errorText(error), finishedAt: now } : {}), scheduler: { ...authority, status: error ? "failed" : "stopped", stoppedAt: now, stopReason: reason, ...(error ? { error: errorText(error) } : {}) }, revision: state.revision + 1, updatedAt: now };
    await store.writeLocked(next); return next;
  });
}

async function reserveAndLaunch(config: GoalSchedulerConfig, definition: GoalSchedulerDefinition, authority: GoalSchedulerAuthority): Promise<boolean> {
  const store = new GoalStore(config);
  return store.withGoalLock(definition.goalId, async () => {
    let state = await store.get(definition.goalId);
    assertGoalContractIntegrity(state);
    if (state.contractFingerprint !== definition.contractFingerprint) throw new Error("Goal contract changed before worker launch.");
    if (!schedulerFence(state, authority) || state.lifecycle !== "running") return false;
    const reserved = state.work.find((work) => work.status === "launching" && work.launch) ??
      state.work.find((work) => work.status === "continuing" && work.turns?.at(-1)?.status === "reserved");
    const active = state.work.filter((work) => ["launching", "running"].includes(work.status) || (work.status === "continuing" && work.turns?.at(-1)?.status === "reserved")).length;
    const continuing = state.work.find((work) => work.status === "continuing" && work.turns?.at(-1)?.status === "succeeded" && (work.turns?.length ?? 0) < state.limits.maxTurnsPerWorker);
    const ready = state.work.find((work) => work.status === "ready" && work.dependsOn.every((dep) => state.work.find((x) => x.workId === dep)?.status === "integrated"));
    const candidate = reserved ?? continuing ?? ready;
    if (!candidate || (!reserved && candidate.status !== "continuing" && active >= state.limits.maxConcurrency)) return false;
    const now = new Date().toISOString();
    if (!reserved && candidate.status === "ready") {
      const baseSha = await getGoalIntegrationHead(state); const operationId = opId(state.goalId, candidate.workId, 1);
      const durableTaskKey = taskKey(state.goalId, candidate.workId);
      const reservation = { launchKey: launchKey(state.goalId, candidate.workId), taskKey: durableTaskKey, taskId: deterministicTaskId(state, candidate.workId), schedulerEpoch: authority.epoch, schedulerLeaseId: authority.leaseId, operationId, baseSha, reservedAt: now };
      const prompt = buildGoalWorkerPrompt(state, candidate);
      const turn: GoalWorkTurn = { turnIndex: 1, intentId: "initial", intentFingerprint: computeGoalInitialIntentFingerprint(candidate.workId, prompt), promptSha256: sha256(prompt), operationId, taskId: reservation.taskId, baseSha, status: "reserved", reservedAt: now };
      state = { ...state, revision: state.revision + 1, updatedAt: now, work: state.work.map((work) => work.workId === candidate.workId ? { ...work, status: "launching" as const, launch: reservation, baseSha, operationId, turns: [turn] } : work) };
      await store.writeLocked(state);
    } else if (!reserved && candidate.status === "continuing") {
      const turns = candidate.turns ?? [];
      const turnIndex = turns.length + 1;
      const intent = candidate.continuationIntents?.[turnIndex - 2];
      const previous = turns.at(-1);
      if (!intent || !previous || previous.status !== "succeeded" || !candidate.codingTaskId || !candidate.baseSha) throw new Error("Persistent continuation reservation lost approved prior-turn authority.");
      const operationId = opId(state.goalId, candidate.workId, turnIndex);
      const turn: GoalWorkTurn = { turnIndex, intentId: intent.intentId, intentFingerprint: intent.fingerprint, promptSha256: sha256(intent.prompt), operationId, previousOperationId: previous.operationId, taskId: candidate.codingTaskId, baseSha: candidate.baseSha, status: "reserved", reservedAt: now };
      state = { ...state, revision: state.revision + 1, updatedAt: now, work: state.work.map((work) => work.workId === candidate.workId ? { ...work, operationId, turns: [...turns, turn] } : work) };
      await store.writeLocked(state);
    }
    let work = state.work.find((item) => item.workId === candidate.workId)!;
    if (!work.launch) throw new Error("Persistent Goal launch reservation disappeared.");
    const baseSha = work.launch.baseSha;
    const turn = work.turns?.at(-1);
    if (!turn || turn.status !== "reserved") throw new Error("Persistent Goal turn reservation disappeared.");
    const operationId = turn.operationId;
    const prompt = turn.turnIndex === 1 ? buildGoalWorkerPrompt(state, work) : work.continuationIntents?.[turn.turnIndex - 2]?.prompt;
    if (!prompt || sha256(prompt) !== turn.promptSha256) throw new Error("Persistent Goal turn prompt no longer matches its approved reservation.");
    try {
      const created = turn.turnIndex === 1
        ? await createCodingTask(config, { root: state.sourceRoot }, { assertSourceWorkspace: (root) => { if (root !== state.sourceRoot) throw new Error("Goal worker source identity changed."); } }, { taskKey: work.launch!.taskKey, title: `${state.title} · ${work.title}`, goal: prompt, executor: "codex", baseSha, goalId: state.goalId, goalWorkId: work.workId })
        : { task: await getCodingTask(config, turn.taskId), reused: true };
      if (created.task.taskId !== work.launch!.taskId || created.task.worktreeRoot === state.integrationWorktreeRoot) throw new Error("Persistent Goal deterministic CodingTask identity mismatch.");
      if (!work.codingTaskId) {
        const bound = await store.get(definition.goalId);
        if (!schedulerFence(bound, authority) || bound.lifecycle !== "running") return true;
        const boundWork = bound.work.find((item) => item.workId === work.workId);
        if (!boundWork?.launch || boundWork.launch.taskId !== created.task.taskId || boundWork.status !== "launching") return true;
        const boundNext: GoalState = { ...bound, revision: bound.revision + 1, updatedAt: new Date().toISOString(), work: bound.work.map((item) => item.workId === work.workId ? { ...item, codingTaskId: created.task.taskId } : item) };
        await store.writeLocked(boundNext); state = boundNext; work = boundNext.work.find((item) => item.workId === work.workId)!;
      }
      const durableTurn = work.turns?.at(-1);
      if (!durableTurn) throw new Error("Persistent Goal turn disappeared before durable runner binding.");
      if (durableTurn.taskRevision === undefined) {
        const bound = await store.get(definition.goalId);
        if (!schedulerFence(bound, authority) || bound.lifecycle !== "running") return true;
        const boundWork = bound.work.find((item) => item.workId === work.workId);
        const boundTurn = boundWork?.turns?.at(-1);
        if (!boundWork || !boundTurn || boundTurn.operationId !== operationId || boundTurn.status !== "reserved") return true;
        const boundNext: GoalState = { ...bound, revision: bound.revision + 1, updatedAt: new Date().toISOString(), work: bound.work.map((item) => item.workId === work.workId ? { ...item, turns: item.turns?.map((entry) => entry.operationId === operationId ? { ...entry, taskRevision: created.task.revision, executorEpoch: created.task.executorLease.epoch, executorLeaseId: created.task.executorLease.leaseId } : entry) } : item) };
        await store.writeLocked(boundNext); state = boundNext; work = boundNext.work.find((item) => item.workId === work.workId)!;
      }
      const launchTurn = work.turns?.at(-1);
      if (!launchTurn?.taskRevision || !launchTurn.executorEpoch || !launchTurn.executorLeaseId) throw new Error("Persistent Goal turn lacks durable task lease binding.");
      await assertExecutableIdentity(definition);
      const runnerConfig = { dataRoot: config.dataRoot, codexBinary: config.codexBinary, env: { CODEX_HOME: config.codexDir }, maxLogBytes: state.limits.maxLogBytes };
      let run: CodingTaskRunView;
      if (turn.turnIndex === 1) {
        run = await launchCodingTaskRun(runnerConfig, created.task.taskId, { operationId, prompt, expectedRevision: launchTurn.taskRevision, executorEpoch: launchTurn.executorEpoch, leaseId: launchTurn.executorLeaseId, model: state.workerModel, effort: state.workerEffort, timeoutMs: state.limits.timeoutMs });
      } else {
        const previous = work.turns?.[turn.turnIndex - 2];
        if (!previous?.threadId || !previous.sessionId || !previous.turnId || previous.status !== "succeeded") throw new Error("Persistent continuation lacks exact successful prior thread/session/turn authority.");
        const requestKey = continuationKey(state.goalId, work.workId, turn.turnIndex);
        const existing = await getCodingTaskContinuation(config, created.task.taskId, requestKey).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (existing) {
          const decision = existing.decision;
          if (decision.operationId !== operationId || decision.turnOrdinal !== turn.turnIndex || decision.previousOperationId !== previous.operationId || decision.expectedRevision !== launchTurn.taskRevision || decision.executorEpoch !== launchTurn.executorEpoch || decision.leaseId !== launchTurn.executorLeaseId || decision.expectedThreadId !== previous.threadId || decision.expectedSessionId !== previous.sessionId || decision.expectedPreviousTurnId !== previous.turnId || decision.prompt !== prompt) throw new Error("Persistent continuation decision diverged from the durable Goal turn reservation.");
          if (existing.run) run = await reconcileCodingTaskRun(runnerConfig, created.task.taskId, operationId, { relaunchQueued: true });
          else run = (await submitCodingTaskContinuation(runnerConfig, created.task.taskId, { requestKey, operationId, turnOrdinal: turn.turnIndex, previousOperationId: previous.operationId, prompt, expectedRevision: launchTurn.taskRevision, executorEpoch: launchTurn.executorEpoch, leaseId: launchTurn.executorLeaseId, expectedThreadId: previous.threadId, expectedSessionId: previous.sessionId, expectedPreviousTurnId: previous.turnId, model: state.workerModel, effort: state.workerEffort, timeoutMs: state.limits.timeoutMs })).run;
        } else {
          const result = await submitCodingTaskContinuation(runnerConfig, created.task.taskId, { requestKey, operationId, turnOrdinal: turn.turnIndex, previousOperationId: previous.operationId, prompt, expectedRevision: launchTurn.taskRevision, executorEpoch: launchTurn.executorEpoch, leaseId: launchTurn.executorLeaseId, expectedThreadId: previous.threadId, expectedSessionId: previous.sessionId, expectedPreviousTurnId: previous.turnId, model: state.workerModel, effort: state.workerEffort, timeoutMs: state.limits.timeoutMs });
          if (result.run.operationId !== operationId) throw new Error("Persistent continuation runner decision diverged from reserved operation.");
          run = result.run;
        }
      }
      const current = await store.get(definition.goalId); if (!schedulerFence(current, authority) || current.lifecycle !== "running") return true;
      const currentWork = current.work.find((x) => x.workId === work.workId); const currentTurn = currentWork?.turns?.at(-1); if (!currentWork?.launch || currentTurn?.operationId !== operationId || ["integrated", "canceled"].includes(currentWork.status)) return true;
      const next: GoalState = { ...current, revision: current.revision + 1, updatedAt: new Date().toISOString(), work: current.work.map((x) => x.workId === work.workId ? { ...x, codingTaskId: created.task.taskId, operationId, status: run.status === "failed" ? "failed" as const : run.status === "canceled" ? "canceled" as const : "running" as const, startedAt: x.startedAt ?? run.startedAt ?? now, turns: x.turns?.map((entry) => entry.operationId === operationId ? { ...entry, status: "running" as const, runFingerprint: run.definitionFingerprint, runStatus: run.status, startedAt: run.startedAt ?? now } : entry), ...(run.error ? { error: run.error } : {}) } : x) };
      await store.writeLocked(next); return true;
    } catch (error) {
      const current = await store.get(definition.goalId); if (schedulerFence(current, authority)) await store.writeLocked({ ...current, lifecycle: "failed", error: errorText(error), revision: current.revision + 1, updatedAt: new Date().toISOString(), work: current.work.map((x) => x.workId === work.workId && !["integrated", "canceled"].includes(x.status) ? { ...x, status: "failed" as const, error: errorText(error) } : x) });
      throw error;
    }
  });
}

async function reconcileRuns(config: GoalSchedulerConfig, definition: GoalSchedulerDefinition, authority: GoalSchedulerAuthority): Promise<boolean> {
  const store = new GoalStore(config); const state = await store.get(definition.goalId); assertGoalContractIntegrity(state); if (state.contractFingerprint !== definition.contractFingerprint) throw new Error("Goal contract changed before worker reconciliation."); let changed = false;
  for (const work of state.work) {
    if (!work.codingTaskId || !work.operationId || !["launching", "running"].includes(work.status)) continue;
    let run: CodingTaskRunView;
    try {
      await assertExecutableIdentity(definition);
      const runnerConfig = { dataRoot: config.dataRoot, codexBinary: config.codexBinary, env: { CODEX_HOME: config.codexDir }, maxLogBytes: state.limits.maxLogBytes };
      const observed = await getCodingTaskRun(config, work.codingTaskId, work.operationId);
      if (observed.status === "queued" && !observed.runnerAlive) {
        run = await store.withGoalLock(definition.goalId, async () => {
          const current = await store.get(definition.goalId);
          const currentWork = current.work.find((item) => item.workId === work.workId);
          if (!schedulerFence(current, authority) || current.lifecycle !== "running" || !currentWork || currentWork.operationId !== work.operationId || !["launching", "running"].includes(currentWork.status)) return observed;
          return reconcileCodingTaskRun(runnerConfig, work.codingTaskId!, work.operationId!, { relaunchQueued: true });
        });
      } else run = await reconcileCodingTaskRun(runnerConfig, work.codingTaskId, work.operationId, { relaunchQueued: false });
    }
    catch (error) {
      if (work.status === "launching" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Persistent worker run reconciliation failed for ${work.workId}: ${errorText(error)}`);
    }
    if (["queued", "running"].includes(run.status)) continue;
    // The runner publishes its terminal run record before it can acquire the task lock
    // for fenced terminal writeback. A terminal-looking run is not attestable while that
    // publisher still owns the run lock; reviewing now would race the active operation.
    if (run.runnerAlive) continue;
    const task = await getCodingTask(config, work.codingTaskId);
    if (task.activeOperation) {
      if (task.activeOperation.executor === "codex" && task.activeOperation.operationId === work.operationId) continue;
      throw new Error(`Persistent worker ${work.workId} has divergent active operation authority during terminal publication.`);
    }
    if (task.lastCompletedOperation?.operationId !== work.operationId) continue;
    const review = await reviewCodingTask(config, task.taskId, { maxGitOutputBytes: config.maxOutputBytes, isPathContentAllowed: (pathname) => isGoalPathContentAllowed(definition.contentPolicy, pathname) });
    const outside = review.changedPaths.filter((pathname) => !pathAllowed(pathname, state, work, definition.contentPolicy));
    const terminalSuccess = run.status === "waiting_review" && !run.approvalOrInputDeclined && !run.error && task.lastCompletedOperation?.operationId === work.operationId && task.lifecycle === "waiting_review" && !task.activeOperation && sameObservation(task, review) && review.contentComplete && outside.length === 0;
    if (terminalSuccess && (!run.threadId || !run.sessionId || !run.turnId || task.codexThreadId !== run.threadId || task.codexTurnId !== run.turnId || task.codexSessionId !== run.sessionId)) throw new Error(`Persistent worker ${work.workId} terminal thread/session/turn provenance diverged.`);
    if (Buffer.byteLength(review.status, "utf8") > 32_768 || Buffer.byteLength(review.diffStat, "utf8") > 32_768) throw new Error(`Persistent worker ${work.workId} terminal Git observation exceeds its compact ledger bound.`);
    await store.withGoalLock(definition.goalId, async () => {
      const current = await store.get(definition.goalId); if (!schedulerFence(current, authority) || current.lifecycle !== "running") return;
      const item = current.work.find((x) => x.workId === work.workId); if (!item || ["integrated", "canceled", "failed"].includes(item.status) || item.operationId !== work.operationId) return;
      const tail = item.turns?.at(-1); if (!tail || tail.operationId !== work.operationId || tail.runFingerprint !== run.definitionFingerprint) throw new Error("Persistent worker terminal run does not match the reserved turn ledger.");
      if (tail.turnIndex > 1) { const prior = item.turns?.[tail.turnIndex - 2]; if (!prior?.threadId || run.threadId !== prior.threadId || run.sessionId !== prior.sessionId) throw new Error("Persistent continuation forked the approved CodingTask thread or session."); }
      const finalTurn = tail.turnIndex === current.limits.maxTurnsPerWorker;
      const status = terminalSuccess ? (finalTurn ? "waiting_review" as const : "continuing" as const) : run.status === "canceled" ? "canceled" as const : "failed" as const;
      const abnormal = status === "failed" || status === "canceled";
      const terminalError = run.error ?? (outside.length ? `Persistent worker changed paths outside the approved contract: ${outside.join(", ")}` : !review.contentComplete ? `Worker ${work.workId} terminal review was blocked by the approved content policy.` : `Worker ${work.workId} terminal result failed exact run/thread/Git provenance attestation.`);
      const resultSummary = run.finalText ?? ""; const observation = task.lastGitObservation!;
      const terminalTurn: GoalWorkTurn = { ...tail, status: terminalSuccess ? "succeeded" : status === "canceled" ? "canceled" : "failed", runStatus: run.status, threadId: run.threadId, sessionId: run.sessionId, turnId: run.turnId, ...(resultSummary ? { resultSummary } : {}), resultSha256: sha256(resultSummary), stopReason: terminalSuccess ? "terminal_success" : status === "canceled" ? "canceled" : "failed", terminalObservation: { capturedAt: observation.capturedAt, headSha: observation.headSha, status: observation.status, diffStat: observation.diffStat, diffSha256: observation.diffSha256, dirty: observation.dirty, changedPaths: review.changedPaths }, finishedAt: run.finishedAt ?? new Date().toISOString() };
      const next: GoalState = { ...current, ...(abnormal ? { lifecycle: "failed" as const, error: terminalError } : {}), revision: current.revision + 1, updatedAt: new Date().toISOString(), work: current.work.map((x) => x.workId === work.workId ? { ...x, status, turns: x.turns?.map((entry) => entry.operationId === tail.operationId ? terminalTurn : entry), ...(finalTurn && terminalSuccess ? { finishedAt: terminalTurn.finishedAt, ...(resultSummary ? { summary: resultSummary } : {}) } : {}), ...(abnormal ? { error: terminalError } : {}) } : x) };
      await store.writeLocked(next); changed = true;
    });
  }
  return changed;
}

function sameObservation(task: Awaited<ReturnType<typeof getCodingTask>>, review: Awaited<ReturnType<typeof reviewCodingTask>>): boolean {
  const observation = task.lastGitObservation;
  return Boolean(observation && observation.headSha === review.headSha && observation.status === review.status && observation.diffStat === review.diffStat && observation.diffSha256 === review.diffSha256 && observation.dirty === review.dirty);
}

async function integrateNext(config: GoalSchedulerConfig, definition: GoalSchedulerDefinition, authority: GoalSchedulerAuthority): Promise<boolean> {
  const store = new GoalStore(config);
  return store.withGoalLock(definition.goalId, async () => {
    const state = await store.get(definition.goalId); if (!schedulerFence(state, authority) || state.lifecycle !== "running") return false;
    assertGoalContractIntegrity(state); if (state.contractFingerprint !== definition.contractFingerprint) throw new Error("Goal contract changed before mechanical integration.");
    const work = state.work.find((x) => x.status === "waiting_review" && x.dependsOn.every((dep) => state.work.find((y) => y.workId === dep)?.status === "integrated"));
    if (!work?.codingTaskId || !work.operationId) return false;
    const finalTurn = work.turns?.at(-1);
    if (!finalTurn || work.turns?.length !== state.limits.maxTurnsPerWorker || finalTurn.turnIndex !== state.limits.maxTurnsPerWorker || finalTurn.status !== "succeeded" || finalTurn.operationId !== work.operationId || finalTurn.runStatus !== "waiting_review") {
      throw new Error("Persistent integration requires the exact final authorized successful turn ledger.");
    }
    const task = await getCodingTask(config, work.codingTaskId);
    if (task.goalId !== state.goalId || task.goalWorkId !== work.workId || task.lastCompletedOperation?.operationId !== work.operationId || !["waiting_review", "completed"].includes(task.lifecycle) || task.activeOperation) throw new Error("Persistent integration refused stale CodingTask membership or operation authority.");
    const review = await reviewCodingTask(config, task.taskId, { maxGitOutputBytes: config.maxOutputBytes, isPathContentAllowed: (pathname) => isGoalPathContentAllowed(definition.contentPolicy, pathname) });
    if (!review.contentComplete || !sameObservation(task, review)) throw new Error("Persistent integration review no longer equals the terminal worker Git observation.");
    if (!finalTurn.terminalObservation || finalTurn.threadId !== task.codexThreadId || finalTurn.sessionId !== task.codexSessionId || finalTurn.turnId !== task.codexTurnId || finalTurn.terminalObservation.headSha !== review.headSha || finalTurn.terminalObservation.status !== review.status || finalTurn.terminalObservation.diffStat !== review.diffStat || finalTurn.terminalObservation.diffSha256 !== review.diffSha256 || finalTurn.terminalObservation.dirty !== review.dirty) {
      throw new Error("Persistent integration review no longer equals the final authorized turn provenance ledger.");
    }
    const outside = review.changedPaths.filter((pathname) => !pathAllowed(pathname, state, work, definition.contentPolicy));
    if (outside.length) throw new Error(`Persistent worker changed paths outside the approved contract: ${outside.join(", ")}`);
    const ikey = integrationKey(state.goalId, work.workId); const expectedParent = state.integrationHeadSha ?? state.baseSha;
    const journalPath = store.integrationJournalPath(state.goalId, work.workId);
    const journalText = `${JSON.stringify({ version: 1, goalId: state.goalId, workId: work.workId, integrationKey: ikey, expectedParent, reviewDiffSha256: review.visibleDiffSha256, changedPaths: review.changedPaths }, null, 2)}\n`;
    if (review.changedPaths.length > 1_000 || Buffer.byteLength(journalText) > 64 * 1024) throw new Error("Persistent integration journal exceeds its safety bound.");
    await publishImmutable(journalPath, journalText);
    const applied = review.changedPaths.length === 0 && review.diff === ""
      ? { commitSha: expectedParent }
      : await applyGoalWorkerPatch(state, work.workId, ikey, review.visibleDiffSha256, review.diff, review.changedPaths, config.maxOutputBytes);
    const now = new Date().toISOString();
    const updated = state.work.map((x): GoalWorkItem => x.workId === work.workId ? { ...x, status: "integrated", integrationKey: ikey, reviewDiffSha256: review.visibleDiffSha256, integratedCommitSha: applied.commitSha, finishedAt: x.finishedAt ?? now } : x);
    const unlocked = updated.map((x): GoalWorkItem => x.status === "planned" && x.dependsOn.every((dep) => updated.find((y) => y.workId === dep)?.status === "integrated") ? { ...x, status: "ready" } : x);
    const all = unlocked.every((x) => x.status === "integrated");
    const next: GoalState = { ...state, lifecycle: all ? "waiting_review" : "running", integrationHeadSha: applied.commitSha, revision: state.revision + 1, updatedAt: now, work: unlocked, events: [...state.events, { at: now, kind: "integration_updated" as const, workId: work.workId, message: `Persistent scheduler mechanically integrated terminal checkpoint ${applied.commitSha}.` }].slice(-500) };
    await store.writeLocked(next); return true;
  });
}

async function drainCancellation(config: GoalSchedulerConfig, definition: GoalSchedulerDefinition, authority: GoalSchedulerAuthority): Promise<boolean> {
  const state = await new GoalStore(config).get(definition.goalId);
  if (!schedulerFence(state, authority)) throw new Error("Persistent scheduler lease changed during cancellation.");
  return (await reconcilePersistentGoalCancellation(config, definition.goalId)).lifecycle === "canceled";
}

export async function runPersistentGoalScheduler(definitionPath: string, dataRootInput: string): Promise<void> {
  if (process.platform === "win32") throw new Error("Persistent Goal scheduling requires POSIX advisory locking.");
  const dataRoot = path.resolve(dataRootInput); const definition = await boundedJson<GoalSchedulerDefinition>(path.resolve(definitionPath), DEFINITION_MAX_BYTES);
  if (!definition) throw new Error("Goal scheduler definition is missing."); assertDefinition(definition);
  if (definition.dataRoot !== dataRoot) throw new Error("Goal scheduler data-root authority mismatch.");
  const config: GoalSchedulerConfig = { dataRoot, codexBinary: definition.codexBinary, codexDir: definition.codexDir, maxOutputBytes: definition.maxOutputBytes };
  const store = new GoalStore(config);
  if (path.resolve(definitionPath) !== store.schedulerDefinitionPath(definition.goalId, definition.fingerprint)) throw new Error("Goal scheduler definition path is not the authoritative fingerprinted path.");
  await assertExecutableIdentity(definition);
  const claimedLock = await store.tryWithSchedulerLock(definition.goalId, async () => {
    const claimed = await claimScheduler(store, definition); let authority = claimed.authority;
    if (!claimed.acquiredAuthority) return;
    const priorRuntime = await boundedJson<GoalSchedulerRuntime>(store.paths(definition.goalId).schedulerRuntime, RUNTIME_MAX_BYTES);
    const startedAt = new Date().toISOString(); let runtime: GoalSchedulerRuntime = { version: 1, goalId: definition.goalId, definitionFingerprint: definition.fingerprint, epoch: authority.epoch, leaseId: authority.leaseId, status: "running", pid: process.pid, processNonce: priorRuntime?.pid === process.pid && priorRuntime.definitionFingerprint === definition.fingerprint && typeof priorRuntime.processNonce === "string" ? priorRuntime.processNonce : randomUUID(), startedAt, heartbeatAt: startedAt };
    await updateRuntime(store, runtime);
    try {
      for (;;) {
        runtime = { ...runtime, heartbeatAt: new Date().toISOString() }; await updateRuntime(store, runtime);
        const state = await store.get(definition.goalId); if (!schedulerFence(state, authority)) throw new Error("Persistent scheduler lease was superseded.");
        if (state.lifecycle === "paused") { await persistStop(store, definition.goalId, authority, "paused"); runtime = { ...runtime, status: "stopped", stoppedAt: new Date().toISOString(), stopReason: "paused" }; break; }
        if (state.lifecycle === "canceling") { if (await drainCancellation(config, definition, authority)) { await persistStop(store, definition.goalId, authority, "canceled"); runtime = { ...runtime, status: "stopped", stoppedAt: new Date().toISOString(), stopReason: "canceled" }; break; } await wait(POLL_MS); continue; }
        if (state.lifecycle === "waiting_review") { await persistStop(store, definition.goalId, authority, "semantic_review"); runtime = { ...runtime, status: "stopped", stoppedAt: new Date().toISOString(), stopReason: "semantic_review" }; break; }
        if (["failed", "canceled", "completed"].includes(state.lifecycle)) { await persistStop(store, definition.goalId, authority, state.lifecycle === "failed" ? "failed" : "canceled"); runtime = { ...runtime, status: "stopped", stoppedAt: new Date().toISOString(), stopReason: state.lifecycle }; break; }
        await reconcileRuns(config, definition, authority);
        const afterRuns = await store.get(definition.goalId); if (afterRuns.lifecycle !== "running") continue;
        if (await integrateNext(config, definition, authority)) continue;
        if (await reserveAndLaunch(config, definition, authority)) continue;
        await wait(POLL_MS);
      }
    } catch (error) {
      await persistStop(store, definition.goalId, authority, "scheduler_failed", error).catch(() => undefined);
      runtime = { ...runtime, status: "failed", heartbeatAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), stopReason: "scheduler_failed", error: errorText(error) };
      throw error;
    } finally { await updateRuntime(store, runtime); }
  });
  if (!claimedLock.acquired) return;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === SCHEDULER_PATH && process.argv[2] && process.argv[3]) {
  runPersistentGoalScheduler(process.argv[2], process.argv[3]).catch((error) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 1; });
}
