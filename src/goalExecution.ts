import { getCodingTask, createCodingTask, requestCodingTaskCancellation, reviewCodingTask } from "./codingTaskOps.js";
import { cancelQueuedCodingTaskRun, getCodingTaskRun, launchCodingTaskRun, waitForCodingTaskRun, type CodingTaskRunView } from "./codingTaskRunner.js";
import { GoalStore, type GoalStoreConfig } from "./goalStore.js";
import { applyGoalPatchToSource, applyGoalWorkerPatch, ensureGoalIntegrationWorktree, getGoalIntegrationHead, goalSourceDirtyPaths, reviewGoalIntegration, verifyGoalIntegrationDiff } from "./goalWorktree.js";
import { validateGoalId, validateGoalWorkId, type GoalState, type GoalWorkItem } from "./goalState.js";
import { markGoalCanceled } from "./goalOps.js";
import { goalReviewFingerprint, verifyGoalLiveProjection } from "./goalProjection.js";
import { minimatch } from "minimatch";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { secureCodingTaskDirectory } from "./codingTaskStore.js";

export { projectGoal, revertGoalProjection } from "./goalProjection.js";
export type { ProjectGoalInput, RevertGoalProjectionInput, GoalProjectionResult, GoalReviewAttestation } from "./goalProjection.js";

export interface GoalExecutionConfig extends GoalStoreConfig {
  codexBinary: string;
  codexDir: string;
  maxOutputBytes: number;
}

export interface GoalIntegrationConfig extends GoalStoreConfig {
  maxOutputBytes: number;
}

export interface StartGoalInput {
  expectedRevision: number;
  startKey: string;
}

export interface IntegrateGoalWorkInput {
  expectedRevision: number;
  workId: string;
  integrationKey: string;
  isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
}

export interface CancelGoalInput {
  expectedRevision: number;
  cancelKey: string;
  reason?: string;
}

export interface ApplyGoalInput {
  expectedRevision: number;
  applicationKey: string;
  isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
}

function boundedKey(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(normalized)) {
    throw new Error(`${name} must be 1-160 safe identifier characters.`);
  }
  return normalized;
}

function runnerConfig(config: GoalExecutionConfig, goal: GoalState) {
  return {
    dataRoot: config.dataRoot,
    codexBinary: config.codexBinary,
    env: { CODEX_HOME: config.codexDir },
    maxLogBytes: goal.limits.maxLogBytes
  };
}

function operationId(goal: GoalState, work: GoalWorkItem): string {
  return `goal:${goal.goalId.slice(5)}:${work.workId}:run:1`;
}

function workerPrompt(goal: GoalState, work: GoalWorkItem): string {
  const allowed = work.fileGlobs.length ? work.fileGlobs : goal.permissions.fileGlobs;
  return [
    `You are a Codex worker assigned by ChatGPT Pro to Goal ${goal.goalId}.`,
    `Work item: ${work.workId} — ${work.title}`,
    "",
    "Implement only this approved scope:",
    work.goal,
    "",
    "Acceptance criteria:",
    ...work.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Allowed file globs:",
    ...allowed.map((glob) => `- ${glob}`),
    "",
    "Verification:",
    ...(work.verification.length ? work.verification : goal.verification).map((check) => `- ${check}`),
    "",
    "Authority constraints:",
    "- Do not broaden scope, create new work, reassign dependencies, commit, merge, push, or create a PR.",
    "- Network access and interactive approvals are disabled.",
    "- If the scope or file boundary is insufficient, stop and report a blocker for Pro; do not work around it.",
    "- Finish with a concise summary of files changed, checks run, results, and any Blackboard-worthy discovery."
  ].join("\n");
}

async function beginGoalExecution(config: GoalStoreConfig, goalId: string, input: StartGoalInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const startKey = boundedKey(input.startKey, "Goal start key");
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.startKey) {
      if (state.startKey !== startKey) throw new Error("Goal is already bound to a different start key.");
      return state;
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (state.approval.status !== "approved" || state.lifecycle !== "approved") throw new Error("Goal execution requires an explicitly approved persisted contract.");
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      startKey,
      lifecycle: "running",
      integrationHeadSha: state.baseSha,
      revision: state.revision + 1,
      startedAt: now,
      updatedAt: now,
      work: state.work.map((item) => ({ ...item, status: item.dependsOn.length ? "planned" : "ready" })),
      events: [...state.events, { at: now, kind: "started" as const, message: "Approved Goal execution started." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

async function bindWorkTask(config: GoalStoreConfig, goalId: string, workId: string, taskId: string, baseSha: string, opId: string): Promise<GoalState> {
  const store = new GoalStore(config);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    const work = state.work.find((item) => item.workId === workId);
    if (!work) throw new Error(`Unknown Goal work item: ${workId}`);
    if (work.codingTaskId && (work.codingTaskId !== taskId || work.operationId !== opId || work.baseSha !== baseSha)) {
      throw new Error(`Goal work ${workId} is already bound to different execution authority.`);
    }
    if (work.codingTaskId) return state;
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      work: state.work.map((item) => item.workId === workId ? { ...item, codingTaskId: taskId, operationId: opId, baseSha, status: "ready" } : item),
      events: [...state.events, { at: now, kind: "work_updated" as const, workId, message: `Bound to CodingTask ${taskId}.` }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

async function updateWorkFromRun(config: GoalStoreConfig, goalId: string, workId: string, run: CodingTaskRunView | undefined, error?: unknown): Promise<GoalState> {
  const store = new GoalStore(config);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    const work = state.work.find((item) => item.workId === workId);
    if (!work) throw new Error(`Unknown Goal work item: ${workId}`);
    const status = error ? "failed" as const
      : run && ["waiting_review", "completed"].includes(run.status) ? "waiting_review" as const
      : run?.status === "failed" ? "failed" as const
      : run?.status === "canceled" ? "canceled" as const
      : "running" as const;
    const now = new Date().toISOString();
    const nextWork: GoalWorkItem = {
      ...work,
      status,
      ...(status === "running" && !work.startedAt ? { startedAt: now } : {}),
      ...(["waiting_review", "failed", "canceled"].includes(status) ? { finishedAt: run?.finishedAt ?? now } : {}),
      ...(run?.finalText ? { summary: run.finalText } : {}),
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : run?.error ? { error: run.error } : {})
    };
    const next: GoalState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      work: state.work.map((item) => item.workId === workId ? nextWork : item),
      events: [...state.events, { at: now, kind: "work_updated" as const, workId, message: `Worker status: ${status}.` }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

async function launchReadyGoalWork(config: GoalExecutionConfig, goalId: string): Promise<CodingTaskRunView[]> {
  const store = new GoalStore(config);
  let goal = await store.get(goalId);
  if (goal.lifecycle !== "running" && goal.lifecycle !== "waiting_review") return [];
  const running = goal.work.filter((item) => item.status === "running").length;
  const eligible = goal.work.filter((item) => item.status === "ready" && item.dependsOn.every((dependency) => goal.work.find((candidate) => candidate.workId === dependency)?.status === "integrated"))
    .slice(0, Math.max(0, goal.limits.maxConcurrency - running));
  if (!eligible.length) return [];
  const baseSha = await getGoalIntegrationHead(goal);
  const prepared: Array<{ work: GoalWorkItem; task: Awaited<ReturnType<typeof createCodingTask>>["task"]; opId: string }> = [];
  for (const work of eligible) {
    const created = await createCodingTask(
      config,
      { root: goal.sourceRoot },
      { assertSourceWorkspace: (sourceRoot) => {
        if (sourceRoot !== goal.sourceRoot) throw new Error("Goal worker source identity changed.");
      } },
      {
        taskKey: `goal:${goal.goalId}:${work.workId}`,
        title: `${goal.title} · ${work.title}`,
        goal: workerPrompt(goal, work),
        executor: "codex",
        baseSha,
        goalId: goal.goalId,
        goalWorkId: work.workId
      }
    );
    const opId = operationId(goal, work);
    await bindWorkTask(config, goal.goalId, work.workId, created.task.taskId, baseSha, opId);
    prepared.push({ work, task: created.task, opId });
  }
  const settled = await Promise.all(prepared.map(async ({ work, task, opId }) => {
    try {
      const run = await launchCodingTaskRun(runnerConfig(config, goal), task.taskId, {
        operationId: opId,
        prompt: workerPrompt(goal, work),
        expectedRevision: task.revision,
        executorEpoch: task.executorLease.epoch,
        leaseId: task.executorLease.leaseId,
        model: goal.workerModel,
        effort: goal.workerEffort,
        timeoutMs: goal.limits.timeoutMs
      });
      await updateWorkFromRun(config, goal.goalId, work.workId, run);
      return run;
    } catch (error) {
      await updateWorkFromRun(config, goal.goalId, work.workId, undefined, error);
      throw error;
    }
  }));
  goal = await store.get(goalId);
  return settled;
}

export async function startGoal(config: GoalExecutionConfig, goalIdInput: string, input: StartGoalInput): Promise<{ goal: GoalState; runs: CodingTaskRunView[] }> {
  const goalId = validateGoalId(goalIdInput);
  let goal = await beginGoalExecution(config, goalId, input);
  await ensureGoalIntegrationWorktree(goal);
  const runs = await launchReadyGoalWork(config, goalId);
  goal = await new GoalStore(config).get(goalId);
  return { goal, runs };
}

export async function refreshGoal(config: GoalStoreConfig, goalIdInput: string): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput);
  const store = new GoalStore(config);
  const goal = await store.get(goalId);
  await Promise.all(goal.work.filter((work) => work.codingTaskId && work.operationId && ["running", "ready"].includes(work.status)).map(async (work) => {
    try {
      const run = await getCodingTaskRun(config, work.codingTaskId!, work.operationId!);
      await updateWorkFromRun(config, goalId, work.workId, run);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await updateWorkFromRun(config, goalId, work.workId, undefined, error);
    }
  }));
  return store.withGoalLock(goalId, async () => {
    const current = await store.get(goalId);
    const active = current.work.some((item) => ["ready", "running", "integrating"].includes(item.status));
    const waiting = current.work.some((item) => item.status === "waiting_review");
    const failures = current.work.some((item) => ["failed", "blocked"].includes(item.status));
    const lifecycle = current.lifecycle === "paused" ? "paused" as const
      : failures ? "failed" as const
      : !active && waiting ? "waiting_review" as const
      : current.lifecycle;
    if (lifecycle === current.lifecycle) return current;
    const now = new Date().toISOString();
    const next = { ...current, lifecycle, revision: current.revision + 1, updatedAt: now };
    await store.writeLocked(next);
    return next;
  });
}

function pathAllowed(pathname: string, goal: GoalState, work: GoalWorkItem): boolean {
  const options = { dot: true, nocase: process.platform === "win32" };
  const withinGoal = goal.permissions.fileGlobs.some((pattern) => minimatch(pathname, pattern, options));
  const withinWork = !work.fileGlobs.length || work.fileGlobs.some((pattern) => minimatch(pathname, pattern, options));
  return withinGoal && withinWork;
}

export async function integrateGoalWork(
  config: GoalIntegrationConfig,
  goalIdInput: string,
  input: IntegrateGoalWorkInput
): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput);
  const workId = validateGoalWorkId(input.workId);
  const integrationKey = boundedKey(input.integrationKey, "Goal integration key");
  const store = new GoalStore(config);
  let goal = await store.get(goalId);
  let work = goal.work.find((item) => item.workId === workId);
  if (!work) throw new Error(`Unknown Goal work item: ${workId}`);
  if (work.status === "integrated") {
    if (work.integrationKey !== integrationKey) throw new Error("Goal work is already bound to a different integration key.");
    return goal;
  }
  if (goal.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
  if (work.status !== "waiting_review" || !work.codingTaskId) throw new Error("Goal work must have a terminal worker result waiting for Pro review before integration.");
  if (!work.dependsOn.every((dependency) => goal.work.find((item) => item.workId === dependency)?.status === "integrated")) {
    throw new Error("Goal work dependencies must be integrated first.");
  }
  const task = await getCodingTask(config, work.codingTaskId);
  if (task.goalId !== goalId || task.goalWorkId !== workId) throw new Error("CodingTask Goal membership mismatch.");
  const review = await reviewCodingTask(config, task.taskId, {
    maxGitOutputBytes: config.maxOutputBytes,
    isPathContentAllowed: input.isPathContentAllowed
  });
  if (!review.contentComplete) throw new Error(`Goal integration refuses blocked-path content: ${review.omittedPaths.join(", ")}`);
  const outside = review.changedPaths.filter((pathname) => !pathAllowed(pathname, goal, work!));
  if (outside.length) throw new Error(`Goal worker changed paths outside the approved contract: ${outside.join(", ")}`);
  return store.withGoalLock(goalId, async () => {
    goal = await store.get(goalId);
    work = goal.work.find((item) => item.workId === workId);
    if (!work) throw new Error(`Unknown Goal work item: ${workId}`);
    if (work.status === "integrated") {
      if (work.integrationKey !== integrationKey) throw new Error("Goal work is already bound to a different integration key.");
      return goal;
    }
    if (goal.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
    const expectedParent = goal.integrationHeadSha ?? goal.baseSha;
    const journalPath = store.integrationJournalPath(goalId, workId);
    const journalText = `${JSON.stringify({ version: 1, goalId, workId, integrationKey, expectedParent, reviewDiffSha256: review.visibleDiffSha256, changedPaths: review.changedPaths }, null, 2)}\n`;
    if (review.changedPaths.length > 1_000 || Buffer.byteLength(journalText) > 64 * 1024) {
      throw new Error("Goal integration journal exceeds the 1000-path or 64KiB safety bound.");
    }
    await fsp.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    await secureCodingTaskDirectory(path.dirname(journalPath), "Goal integration journal");
    const temporary = `${journalPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await fsp.open(temporary, "wx", 0o600);
      try { await handle.writeFile(journalText); await handle.sync(); } finally { await handle.close(); }
      try { await fsp.link(temporary, journalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { await fsp.unlink(temporary).catch(() => undefined); }
    const journalHandle = await fsp.open(journalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let persistedJournal: string;
    try {
      const stat = await journalHandle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("Goal integration journal is unsafe or exceeds its bound.");
      persistedJournal = await journalHandle.readFile("utf8");
    } finally { await journalHandle.close(); }
    if (persistedJournal !== journalText) throw new Error("Goal integration journal is bound to a different immutable checkpoint contract.");
    const applied = await applyGoalWorkerPatch(goal, workId, integrationKey, review.visibleDiffSha256, review.diff, review.changedPaths, config.maxOutputBytes);
    const now = new Date().toISOString();
    const updatedWork = goal.work.map((item): GoalWorkItem => item.workId === workId ? {
      ...item,
      status: "integrated",
      reviewDiffSha256: review.visibleDiffSha256,
      integrationKey,
      integratedCommitSha: applied.commitSha,
      finishedAt: item.finishedAt ?? now
    } : item);
    const unlockedWork = updatedWork.map((item): GoalWorkItem => item.status === "planned" && item.dependsOn.every((dependency) => updatedWork.find((candidate) => candidate.workId === dependency)?.status === "integrated")
      ? { ...item, status: "ready" }
      : item);
    const allIntegrated = unlockedWork.every((item) => item.status === "integrated");
    const next: GoalState = {
      ...goal,
      lifecycle: allIntegrated ? "waiting_review" : "running",
      integrationHeadSha: applied.commitSha,
      revision: goal.revision + 1,
      updatedAt: now,
      work: unlockedWork,
      events: [...goal.events, { at: now, kind: "integration_updated" as const, workId, message: `Integrated at internal checkpoint ${applied.commitSha}.` }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

export async function reviewGoal(config: GoalIntegrationConfig, goalIdInput: string, contentPolicy?: (relativePath: string) => boolean | Promise<boolean>) {
  const goal = await new GoalStore(config).get(validateGoalId(goalIdInput));
  const review = await reviewGoalIntegration(goal, { maxOutputBytes: config.maxOutputBytes, contentPolicy });
  const verification = await verifyGoalIntegrationDiff(goal, review.headSha, config.maxOutputBytes);
  const attestation = goalReviewFingerprint(goal, review, verification);
  const projectionBlockers: string[] = [];
  if (goal.executionPolicy !== "supervised" || goal.workspacePolicy !== "live" || !goal.permissions.sourceEffects.apply) projectionBlockers.push("not_approved_supervised_live");
  if (!review.contentComplete) projectionBlockers.push("review_content_incomplete");
  if (review.dirty) projectionBlockers.push("integration_worktree_dirty");
  if (!goal.integrationHeadSha || goal.integrationHeadSha !== review.headSha) projectionBlockers.push("integration_head_mismatch");
  if (goal.live?.pendingProjectionId) projectionBlockers.push("projection_pending");
  if (goal.live?.projections.some((projection) => projection.status === "recovery_required")) projectionBlockers.push("projection_recovery_required");
  if (goal.live?.adoptedAt || goal.lifecycle === "completed") projectionBlockers.push("goal_sealed");
  if (goal.live?.projectedIntegrationSha === review.headSha) projectionBlockers.push("integration_head_already_projected");
  return {
    goal,
    review,
    verification,
    ...attestation,
    projectionEligible: projectionBlockers.length === 0,
    projectionBlockers
  };
}

export async function cancelGoal(config: GoalStoreConfig, goalIdInput: string, input: CancelGoalInput): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput);
  const cancelKey = boundedKey(input.cancelKey, "Goal cancel key");
  const store = new GoalStore(config);
  const goal = await store.get(goalId);
  if (goal.cancelKey === cancelKey && goal.lifecycle === "canceled") return goal;
  if (goal.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
  const active = goal.work.filter((work) => work.codingTaskId && work.operationId && ["ready", "running"].includes(work.status));
  await Promise.all(active.map(async (work) => {
    const run = await getCodingTaskRun(config, work.codingTaskId!, work.operationId!);
    if (!["queued", "running"].includes(run.status)) return;
    const task = await getCodingTask(config, work.codingTaskId!);
    if (task.activeOperation?.operationId === work.operationId) {
      await requestCodingTaskCancellation(config, task.taskId, {
        executor: "codex",
        executorEpoch: task.executorLease.epoch,
        leaseId: task.executorLease.leaseId,
        operationId: work.operationId!,
        reason: input.reason ?? `Goal ${goalId} canceled`
      });
      const terminalRun = await waitForCodingTaskRun(config, task.taskId, work.operationId!, { terminal: true, timeoutMs: 5_000, pollMs: 100 });
      if (terminalRun.status !== "canceled") throw new Error(`Goal worker ${work.workId} did not reach canceled run state.`);
      const taskDeadline = Date.now() + 5_000;
      let terminalTask = await getCodingTask(config, task.taskId);
      while (terminalTask.activeOperation && Date.now() < taskDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        terminalTask = await getCodingTask(config, task.taskId);
      }
      if (terminalTask.activeOperation || terminalTask.lifecycle !== "canceled") {
        throw new Error(`Goal worker ${work.workId} run stopped but its CodingTask lease has not reached canceled authority.`);
      }
      return;
    }
    if (run.status === "queued" && !run.runnerAlive) {
      await cancelQueuedCodingTaskRun(config, task.taskId, work.operationId!, input.reason ?? `Goal ${goalId} canceled`);
      return;
    }
    throw new Error(`Goal worker ${work.workId} could not be fenced for cancellation; retry after authoritative refresh.`);
  }));
  return markGoalCanceled(config, goalId, { expectedRevision: input.expectedRevision, requestKey: cancelKey });
}

export async function applyCompletedGoal(config: GoalIntegrationConfig, goalIdInput: string, input: ApplyGoalInput): Promise<GoalState> {
  const goalId = validateGoalId(goalIdInput);
  const applicationKey = boundedKey(input.applicationKey, "Goal application key");
  const store = new GoalStore(config);
  let goal = await store.get(goalId);
  if (goal.sourceApplication?.applicationKey === applicationKey && goal.sourceApplication.status === "applied") return goal;
  if (goal.sourceApplication && goal.sourceApplication.applicationKey !== applicationKey) {
    throw new Error("Goal source application is already bound to a different application key.");
  }
  if (!goal.sourceApplication && goal.revision !== input.expectedRevision) {
    throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
  }
  if (goal.lifecycle !== "completed" || !goal.completion) throw new Error("Only a Pro-completed Goal can be applied to source.");
  if (!goal.permissions.sourceEffects.apply) throw new Error("This Goal contract did not approve source application.");
  if (goal.workspacePolicy === "live") {
    return store.withSourceLock(goal.sourceRoot, goal.sourceGitCommonDir, async () => store.withGoalLock(goalId, async () => {
      const current = await store.get(goalId);
      if (current.sourceApplication?.applicationKey === applicationKey && current.sourceApplication.status === "applied") return current;
      if (current.sourceApplication && current.sourceApplication.applicationKey !== applicationKey) throw new Error("Goal source application is already bound to a different application key.");
      if (current.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${current.revision}.`);
      if (current.lifecycle !== "completed" || !current.completion || !current.live || current.live.adoptedAt) throw new Error("Only an unadopted completed Live Goal can be sealed.");
      const verified = await verifyGoalLiveProjection(config, current, input.isPathContentAllowed);
      const now = new Date().toISOString();
      const adoptedProjection = { ...verified.projection, status: "adopted" as const };
      const next: GoalState = {
        ...current,
        sourceApplication: {
          applicationKey,
          status: "applied",
          patchSha256: verified.projection.cumulativePatchSha256,
          sourceHeadSha: current.baseSha,
          sourceDirtyPathsBefore: verified.sourceDirtyPaths,
          sourceDirtyPathsAfter: verified.sourceDirtyPaths,
          startedAt: now,
          appliedAt: now,
          zeroWrite: true,
          adoptedProjectionId: verified.projection.projectionId,
          reviewFingerprint: verified.review.reviewFingerprint
        },
        live: {
          ...current.live,
          adoptedAt: now,
          adoptedProjectionId: verified.projection.projectionId,
          adoptedReviewFingerprint: verified.review.reviewFingerprint,
          projections: current.live.projections.map((projection) => projection.projectionId === adoptedProjection.projectionId ? adoptedProjection : projection)
        },
        revision: current.revision + 1,
        updatedAt: now,
        events: [...current.events, { at: now, kind: "projection_updated" as const, message: `Live projection ${verified.projection.projectionId} was sealed with zero source writes after authoritative readback.` }].slice(-500)
      };
      await store.writeLocked(next);
      return next;
    }));
  }
  return store.withSourceLock(goal.sourceRoot, goal.sourceGitCommonDir, async () => {
  const review = await reviewGoalIntegration(goal, { maxOutputBytes: config.maxOutputBytes, contentPolicy: input.isPathContentAllowed });
  if (!review.contentComplete) throw new Error(`Goal source application refuses blocked-path content: ${review.omittedPaths.join(", ")}`);
  const patchSha256 = createHash("sha256").update(review.diff).digest("hex");
  const before = await goalSourceDirtyPaths(goal, config.maxOutputBytes);
  const overlap = review.changedPaths.filter((pathname) => before.includes(pathname));
  const recovering = goal.sourceApplication?.applicationKey === applicationKey;
  if (overlap.length && !recovering) throw new Error(`Goal source has pre-existing changes on Goal-owned paths: ${overlap.join(", ")}`);
  if (!recovering) {
    goal = await store.withGoalLock(goalId, async () => {
      const current = await store.get(goalId);
      if (current.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${current.revision}.`);
      const now = new Date().toISOString();
      const next: GoalState = {
        ...current,
        sourceApplication: {
          applicationKey,
          status: "applying",
          patchSha256,
          sourceHeadSha: current.baseSha,
          sourceDirtyPathsBefore: before,
          startedAt: now
        },
        revision: current.revision + 1,
        updatedAt: now
      };
      await store.writeLocked(next);
      return next;
    });
  } else if (goal.sourceApplication?.patchSha256 !== patchSha256) {
    throw new Error("Goal integration patch changed after source application began.");
  }
  try {
    const applied = await applyGoalPatchToSource(goal, review.diff, review.changedPaths, {
      maxOutputBytes: config.maxOutputBytes,
      allowAlreadyApplied: true
    });
    return store.withGoalLock(goalId, async () => {
      const current = await store.get(goalId);
      if (current.sourceApplication?.applicationKey !== applicationKey || current.sourceApplication.patchSha256 !== patchSha256) {
        throw new Error("Goal source application authority changed during apply.");
      }
      if (current.sourceApplication.status === "applied") return current;
      const now = new Date().toISOString();
      const next: GoalState = {
        ...current,
        sourceApplication: {
          ...current.sourceApplication,
          status: "applied",
          sourceDirtyPathsAfter: applied.sourceDirtyPathsAfter,
          appliedAt: now,
          error: undefined
        },
        revision: current.revision + 1,
        updatedAt: now,
        events: [...current.events, { at: now, kind: "integration_updated" as const, message: "The completed Goal patch was applied to source with authoritative readback." }].slice(-500)
      };
      await store.writeLocked(next);
      return next;
    });
  } catch (error) {
    await store.withGoalLock(goalId, async () => {
      const current = await store.get(goalId);
      if (current.sourceApplication?.applicationKey !== applicationKey || current.sourceApplication.status === "applied") return;
      const now = new Date().toISOString();
      await store.writeLocked({
        ...current,
        sourceApplication: { ...current.sourceApplication, status: "failed", error: error instanceof Error ? error.message : String(error) },
        revision: current.revision + 1,
        updatedAt: now
      });
    });
    throw error;
  }
  });
}
import { createHash } from "node:crypto";
