import fsp, { constants as fsConstants } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, type Workspace } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, ensureAiBridge, withFileWriteLocks } from "./fsOps.js";
import { viewWorkspaceImage } from "./imageOps.js";
import { importAttachmentFile } from "./importOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import {
  cancelBackgroundJob,
  getBackgroundJob,
  listBackgroundJobs,
  startBackgroundJob,
  waitForBackgroundJob,
  type BackgroundJobView
} from "./backgroundJobOps.js";
import { gitDiff, gitDiffStatus, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { hasSecretValue, redactSensitiveText, redactStructured } from "./redact.js";
import { inspectWorkspace, invalidateWorkspaceAnalysis, reviewWorkspaceChanges } from "./analysis/index.js";
import {
  beginDirectOperation,
  createCodingTask,
  finishDirectOperation,
  getCodingTask,
  listCodingTasks,
  requestCodingTaskCancellation,
  resolveCodingTaskWorkspace,
  reviewCodingTask,
  transitionCodingTaskExecutor
} from "./codingTaskOps.js";
import type { CodingTaskState } from "./codingTaskState.js";
import {
  cancelQueuedCodingTaskRun,
  getCodingTaskRun,
  getLatestCodingTaskRun,
  launchCodingTaskRun,
  reconcileCodingTaskRun,
  submitCodingTaskFollowup,
  type CodingTaskRunView
} from "./codingTaskRunner.js";
import { resolveCodingTaskBaseSha, type CodingTaskReviewSnapshot } from "./codingTaskWorktree.js";
import { approveGoal, completeGoal, getGoal, listGoals, pauseGoal, proposeGoal, publishGoalBlackboard, resumeGoal } from "./goalOps.js";
import { GOAL_RETRYABLE_FAILURES_V1, type GoalState, type GoalWorkTurnObservation } from "./goalState.js";
import { createGoalContentPolicySnapshot } from "./goalPolicy.js";
import {
  getPersistentGoalScheduler,
  reconcilePersistentGoalCancellation,
  requestPersistentGoalCancel,
  resumePersistentGoal,
  startPersistentGoal,
  type GoalSchedulerView
} from "./goalScheduler.js";
import { applyCompletedGoal, cancelGoal, integrateGoalWork, projectGoal, refreshGoal, revertGoalProjection, reviewGoal, startGoal } from "./goalExecution.js";

const STRUCTURED_STRING_MAX_CHARS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

function compactStructuredContent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= STRUCTURED_STRING_MAX_CHARS) return value as T;
    return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]` as T;
  }
  if (Array.isArray(value)) return value.map((item) => compactStructuredContent(item, depth + 1)) as T;
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactStructuredContent(item, depth + 1);
  }
  return out as T;
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: CodexProConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexPro card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

function backgroundJobText(title: string, job: BackgroundJobView): string {
  const lines = [
    `# ${title}`,
    "",
    `Job: \`${job.job_id}\``,
    `Key: \`${job.job_key}\``,
    `Status: ${job.status}${job.persisted_status !== job.status ? ` (persisted: ${job.persisted_status})` : ""}`,
    `CWD: ${job.cwd}`,
    `Exit: ${job.exit_code ?? "pending"}${job.signal ? ` (${job.signal})` : ""}`,
    `Duration: ${job.duration_ms ?? "pending"} ms`,
    `Runner: ${job.runner_alive ? "alive" : "not running"}; child: ${job.child_alive ? "alive" : "not running"}`,
    `Logs: stdout ${job.stdout_bytes} bytes${job.stdout_truncated ? " (retention cap reached)" : ""}, stderr ${job.stderr_bytes} bytes${job.stderr_truncated ? " (retention cap reached)" : ""}.`
  ];
  if (job.reused !== undefined) lines.push(`Idempotent reuse: ${job.reused ? "yes" : "no"}`);
  if (job.git_guard) {
    lines.push(
      `Git guard: expected ${job.git_guard.expected_head ?? "any HEAD"}; clean required: ${job.git_guard.require_clean_worktree ? "yes" : "no"}; verified ${job.git_guard.verified_head ?? "pending"}${job.git_guard.verified_clean === null ? "" : `; clean: ${job.git_guard.verified_clean ? "yes" : "no"}`}.`
    );
  }
  if (job.stdout_tail) lines.push("", "## stdout tail", "", "```text", job.stdout_tail, "```");
  if (job.stderr_tail) lines.push("", "## stderr tail", "", "```text", job.stderr_tail, "```");
  if (job.error) lines.push("", `Error: ${job.error}`);
  if (!job.terminal) {
    lines.push("", "This job is durable and continues independently of the current MCP request. Use wait_for_background_job or get_background_job; do not start it again with a different key as a retry.");
  }
  return lines.join("\n");
}

function codingTaskStoreConfig(config: CodexProConfig): { dataRoot: string } {
  return { dataRoot: config.codingTaskDir };
}

function goalStoreConfig(config: CodexProConfig): { dataRoot: string } {
  return { dataRoot: config.codingTaskDir };
}

export function goalOrchestrationSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function goalLiveProjectionSupported(platform: NodeJS.Platform = process.platform): boolean {
  return goalOrchestrationSupported(platform);
}

function assertGoalLiveProjectionSupported(): void {
  if (!goalLiveProjectionSupported()) {
    throw new CodexProError("Goal orchestration is unavailable on Windows because the required crash-safe locking and no-follow source-write primitives are not supported. Use Direct coding or a standalone CodingTask; no Goal or projection state was changed.");
  }
}

function assertGoalSourceAllowed(config: CodexProConfig, goal: GoalState): void {
  if (!config.allowedRoots.some((allowedRoot) => {
    const relative = path.relative(allowedRoot, goal.sourceRoot);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  })) throw new CodexProError(`Goal source is outside the currently allowed roots: ${goal.goalId}`);
}

async function allowedGoal(config: CodexProConfig, goalId: string): Promise<GoalState> {
  const goal = await getGoal(goalStoreConfig(config), goalId);
  assertGoalSourceAllowed(config, goal);
  return goal;
}

async function goalMutationErrorResult(config: CodexProConfig, goalId: string, error: unknown): Promise<any> {
  const message = errorText(error);
  const mutationError = publicGoalError(message);
  try {
    const goal = await allowedGoal(config, goalId);
    const projection = goal.live?.pendingProjectionId
      ? goal.live.projections.find((item) => item.projectionId === goal.live?.pendingProjectionId)
      : goal.live?.projections.at(-1);
    const recoveryRequired = projection?.status === "recovery_required";
    const publicMessage = `${recoveryRequired ? "Goal source operation recovery requires user action" : "Goal source operation was rejected"}. Detailed local error text remains private. Error SHA-256: ${mutationError.errorSha256}.`;
    return {
      isError: true,
      content: [{ type: "text", text: publicMessage }],
      structuredContent: redactStructured({
        ...goalStructured(goal),
        mutation_error: mutationError,
        projection: projection ? publicGoalProjection(projection) : null,
        projection_id: projection?.projectionId ?? null,
        projection_status: projection?.status ?? null,
        recovery_required: recoveryRequired
      })
    };
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: `Goal source operation was rejected. Detailed local error text remains private. Error SHA-256: ${mutationError.errorSha256}.` }],
      structuredContent: { mutation_error: mutationError, recovery_required: false }
    };
  }
}

function boundedGoalText(value: string | undefined, max = 500): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function safeGoalSummary(value: string | undefined, max = 500): string | undefined {
  const bounded = boundedGoalText(value, max);
  return bounded === undefined ? undefined : redactSensitiveText(bounded);
}

function publicGoalError(value: string | undefined): { hasError: boolean; errorSha256: string | null } {
  return {
    hasError: Boolean(value),
    errorSha256: value ? createHash("sha256").update(value).digest("hex") : null
  };
}

function publicGoalObservation(observation: GoalWorkTurnObservation | undefined): Record<string, unknown> | null {
  if (!observation) return null;
  return {
    capturedAt: observation.capturedAt,
    headSha: observation.headSha,
    statusSha256: observation.statusSha256 ?? null,
    diffStatSha256: observation.diffStatSha256 ?? null,
    diffSha256: observation.diffSha256,
    dirty: observation.dirty,
    changedPathsSha256: observation.changedPathsSha256 ?? null,
    changedPathCount: observation.changedPathCount ?? observation.changedPaths.length
  };
}

function publicGoalReview(review: CodingTaskReviewSnapshot): Omit<CodingTaskReviewSnapshot, "worktreeRoot"> {
  const { worktreeRoot: _privateWorktreeRoot, ...publicReview } = review;
  return publicReview;
}

function publicGoalProjection(projection: NonNullable<GoalState["live"]>["projections"][number]): Record<string, unknown> {
  return {
    projectionId: projection.projectionId,
    status: projection.status,
    fromIntegrationSha: projection.fromIntegrationSha,
    toIntegrationSha: projection.toIntegrationSha,
    reviewFingerprint: projection.reviewFingerprint,
    changedPaths: projection.changedPaths.slice(),
    changedPathCount: projection.changedPaths.length,
    preparedAt: projection.preparedAt,
    appliedAt: projection.appliedAt ?? null,
    revertedAt: projection.revertedAt ?? null,
    ...publicGoalError(projection.error)
  };
}

function publicGoalWork(goal: GoalState, work: GoalState["work"][number]): Record<string, unknown> {
  const turns = (work.turns ?? []).map((turn) => ({
    turnIndex: turn.turnIndex,
    intentId: turn.intentId,
    intentFingerprint: turn.intentFingerprint,
    promptSha256: turn.promptSha256,
    operationId: turn.operationId,
    previousOperationId: turn.previousOperationId ?? null,
    taskId: turn.taskId,
    baseSha: turn.baseSha,
    status: turn.status,
    runFingerprint: turn.runFingerprint ?? null,
    runStatus: turn.runStatus ?? null,
    threadId: turn.threadId ?? null,
    sessionId: turn.sessionId ?? null,
    turnId: turn.turnId ?? null,
    resultSummary: safeGoalSummary(turn.resultSummary, 1_000) ?? null,
    resultSha256: turn.resultSha256 ?? null,
    stopReason: turn.stopReason ?? null,
    attempts: (turn.attempts ?? []).slice(-3).map((attempt) => ({
      attemptIndex: attempt.attemptIndex,
      attemptNumber: attempt.attemptIndex + 1,
      operationId: attempt.operationId,
      status: attempt.status,
      runFingerprint: attempt.runFingerprint ?? null,
      runStatus: attempt.runStatus ?? null,
      threadId: attempt.threadId ?? null,
      sessionId: attempt.sessionId ?? null,
      turnId: attempt.turnId ?? null,
      scheduledAt: attempt.scheduledAt,
      notBefore: attempt.notBefore,
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      startObservation: publicGoalObservation(attempt.startObservation),
      terminalObservation: publicGoalObservation(attempt.terminalObservation),
      failure: attempt.failure ? {
        code: attempt.failure.code,
        category: attempt.failure.category,
        phase: attempt.failure.phase,
        retryable: attempt.failure.retryable,
        outcomeKnown: attempt.failure.outcomeKnown,
        turnStarted: attempt.failure.turnStarted,
        summarySha256: attempt.failure.summarySha256,
        occurredAt: attempt.failure.occurredAt
      } : null
    })),
    attemptCount: turn.attempts?.length ?? (turn.operationId ? 1 : 0),
    currentAttemptNumber: turn.attempts?.length ? (turn.attempts.at(-1)?.attemptIndex ?? 0) + 1 : (turn.operationId ? 1 : null),
    retriesUsed: Math.max(0, (turn.attempts?.length ?? 1) - 1),
    retryNotBefore: turn.attempts?.at(-1)?.status === "backoff" ? turn.attempts.at(-1)?.notBefore ?? null : null,
    terminalObservation: publicGoalObservation(turn.terminalObservation),
    reservedAt: turn.reservedAt,
    startedAt: turn.startedAt ?? null,
    finishedAt: turn.finishedAt ?? null
  }));
  const completedTurnCount = turns.filter((turn) => turn.status === "succeeded").length;
  const attemptCount = (work.turns ?? []).reduce((count, turn) => count + (turn.attempts?.length ?? (turn.operationId ? 1 : 0)), 0);
  const retriesUsed = (work.turns ?? []).reduce((count, turn) => count + Math.max(0, (turn.attempts?.length ?? 1) - 1), 0);
  const currentAttempt = turns.at(-1)?.attempts.at(-1);
  return {
    workId: work.workId,
    title: work.title,
    goalSummary: safeGoalSummary(work.goal, 500),
    acceptanceCriteria: work.acceptanceCriteria.slice(0, 20).map((item) => safeGoalSummary(item, 500)),
    verification: work.verification.slice(0, 20).map((item) => safeGoalSummary(item, 500)),
    dependsOn: work.dependsOn,
    parallelGroup: work.parallelGroup ?? null,
    fileGlobs: work.fileGlobs.slice(0, 100),
    status: work.status,
    continuationIntents: (work.continuationIntents ?? []).map((intent) => ({
      intentId: intent.intentId,
      fingerprint: intent.fingerprint,
      promptSummary: safeGoalSummary(intent.prompt, 240)
    })),
    turns,
    authorizedTurnCount: goal.limits.maxTurnsPerWorker,
    completedTurnCount,
    remainingTurnCount: Math.max(0, goal.limits.maxTurnsPerWorker - completedTurnCount),
    currentTurnIndex: turns.at(-1)?.turnIndex ?? null,
    attemptCount,
    currentAttemptNumber: currentAttempt?.attemptNumber ?? null,
    retriesUsed,
    retriesRemaining: Math.max(0, goal.limits.maxRetriesPerWorker - retriesUsed),
    retryNotBefore: currentAttempt?.status === "backoff" ? currentAttempt.notBefore : null,
    finalTurnAuthorized: turns.length === goal.limits.maxTurnsPerWorker && turns.at(-1)?.status === "succeeded",
    integrationBlockedUntilFinalTurn: goal.executionPolicy === "persistent" && work.status === "continuing",
    codingTaskId: work.codingTaskId ?? null,
    operationId: work.operationId ?? null,
    reviewDiffSha256: work.reviewDiffSha256 ?? null,
    integratedCommitSha: work.integratedCommitSha ?? null,
    summary: safeGoalSummary(work.summary, 1_000) ?? null,
    ...publicGoalError(work.error),
    startedAt: work.startedAt ?? null,
    finishedAt: work.finishedAt ?? null
  };
}

function publicGoal(goal: GoalState): Record<string, unknown> {
  const publicLive = goal.live ? {
    projectedIntegrationSha: goal.live.projectedIntegrationSha,
    pendingProjectionId: goal.live.pendingProjectionId ?? null,
    projections: goal.live.projections.slice(-20).map(publicGoalProjection),
    adoptedAt: goal.live.adoptedAt ?? null,
    adoptedProjectionId: goal.live.adoptedProjectionId ?? null,
    adoptedReviewFingerprint: goal.live.adoptedReviewFingerprint ?? null
  } : null;
  const publicCompletion = goal.completion ? {
    completionKey: goal.completion.completionKey,
    summary: safeGoalSummary(goal.completion.summary, 1_000),
    criteria: goal.completion.criteria.slice(0, 20).map((item) => ({ ...item, requirement: safeGoalSummary(item.requirement, 500), evidence: safeGoalSummary(item.evidence, 500) })),
    verification: goal.completion.verification.slice(0, 20).map((item) => ({ ...item, requirement: safeGoalSummary(item.requirement, 500), evidence: safeGoalSummary(item.evidence, 500) })),
    completedAt: goal.completion.completedAt,
    reviewFingerprint: goal.completion.reviewFingerprint ?? null
  } : null;
  const publicSourceApplication = goal.sourceApplication ? {
    applicationKey: goal.sourceApplication.applicationKey,
    status: goal.sourceApplication.status,
    patchSha256: goal.sourceApplication.patchSha256,
    sourceHeadSha: goal.sourceApplication.sourceHeadSha,
    sourceDirtyPathsBefore: goal.sourceApplication.sourceDirtyPathsBefore.slice(0, 100),
    sourceDirtyPathCountBefore: goal.sourceApplication.sourceDirtyPathsBefore.length,
    sourceDirtyPathsAfter: goal.sourceApplication.sourceDirtyPathsAfter?.slice(0, 100),
    sourceDirtyPathCountAfter: goal.sourceApplication.sourceDirtyPathsAfter?.length ?? null,
    startedAt: goal.sourceApplication.startedAt,
    appliedAt: goal.sourceApplication.appliedAt ?? null,
    zeroWrite: goal.sourceApplication.zeroWrite ?? false,
    adoptedProjectionId: goal.sourceApplication.adoptedProjectionId ?? null,
    reviewFingerprint: goal.sourceApplication.reviewFingerprint ?? null,
    ...publicGoalError(goal.sourceApplication.error)
  } : null;
  return {
    goalId: goal.goalId,
    title: goal.title,
    goalSummary: safeGoalSummary(goal.goal, 1_000),
    lifecycle: goal.lifecycle,
    revision: goal.revision,
    executionPolicy: goal.executionPolicy,
    workspacePolicy: goal.workspacePolicy,
    workerModel: goal.workerModel,
    workerEffort: goal.workerEffort,
    limits: goal.limits,
    permissions: {
      fileGlobs: goal.permissions.fileGlobs.slice(0, 100),
      fileGlobCount: goal.permissions.fileGlobs.length,
      commands: goal.permissions.commands.slice(0, 20),
      commandCount: goal.permissions.commands.length,
      network: goal.permissions.network,
      sourceEffects: goal.permissions.sourceEffects
    },
    retryPolicy: goal.retryPolicy ? {
      version: goal.retryPolicy.version,
      algorithm: goal.retryPolicy.algorithm,
      backoffMs: goal.retryPolicy.backoffMs,
      retryableFailures: goal.retryPolicy.retryableFailures,
      fingerprint: goal.retryPolicy.fingerprint
    } : null,
    approval: goal.approval,
    baseSha: goal.baseSha,
    integrationHeadSha: goal.integrationHeadSha ?? null,
    contractFingerprint: goal.contractFingerprint,
    sourceDirtyAtCreation: goal.sourceDirtyAtCreation,
    completionCriteria: goal.completionCriteria.slice(0, 20).map((item) => safeGoalSummary(item, 500)),
    verification: goal.verification.slice(0, 20).map((item) => safeGoalSummary(item, 500)),
    work: goal.work.map((work) => publicGoalWork(goal, work)),
    blackboard: goal.blackboard.slice(-20).map((record) => ({
      recordId: record.recordId,
      kind: record.kind,
      author: record.author,
      workId: record.workId ?? null,
      summary: safeGoalSummary(record.summary, 500),
      createdAt: record.createdAt
    })),
    scheduler: goal.scheduler ? {
      epoch: goal.scheduler.epoch,
      leaseId: goal.scheduler.leaseId,
      startKey: goal.scheduler.startKey,
      definitionFingerprint: goal.scheduler.definitionFingerprint,
      status: goal.scheduler.status,
      requestedAt: goal.scheduler.requestedAt,
      acquiredAt: goal.scheduler.acquiredAt ?? null,
      stoppedAt: goal.scheduler.stoppedAt ?? null,
      stopReason: goal.scheduler.stopReason ?? null,
      ...publicGoalError(goal.scheduler.error)
    } : null,
    live: publicLive,
    completion: publicCompletion,
    sourceApplication: publicSourceApplication,
    ...publicGoalError(goal.error),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    startedAt: goal.startedAt ?? null,
    finishedAt: goal.finishedAt ?? null
  };
}

function goalListSummary(goal: GoalState, schedulerFields: Record<string, unknown>): Record<string, unknown> {
  const scheduler = schedulerFields.scheduler && typeof schedulerFields.scheduler === "object" && !Array.isArray(schedulerFields.scheduler)
    ? schedulerFields.scheduler as Record<string, unknown>
    : undefined;
  return {
    goalId: goal.goalId,
    title: goal.title,
    lifecycle: goal.lifecycle,
    revision: goal.revision,
    executionPolicy: goal.executionPolicy,
    workspacePolicy: goal.workspacePolicy,
    approvalStatus: goal.approval.status,
    contractFingerprint: goal.contractFingerprint,
    workCount: goal.work.length,
    completedWorkCount: goal.work.filter((item) => ["integrated", "waiting_review"].includes(item.status)).length,
    runningWorkCount: goal.work.filter((item) => ["launching", "running", "continuing"].includes(item.status)).length,
    work: goal.work.map((work) => ({
      workId: work.workId,
      title: work.title,
      status: work.status,
      authorizedTurnCount: goal.limits.maxTurnsPerWorker,
      completedTurnCount: (work.turns ?? []).filter((turn) => turn.status === "succeeded").length,
      remainingTurnCount: Math.max(0, goal.limits.maxTurnsPerWorker - (work.turns ?? []).filter((turn) => turn.status === "succeeded").length),
      attemptCount: (work.turns ?? []).reduce((count, turn) => count + (turn.attempts?.length ?? (turn.operationId ? 1 : 0)), 0),
      retriesUsed: (work.turns ?? []).reduce((count, turn) => count + Math.max(0, (turn.attempts?.length ?? 1) - 1), 0),
      retriesRemaining: Math.max(0, goal.limits.maxRetriesPerWorker - (work.turns ?? []).reduce((count, turn) => count + Math.max(0, (turn.attempts?.length ?? 1) - 1), 0)),
      backoffAttemptCount: (work.turns ?? []).reduce((count, turn) => count + (turn.attempts ?? []).filter((attempt) => attempt.status === "backoff").length, 0)
    })),
    scheduler: scheduler ? {
      status: scheduler.status ?? null,
      runner_alive: scheduler.runner_alive ?? false,
      stranded: scheduler.stranded ?? false,
      recovery_needed: scheduler.recovery_needed ?? false,
      stop_reason: scheduler.stop_reason ?? null
    } : null,
    scheduler_alive: schedulerFields.scheduler_alive ?? false,
    recovery_needed: schedulerFields.recovery_needed ?? false,
    updatedAt: goal.updatedAt
  };
}

function goalStructured(goal: GoalState): Record<string, unknown> {
  const publicState = publicGoal(goal);
  const work = goal.work.map((item) => publicGoalWork(goal, item));
  return {
    goal: publicState,
    goal_id: goal.goalId,
    title: goal.title,
    lifecycle: goal.lifecycle,
    approval: goal.approval,
    contract_fingerprint: goal.contractFingerprint,
    revision: goal.revision,
    execution_policy: goal.executionPolicy,
    workspace_policy: goal.workspacePolicy,
    base_sha: goal.baseSha,
    integration_head_sha: goal.integrationHeadSha ?? null,
    live_projection_allowed: goal.workspacePolicy === "live" && goal.permissions.sourceEffects.apply,
    live_projection_supported: goalLiveProjectionSupported(),
    live: publicState.live,
    source_application: publicState.sourceApplication,
    work,
    work_count: goal.work.length,
    completed_work_count: goal.work.filter((item) => ["integrated", "waiting_review"].includes(item.status)).length,
    running_work_count: goal.work.filter((item) => ["launching", "running", "continuing"].includes(item.status)).length,
    blocked_work_count: goal.work.filter((item) => ["blocked", "failed"].includes(item.status)).length,
    blackboard: publicState.blackboard,
    blackboard_count: goal.blackboard.length
  };
}

function goalSchedulerStructured(view: GoalSchedulerView | undefined): Record<string, unknown> {
  if (!view || view.goal.executionPolicy !== "persistent") return {
    scheduler: null,
    scheduler_alive: false,
    scheduler_stranded: false,
    recovery_needed: false,
    available_actions: []
  };
  const authority = view.goal.scheduler;
  const runtime = view.runtime;
  const requestedAt = authority?.requestedAt ? Date.parse(authority.requestedAt) : Number.NaN;
  const queuedIsStale = authority?.status === "queued" && Number.isFinite(requestedAt) && Date.now() - requestedAt > 5_000;
  const schedulerStranded = view.goal.lifecycle === "running" && !view.schedulerAlive && (
    authority?.status === "failed" || authority?.status === "running" || queuedIsStale
  );
  const recoveryNeeded = schedulerStranded;
  const availableActions = view.goal.lifecycle === "approved"
    ? [{ tool: "start_goal", label: "Start persistent scheduling", execution_required: true }]
    : view.goal.lifecycle === "running"
      ? [
          ...(recoveryNeeded ? [{ tool: "start_goal", label: "Recover scheduler", start_key: authority?.startKey ?? null, execution_required: true }] : [{ tool: "pause_goal", label: "Pause scheduling", execution_required: false }]),
          { tool: "cancel_goal", label: "Cancel Goal", execution_required: false }
        ]
      : view.goal.lifecycle === "paused"
        ? [
            { tool: "resume_goal", label: "Resume and wake scheduler", execution_required: true },
            { tool: "cancel_goal", label: "Cancel Goal", execution_required: false }
          ]
        : view.goal.lifecycle === "canceling"
          ? [{ tool: "refresh_goal", label: "Refresh cancellation", execution_required: false }]
          : [];
  return {
    scheduler: {
      status: runtime?.status ?? authority?.status ?? "not_started",
      authority_status: authority?.status ?? null,
      runner_alive: view.schedulerAlive,
      heartbeat_at: runtime?.heartbeatAt ?? null,
      stopped_at: runtime?.stoppedAt ?? authority?.stoppedAt ?? null,
      stop_reason: runtime?.stopReason ?? authority?.stopReason ?? null,
      has_error: publicGoalError(runtime?.error ?? authority?.error).hasError,
      error_sha256: publicGoalError(runtime?.error ?? authority?.error).errorSha256,
      stranded: schedulerStranded,
      recovery_needed: recoveryNeeded,
      recovery_action: recoveryNeeded ? "start_goal" : null,
      start_key: authority?.startKey ?? view.definition?.startKey ?? null,
      definition_fingerprint: authority?.definitionFingerprint ?? view.definition?.fingerprint ?? null
    },
    scheduler_alive: view.schedulerAlive,
    scheduler_stranded: schedulerStranded,
    recovery_needed: recoveryNeeded,
    scheduler_health_authority: "read_only_observation",
    available_actions: availableActions
  };
}

async function passiveGoalSchedulerView(config: CodexProConfig, goal: GoalState): Promise<GoalSchedulerView | undefined> {
  if (goal.executionPolicy !== "persistent") return undefined;
  const view = await getPersistentGoalScheduler(goalStoreConfig(config), goal.goalId);
  assertGoalSourceAllowed(config, view.goal);
  return view;
}

function goalText(title: string, goal: GoalState): string {
  const lines = [
    `# ${title}`,
    "",
    `Goal: ${goal.goalId}`,
    `Title: ${goal.title}`,
    `Lifecycle: ${goal.lifecycle}`,
    `Approval: ${goal.approval.status}`,
    `Revision: ${goal.revision}`,
    `Policy: ${goal.executionPolicy} / ${goal.workspacePolicy}`,
    `Contract: ${goal.contractFingerprint}`,
    `Base: ${goal.baseSha}`,
    "",
    "## Work",
    ...goal.work.map((item) => `- ${item.workId}: ${item.title} [${item.status}]${item.dependsOn.length ? ` · after ${item.dependsOn.join(", ")}` : ""}`)
  ];
  if (goal.lifecycle === "proposed") lines.push("", "No worker or integration worktree has started. Explicitly approve this exact contract before execution.");
  return lines.join("\n");
}

function assertCodingTaskSourceAllowed(config: CodexProConfig, task: CodingTaskState): void {
  if (!config.allowedRoots.some((allowedRoot) => {
    const relative = path.relative(allowedRoot, task.sourceRoot);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  })) {
    throw new CodexProError(`Coding task source is outside the currently allowed roots: ${task.taskId}`);
  }
}

async function allowedCodingTask(config: CodexProConfig, taskId: string): Promise<CodingTaskState> {
  const task = await getCodingTask(codingTaskStoreConfig(config), taskId);
  assertCodingTaskSourceAllowed(config, task);
  return task;
}

function assertIndependentCodingTaskControl(task: CodingTaskState, action: string): void {
  if (task.goalId) {
    throw new CodexProError(`${action} is owned by Goal ${task.goalId}; use the Goal control flow so Pro remains the assignment and integration authority.`);
  }
}

function codingTaskStructured(task: CodingTaskState): Record<string, unknown> {
  return {
    task,
    task_id: task.taskId,
    workspace_id: task.workspaceId,
    title: task.title,
    goal: task.goal,
    goal_id: task.goalId ?? null,
    goal_work_id: task.goalWorkId ?? null,
    executor: task.executor,
    lifecycle: task.lifecycle,
    revision: task.revision,
    executor_epoch: task.executorLease.epoch,
    lease_id: task.executorLease.leaseId,
    worktree_root: task.worktreeRoot,
    base_sha: task.baseSha,
    base_head: task.baseSha,
    codex_thread_id: task.codexThreadId ?? null,
    codex_turn_id: task.codexTurnId ?? null,
    thread_id: task.codexThreadId ?? null,
    turn_id: task.codexTurnId ?? null,
    active_operation: task.activeOperation ?? null
  };
}

function assertCodingTaskExecutionEnabled(config: CodexProConfig): void {
  if (config.writeMode !== "workspace" || config.bashMode !== "full") {
    throw new CodexProError("CodingTask creation and Codex execution require writeMode=workspace and bashMode=full for this trusted local workspace. These controls are never broadened automatically.");
  }
}

function goalExecutionEnabled(config: CodexProConfig): boolean {
  return config.writeMode === "workspace" && config.bashMode === "full";
}

function assertGoalExecutionEnabled(config: CodexProConfig): void {
  if (!goalExecutionEnabled(config)) {
    throw new CodexProError("Starting or waking Goal execution requires writeMode=workspace and bashMode=full. Passive status, pause, refresh, review, and cancellation remain available.");
  }
}

function assertGoalSourceWriteEnabled(config: CodexProConfig): void {
  if (config.writeMode !== "workspace") {
    throw new CodexProError("Goal source projection, projection revert, and final source application require writeMode=workspace. They do not require bashMode=full and never resolve or launch a Codex executable.");
  }
}

async function resolveCodexExecutable(config: CodexProConfig): Promise<string> {
  if (config.codexBin) return config.codexBin;
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(directory, process.platform === "win32" ? "codex.exe" : "codex");
    try {
      await fsp.access(candidate, fsConstants.X_OK);
      return await fsp.realpath(candidate);
    } catch {
      // Continue through the configured PATH; no shell or repository hooks are involved.
    }
  }
  throw new CodexProError("Codex executable was not configured and could not be resolved from PATH. Set CODEXPRO_CODEX_BIN before transferring ownership to Codex.");
}

function codingTaskText(title: string, task: CodingTaskState): string {
  const active = task.activeOperation
    ? `${task.activeOperation.kind} (${task.activeOperation.operationId})`
    : "none";
  return [
    `# ${title}`,
    "",
    `Task: \`${task.taskId}\``,
    `Workspace: \`${task.workspaceId}\``,
    `Title: ${task.title}`,
    `Executor: ${task.executor}`,
    `Status: ${task.lifecycle}`,
    `Revision: ${task.revision}`,
    `Executor epoch: ${task.executorLease.epoch}`,
    `Active operation: ${active}`,
    `Worktree: ${task.worktreeRoot}`,
    task.resultSummary ? `Result: ${task.resultSummary}` : "",
    task.error ? `Error: ${task.error}` : ""
  ].filter(Boolean).join("\n");
}

function codingTaskRunText(title: string, task: CodingTaskState, run: CodingTaskRunView): string {
  return [
    codingTaskText(title, task),
    "",
    "## Codex run",
    "",
    `Operation: \`${run.operationId}\``,
    `Run status: ${run.status}`,
    `Runner: ${run.runnerAlive ? "alive" : "not running"}`,
    `Thread: ${run.threadId ?? task.codexThreadId ?? "pending"}`,
    run.finalText ? "\n## Codex response\n\n" + run.finalText : "",
    run.error ? `\nError: ${run.error}` : "",
    ["queued", "running"].includes(run.status)
      ? "\nThe detached Codex runner continues independently. Use get_coding_task to observe persisted state, followup_coding_task to steer the active turn, or cancel_coding_task to stop it."
      : ""
  ].filter(Boolean).join("\n");
}

async function withDirectTaskOperation<T>(
  config: CodexProConfig,
  workspace: Workspace,
  label: string,
  operation: () => Promise<T> | T
): Promise<{ result: T; task?: CodingTaskState }> {
  if (!workspace.codingTaskId) return { result: await operation() };
  const taskConfig = codingTaskStoreConfig(config);
  const current = await getCodingTask(taskConfig, workspace.codingTaskId);
  assertCodingTaskSourceAllowed(config, current);
  const operationId = `direct_${randomUUID()}`;
  const started = await beginDirectOperation(taskConfig, current.taskId, {
    expectedRevision: current.revision,
    executorEpoch: current.executorLease.epoch,
    leaseId: current.executorLease.leaseId,
    operationId
  });
  let result!: T;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  let task: CodingTaskState;
  try {
    task = await finishDirectOperation(taskConfig, current.taskId, {
      executorEpoch: started.executorLease.epoch,
      leaseId: started.executorLease.leaseId,
      operationId,
      lifecycle: "ready",
      resultSummary: operationError ? undefined : `${label} completed.`,
      error: operationError ? errorText(operationError) : undefined
    });
  } catch (cleanupError) {
    if (operationError) {
      throw new CodexProError(`${errorText(operationError)}\nDirect-operation lease cleanup also failed: ${errorText(cleanupError)}`);
    }
    throw cleanupError;
  }
  if (operationError) throw operationError;
  return { result, task };
}

function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
  const inputSchema = options.inputSchema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
      shape[key] = value as z.ZodTypeAny;
    }
  }
  if (!Object.keys(shape).length) return {};
  const parsed = z.object(shape).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  const tagged = {
    codexpro_tool: name,
    codexpro_title: options.title ?? name,
    ...base
  };
  const meta = (options._meta as Record<string, unknown> | undefined) ?? {};
  result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const TOOL_CARD_RENDER_TOOL_NAMES = new Set<string>([
  "codexpro",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "show_changes",
  "git_status",
  "handoff_to_agent",
  "handoff_to_codex",
  "bash",
  "create_coding_task",
  "get_coding_task",
  "list_coding_tasks",
  "transition_coding_task",
  "run_coding_task",
  "followup_coding_task",
  "cancel_coding_task",
  "review_coding_task",
  "propose_goal",
  "get_goal",
  "list_goals",
  "approve_goal",
  "publish_goal_blackboard",
  "start_goal",
  "refresh_goal",
  "integrate_goal_work",
  "review_goal",
  "project_goal",
  "revert_goal_projection",
  "pause_goal",
  "resume_goal",
  "cancel_goal",
  "complete_goal",
  "apply_goal"
]);

const GOAL_TOOL_NAMES = new Set<string>([
  "propose_goal",
  "get_goal",
  "list_goals",
  "approve_goal",
  "publish_goal_blackboard",
  "start_goal",
  "refresh_goal",
  "integrate_goal_work",
  "review_goal",
  "project_goal",
  "revert_goal_projection",
  "pause_goal",
  "resume_goal",
  "cancel_goal",
  "complete_goal",
  "apply_goal"
]);

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

function usesToolCard(config: CodexProConfig, name: string): boolean {
  return config.toolCards && TOOL_CARD_RENDER_TOOL_NAMES.has(name);
}

function descriptorOptionsForConfig(config: CodexProConfig, name: string, options: Record<string, unknown>): Record<string, unknown> {
  if (usesToolCard(config, name)) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
}

function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  if (config.connectionTest) return;
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    // The historical default is the CodexPro documentation site, not a dedicated
    // component host. Advertising it as ui.domain makes hosts mount the cached MCP
    // template against that unrelated origin. Omit the implicit legacy value so the
    // MCP Apps host uses its sandbox; preserve explicitly configured custom origins.
    const widgetDomainMeta = config.widgetDomain === "https://rebel0789.github.io"
      ? {}
      : {
          domain: config.widgetDomain
        };
    const openAiWidgetDomainMeta = config.widgetDomain === "https://rebel0789.github.io"
      ? {}
      : {
          "openai/widgetDomain": config.widgetDomain
        };
    s.registerResource(
      name,
      uri,
      {
        title: "CodexPro Tool Card",
        description: "Compact visual renderer for CodexPro workspace, CodingTask, Goal, source-change, and handoff results.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                ...widgetDomainMeta,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders CodexPro workspace orientation, CodingTasks, Goals, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              ...openAiWidgetDomainMeta,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}

type CodexToolHandler = (args: any) => Promise<any> | any;

const SUPERTOOL_NAME = "codexpro";
const SUPERTOOL_ACTION_ALIASES: Record<string, string> = {
  actions: "list_actions",
  config: "server_config",
  self_test: "codexpro_self_test",
  inventory: "codexpro_inventory",
  open: "open_current_workspace",
  snapshot: "workspace_snapshot",
  changes: "show_changes",
  handoff_poll: "wait_for_handoff",
  pro_export: "export_pro_context",
  agent_handoff: "handoff_to_agent",
  codex_handoff: "handoff_to_codex",
  job_start: "start_background_job",
  job_status: "get_background_job",
  job_list: "list_background_jobs",
  job_wait: "wait_for_background_job",
  job_cancel: "cancel_background_job",
  task_create: "create_coding_task",
  task_get: "get_coding_task",
  task_list: "list_coding_tasks",
  task_transition: "transition_coding_task",
  task_run: "run_coding_task",
  task_followup: "followup_coding_task",
  task_cancel: "cancel_coding_task",
  task_review: "review_coding_task",
  goal_propose: "propose_goal",
  goal_get: "get_goal",
  goal_list: "list_goals",
  goal_approve: "approve_goal",
  goal_publish: "publish_goal_blackboard",
  goal_start: "start_goal",
  goal_refresh: "refresh_goal",
  goal_integrate: "integrate_goal_work",
  goal_review: "review_goal",
  goal_project: "project_goal",
  goal_revert: "revert_goal_projection",
  goal_pause: "pause_goal",
  goal_resume: "resume_goal",
  goal_cancel: "cancel_goal",
  goal_complete: "complete_goal",
  goal_apply: "apply_goal"
};

const registeredToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();

function rememberRegisteredToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
  const key = server as object;
  const handlers = registeredToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
  if (!registeredToolHandlersByServer.has(key)) registeredToolHandlersByServer.set(key, handlers);
  handlers.set(name, handler);
}

function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
  return registeredToolHandlersByServer.get(server as object)?.get(name);
}

function normalizeSupertoolAction(value: unknown): string {
  const raw = String(value ?? "list_actions").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return SUPERTOOL_ACTION_ALIASES[normalized] ?? normalized;
}


function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexProError(
      `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit/apply_patch only inside ${config.contextDir}/.`
    );
  }
  throw new CodexProError("write/edit/apply_patch tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

function registerToolCompat(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started);
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started);
      return result;
    }
  };

  const securitySchemes = [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...options,
    _meta: {
      securitySchemes,
      ...(options._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "start_background_job",
  "get_background_job",
  "list_background_jobs",
  "wait_for_background_job",
  "cancel_background_job",
  "create_coding_task",
  "get_coding_task",
  "list_coding_tasks",
  "transition_coding_task",
  "run_coding_task",
  "followup_coding_task",
  "cancel_coding_task",
  "review_coding_task",
  "propose_goal",
  "get_goal",
  "list_goals",
  "approve_goal",
  "publish_goal_blackboard",
  "start_goal",
  "refresh_goal",
  "integrate_goal_work",
  "review_goal",
  "project_goal",
  "revert_goal_projection",
  "pause_goal",
  "resume_goal",
  "cancel_goal",
  "complete_goal",
  "apply_goal",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "inspect_workspace",
  "tree",
  "search",
  "load_skill",
  "view_image",
  "read_handoff",
  "wait_for_handoff",
  "export_pro_context",
  "handoff_to_agent"
] as const;

const FULL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "codexpro_self_test",
  "codexpro_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "tree",
  "search",
  "read",
  "view_image",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "start_background_job",
  "get_background_job",
  "list_background_jobs",
  "wait_for_background_job",
  "cancel_background_job",
  "create_coding_task",
  "get_coding_task",
  "list_coding_tasks",
  "transition_coding_task",
  "run_coding_task",
  "followup_coding_task",
  "cancel_coding_task",
  "review_coding_task",
  "propose_goal",
  "get_goal",
  "list_goals",
  "approve_goal",
  "publish_goal_blackboard",
  "start_goal",
  "refresh_goal",
  "integrate_goal_work",
  "review_goal",
  "project_goal",
  "revert_goal_projection",
  "pause_goal",
  "resume_goal",
  "cancel_goal",
  "complete_goal",
  "apply_goal",
  "git_status",
  "git_diff",
  "show_changes",
  "read_handoff",
  "wait_for_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
] as const;

const CONNECTION_TEST_HIDDEN_TOOLS = new Set<string>([
  SUPERTOOL_NAME,
  "codexpro_self_test",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "start_background_job",
  "get_background_job",
  "list_background_jobs",
  "wait_for_background_job",
  "cancel_background_job",
  "create_coding_task",
  "get_coding_task",
  "list_coding_tasks",
  "transition_coding_task",
  "run_coding_task",
  "followup_coding_task",
  "cancel_coding_task",
  "review_coding_task",
  "propose_goal",
  "get_goal",
  "list_goals",
  "approve_goal",
  "publish_goal_blackboard",
  "start_goal",
  "refresh_goal",
  "integrate_goal_work",
  "review_goal",
  "project_goal",
  "revert_goal_projection",
  "pause_goal",
  "resume_goal",
  "cancel_goal",
  "complete_goal",
  "apply_goal",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
]);

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: CodexProConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (config.bashMode === "off") {
    for (const disabledTool of ["bash", "start_background_job"]) {
      const toolIndex = names.indexOf(disabledTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["write", "edit", "apply_patch", "import_file", "project_goal", "revert_goal_projection", "apply_goal"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (!goalExecutionEnabled(config)) {
    for (const executionTool of ["start_goal", "resume_goal"]) {
      const toolIndex = names.indexOf(executionTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (!goalOrchestrationSupported()) {
    for (const unsupportedTool of GOAL_TOOL_NAMES) {
      const toolIndex = names.indexOf(unsupportedTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (config.writeMode === "handoff" && !names.includes("handoff_to_agent")) names.push("handoff_to_agent");
  if (!config.analysisEnabled) {
    const analysisIndex = names.indexOf("inspect_workspace");
    if (analysisIndex !== -1) names.splice(analysisIndex, 1);
  }
  if (config.connectionTest) {
    for (const hiddenTool of CONNECTION_TEST_HIDDEN_TOOLS) {
      const toolIndex = names.indexOf(hiddenTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest && CONNECTION_TEST_HIDDEN_TOOLS.has(name)) return false;
  if (GOAL_TOOL_NAMES.has(name) && !goalOrchestrationSupported()) return false;
  if (["start_goal", "resume_goal"].includes(name) && !goalExecutionEnabled(config)) return false;
  if (name === "bash" && config.bashMode === "off") return false;
  if (name === "start_background_job" && config.bashMode === "off") return false;
  if (["write", "edit", "apply_patch", "import_file", "project_goal", "revert_goal_projection", "apply_goal"].includes(name) && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (name === "inspect_workspace" && !config.analysisEnabled) return false;
  if (name === "handoff_to_agent" && config.writeMode === "handoff") return true;
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
): void {
  if (!shouldRegisterTool(config, name)) return;
  const validatedHandler: CodexToolHandler = (args) => handler(validateToolArgs(name, options, args));
  registerToolCompat(server, name, descriptorOptionsForConfig(config, name, options), validatedHandler);
  rememberRegisteredTool(server, name);
  rememberRegisteredToolHandler(server, name, validatedHandler);
}

function serverInstructions(config: CodexProConfig): string {
  const editInstruction =
    config.connectionTest
      ? "4. Connection test mode is read-only. Write, patch, export, and handoff-writing tools are unavailable."
      : config.writeMode === "workspace"
      ? "4. Edit source files with write/edit/apply_patch. After edits, call show_changes once for git status, diff stats, and review diff."
      : config.writeMode === "handoff"
        ? "4. Source writes are disabled and generic write/edit/apply_patch tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
        : "4. Write/edit/apply_patch tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
  const bashInstruction =
    config.bashMode === "off"
      ? "5. Starting new shell commands is disabled. Existing durable background jobs may still be inspected, waited on, or explicitly canceled."
      : "5. Use bash for bounded verification commands. For work that may exceed 180 seconds or must survive MCP reconnects, use start_background_job once with a stable job_key, then wait_for_background_job/get_background_job. Never create a new key as an automatic retry.";

  return [
    "CodexPro connects ChatGPT to explicitly allowed local development workspaces.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different allowed root or asks to switch projects; that selection stays active for this MCP session.",
    "2. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    "3. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    editInstruction,
    bashInstruction,
    "6. For isolated implementation work, create one persistent CodingTask. Creation and Codex execution require explicit writeMode=workspace plus bashMode=full because App Server can execute beyond safe-bash commands. Use its taskws_* workspace for direct coding, or transition ownership to Codex and run/follow up there. Never mutate a CodingTask worktree unless the persisted executor is direct and no operation owns it.",
    goalOrchestrationSupported()
      ? "7. For complex multi-part work, Pro may call propose_goal with a complete bounded work graph. A proposal is inert. Supervised Goals keep one-turn, zero-retry worker launch and private integration as explicit Pro actions. Persistent Goals are isolated, command-free contracts with 1-4 upfront-approved semantic turns including the initial turn and 0-2 total fresh retries per work item. Ordered continuation prompts are immutable contract authority: the scheduler never invents or mutates them, and every turn stays on the same CodingTask, worktree, model, effort, Codex thread, and session. A fresh retry repeats the exact approved prompt under a new operation ID after the fingerprinted infra-pre-turn-v1 allowlist and 1s/5s backoff; it does not consume a semantic turn. Same-operation recovery is not a retry. Intermediate successful turns are re-attested but remain private and non-integrable; dependencies unlock and deterministic private integration occur only after the final authorized turn passes exact terminal, provenance, path, and content checks. Persistent Goals never project/apply source changes or complete themselves. Show the returned turn, retry-policy, continuation, and contract fingerprints before approve_goal, and never imply approval started workers. get/list/review are passive. refresh is store-only and never spawns or integrates. start and persistent resume require the explicit execution gate; scheduler-owned retries remain within that approved start authority. Only Pro may review, publish decisions, change scope, complete, or apply. Goal worktrees remain private and must not be passed to open_workspace, read, or bash."
      : "7. Goal orchestration is unavailable on Windows because the required crash-safe GoalStore locking contract is not supported. Use Direct coding or standalone CodingTasks; Goal tools are intentionally not advertised.",
    "8. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
    config.codexSessions !== "off"
      ? `7. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `8. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `8. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function reviewCheckpointKey(workspace: Workspace, options: { path?: string; staged: boolean }): string {
  return `${workspace.id}\0${options.path ?? ""}\0${options.staged ? "staged" : "unstaged"}`;
}

function reviewFingerprint(status: string, diff: string): string {
  return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
}

async function untrackedReviewFingerprint(config: CodexProConfig, guard: PathGuard, workspace: Workspace, changedFiles: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const line of changedFiles) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match) continue;
    const relPath = match[1];
    hash.update(relPath).update("\0");
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      hash.update(String(stat.size)).update("\0").update(String(Math.floor(stat.mtimeMs))).update("\0");
      if (stat.isFile() && stat.size <= config.maxReadBytes) {
        hash.update(await fsp.readFile(resolved.absPath));
      }
    } catch (error) {
      hash.update(errorText(error));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function decodeGitQuotedPath(pathText: string): string {
  const input = pathText.startsWith('"') && pathText.endsWith('"') ? pathText.slice(1, -1) : pathText;
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (!escapedBytes.length) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    i += 1;
    const escaped = input[i];
    if (escaped === undefined) throw new CodexProError(`Invalid quoted Git path: ${pathText}`);
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let j = 0; j < 2 && i + 1 < input.length && /[0-7]/.test(input[i + 1]); j += 1) {
        i += 1;
        octal += input[i];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
    } else {
      flushEscapedBytes();
      decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  flushEscapedBytes();
  return decoded;
}

function stripPatchPathComponents(filePath: string, stripComponents: number): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return filePath;
  let stripped = filePath;
  for (let i = 0; i < stripComponents; i += 1) {
    const slash = stripped.indexOf("/");
    if (slash < 0) return stripped;
    stripped = stripped.slice(slash + 1);
  }
  return stripped;
}

function normalizePatchPath(rawPath: string, stripComponents = 1): string | undefined {
  const raw = rawPath.trim().split("\t")[0]?.trim();
  if (!raw || raw === "/dev/null") return undefined;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? decodeGitQuotedPath(raw.slice(1, -1)) : raw;
  return stripPatchPathComponents(unquoted, stripComponents);
}

function patchHasSymlinkMode(patch: string): boolean {
  return patch.split(/\r?\n/).some((line) => /^(?:new|old|deleted) file mode 120000\s*$/.test(line) || /^new mode 120000\s*$/.test(line) || /^old mode 120000\s*$/.test(line));
}

function patchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const normalized = normalizePatchPath(line.slice(4));
      if (normalized) paths.add(normalized);
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      const normalized = normalizePatchPath(line.replace(/^(?:rename|copy) (?:from|to) /, ""), 0);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

async function applyWorkspacePatch(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): Promise<{ paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean }> {
  if (!patch.trim()) throw new CodexProError("patch is required.");
  if (Buffer.byteLength(patch, "utf8") > config.maxWriteBytes) {
    throw new CodexProError(`Patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(patch)) {
    throw new CodexProError("Secret-looking content is blocked from apply_patch. Use placeholders such as [REDACTED_SECRET].");
  }
  if (patchHasSymlinkMode(patch)) {
    throw new CodexProError("Symlink patches are blocked from apply_patch.");
  }

  const paths = patchTouchedPaths(patch);
  if (!paths.length) throw new CodexProError("Patch must include at least one file path.");
  const absPaths: string[] = [];
  for (const touchedPath of paths) {
    absPaths.push(guard.resolve(workspace, touchedPath, { forWrite: true }).absPath);
    assertWriteToolAllowed(config, touchedPath);
  }

  return withFileWriteLocks(absPaths, () => {
    for (const touchedPath of paths) {
      guard.resolve(workspace, touchedPath, { forWrite: true });
      assertWriteToolAllowed(config, touchedPath);
    }

    const check = spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: patch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (check.error || check.status !== 0) {
      throw new CodexProError(redactSensitiveText(check.stderr?.trim() || check.stdout?.trim() || check.error?.message || "git apply --check failed"));
    }

    const applied = spawnSync("git", ["apply", "--whitespace=nowarn"], {
      cwd: workspace.root,
      input: patch,
      encoding: "utf8",
      maxBuffer: config.maxOutputBytes,
      env: { ...process.env, NO_COLOR: "1" }
    });
    if (applied.error || applied.status !== 0) {
      throw new CodexProError(redactSensitiveText(applied.stderr?.trim() || applied.stdout?.trim() || applied.error?.message || "git apply failed"));
    }

    const diff = redactSensitiveText(patch.trimEnd());
    const stats = diffStats(diff);
    return {
      paths,
      stdout: redactSensitiveText(applied.stdout?.trim() || ""),
      stderr: redactSensitiveText(applied.stderr?.trim() || ""),
      diff,
      additions: stats.additions,
      deletions: stats.deletions,
      changed: true
    };
  });
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "(no output)" && !line.startsWith("##"));
}

function changedPathsFromStatus(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    let raw: string;
    if (line.startsWith("?? ")) raw = line.slice(3).trim();
    else if (line.includes("\t")) raw = line.split("\t").pop()?.trim() ?? "";
    else if (/^.{2}\s/.test(line)) raw = line.slice(3).trim();
    else continue;
    if (raw.includes(" -> ")) raw = raw.split(" -> ").pop() ?? raw;
    const decoded = decodeGitQuotedPath(raw);
    if (decoded && !paths.includes(decoded)) paths.push(decoded);
  }
  return paths;
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexProError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const CODEX_TASK_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true };
const GOAL_PLAN_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const GOAL_CONSENT_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const GOAL_APPROVAL_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true };
// Starting or resuming a Goal is an execution mutation, but it is not a
// destructive source mutation: workers and scheduler checkpoints remain in
// CodexPro-owned private worktrees, and source projection/application is a
// separate explicit authority. Marking these tools destructive makes ordinary
// Chat hosts hide the canonical execution entry points alongside genuinely
// destructive source actions.
const GOAL_EXECUTION_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true };
const BACKGROUND_JOB_START_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: true };
const BACKGROUND_JOB_CANCEL_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };

export function createCodexProServer(config: CodexProConfig): McpServer {
  const workspaces = new WorkspaceManager(config, {
    resolvePersistentTaskWorkspace: (workspaceId) => resolveCodingTaskWorkspace(
      codingTaskStoreConfig(config),
      workspaceId,
      { assertSourceWorkspace: (sourceRoot) => {
        if (!config.allowedRoots.some((root) => {
          const relative = path.relative(root, sourceRoot);
          return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        })) throw new CodexProError("CodingTask source workspace is outside allowed roots.");
      } }
    )
  });
  const reviewCheckpoints = new Map<string, string>();
  const guard = new PathGuard(config);
  const server = new McpServer({ name: "CodexPro", version: "0.30.0" }, { instructions: serverInstructions(config) });
  registeredToolNamesByServer.set(server as object, []);
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    SUPERTOOL_NAME,
    {
      title: "CodexPro Supertool",
      description:
        "Stable wrapper for advanced ChatGPT connector setups. Pass action plus args to call an already-registered CodexPro tool without changing the visible schema; it cannot call tools disabled by the current mode.",
      inputSchema: {
        action: z.string().optional().describe("Action or registered tool name. Use list_actions to see what this server mode allows."),
        args: z.record(z.any()).optional().describe("Arguments for the selected action. Same shape as the wrapped CodexPro tool.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro supertool action...",
        "openai/toolInvocation/invoked": "CodexPro supertool action complete"
      }
    },
    async (args) => {
      const action = normalizeSupertoolAction(args.action);
      const names = registeredToolNames(server).filter((name) => name !== SUPERTOOL_NAME);
      if (action === "list_actions" || action === "help") {
        const text = [
          "# CodexPro Supertool",
          "",
          "Use `codexpro` only when a stable wrapper is useful for ChatGPT connector caching or custom workflows. The explicit tools remain the preferred default because they give clearer descriptions and validation.",
          "",
          "## Available actions",
          "",
          names.length ? names.map((name) => `- ${name}`).join("\n") : "- none",
          "",
          "## Usage",
          "",
          "```json",
          JSON.stringify({ action: "search", args: { workspace_id: "ws_...", query: "needle", path: "src" } }, null, 2),
          "```"
        ].join("\n");
        return textResult(text, {
          actions: names,
          action_count: names.length,
          aliases: SUPERTOOL_ACTION_ALIASES,
          tool_mode: config.toolMode,
          bash_mode: config.bashMode,
          write_mode: config.writeMode
        });
      }

      if (action === SUPERTOOL_NAME) {
        throw new CodexProError("codexpro cannot call itself. Use action=list_actions to inspect available wrapped actions.");
      }

      const handler = registeredToolHandler(server, action);
      if (!handler) {
        throw new CodexProError(
          `CodexPro action is not available in the current mode: ${action}. ` +
            "Call codexpro with action=list_actions, or restart CodexPro with a broader tool mode if that action should be exposed."
        );
      }

      const childArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? args.args
          : {};
      let result: any;
      try {
        result = await handler(childArgs);
      } catch (error) {
        result = errorResult(error);
      }
      if (result && typeof result === "object") {
        const structured = result.structuredContent;
        result.structuredContent = {
          codexpro_tool: action,
          codexpro_title: action,
          codexpro_super_action: action,
          wrapped_tool: action,
          ...(structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {})
        };
      }
      return result;
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexPro server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro server config...",
        "openai/toolInvocation/invoked": "CodexPro server config ready"
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        codexBin: config.codexBin ?? null,
        codexModel: config.codexModel,
        codexReasoningEffort: config.codexReasoningEffort,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolCards: config.toolCards,
        connectionTest: config.connectionTest,
        analysisEnabled: config.analysisEnabled,
        analysisLimits: config.analysisLimits,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxImportBytes: config.maxImportBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        backgroundJobDir: config.backgroundJobDir,
        backgroundJobDefaultTimeoutMs: config.backgroundJobDefaultTimeoutMs,
        backgroundJobMaxLogBytes: config.backgroundJobMaxLogBytes,
        codingTaskDir: config.codingTaskDir,
        codingTaskDefaultTimeoutMs: config.codingTaskDefaultTimeoutMs,
        codingTaskMaxLogBytes: config.codingTaskMaxLogBytes,
        goalOrchestration: {
          supported: goalOrchestrationSupported(),
          unsupportedReason: goalOrchestrationSupported() ? null : "Windows does not provide the required GoalStore locking safety contract. Direct coding and CodingTasks remain available."
        },
        goalScheduling: {
          supported: goalOrchestrationSupported(),
          policies: goalOrchestrationSupported() ? ["supervised", "persistent"] : [],
          persistentSupported: goalOrchestrationSupported(),
          executionEnabled: goalOrchestrationSupported() && goalExecutionEnabled(config),
          disabledReason: goalExecutionEnabled(config) ? null : "start_goal and resume_goal require writeMode=workspace and bashMode=full.",
          requiresWriteMode: "workspace",
          requiresBashMode: "full",
          requiresCodexExecutable: true,
          runtime: "detached-node",
          usesShell: false,
          passiveTools: ["get_goal", "list_goals", "review_goal"],
          refreshRelaunches: false,
          recoveryTool: "start_goal",
          persistentContract: {
            workspacePolicy: "isolated",
            sourceEffects: false,
            commands: false,
            maxTurnsPerWorker: "1-4 total turns, including the initial turn",
            maxRetriesPerWorker: "0-2 total fresh retries per work item",
            retryAlgorithm: "infra-pre-turn-v1",
            retryBackoffMs: [1000, 5000],
            retryableFailures: GOAL_RETRYABLE_FAILURES_V1,
            retrySemantics: "same-operation recovery is not a retry; a fresh retry uses a new operation ID, repeats the exact approved semantic prompt, and does not consume a turn",
            continuationIntents: "persistent-only, ordered, mandatory, and contract-fingerprinted",
            automaticPrivateIntegration: true,
            integrationRequiresFinalAuthorizedTurn: true,
            automaticSourceProjection: false,
            automaticCompletion: false
          }
        },
        goalLiveProjection: {
          supported: goalLiveProjectionSupported(),
          unsupportedReason: goalLiveProjectionSupported() ? null : "Windows does not provide the required no-follow source-write safety primitive.",
          sourceWritesEnabled: goalLiveProjectionSupported() && config.writeMode === "workspace",
          requiresWriteMode: "workspace",
          requiresBashMode: false,
          requiresCodexExecutable: false
        },
        blockedGlobs: config.blockedGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length
      };
      return textResult(`# CodexPro Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: "CodexPro Self Test",
      description:
        "Run one controlled, local-only CodexPro diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit probe without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro self-test...",
        "openai/toolInvocation/invoked": "CodexPro self-test complete"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      let lastTaskState: CodingTaskState | undefined;
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        "pass",
        config.authToken
          ? "token configured"
          : config.requireHttpToken
            ? "token required when serving HTTP"
            : "token auth explicitly disabled"
      );
      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexPro Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            const leased = await withDirectTaskOperation(config, workspace, "self-test write/edit probe", async () => {
              await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
              await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
              const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
              if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
              return gitStatus(config, workspace, guard, probePath);
            });
            lastTaskState = leased.task ?? lastTaskState;
            const scopedStatus = leased.result;
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexPro Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const leased = await withDirectTaskOperation(config, workspace, "self-test bash probe", async () => {
              const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
              const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
              let unsafeExpansionBlocked = false;
              if (config.bashMode === "safe") {
                try { await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions); }
                catch { unsafeExpansionBlocked = true; }
              }
              return { pwd, unsafeExpansionBlocked };
            });
            lastTaskState = leased.task ?? lastTaskState;
            if (config.bashMode === "safe") {
              check("bash policy", leased.result.unsafeExpansionBlocked && leased.result.pwd.exitCode === 0 ? "pass" : "fail", leased.result.unsafeExpansionBlocked ? "safe bash allowed pwd and blocked environment expansion" : "safe bash allowed environment expansion unexpectedly");
            } else {
              check("bash policy", leased.result.pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexPro Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexPro exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        ...(lastTaskState ? codingTaskStructured(lastTaskState) : {}),
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_inventory",
    {
      title: "CodexPro Inventory",
      description:
        "List CodexPro modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro inventory...",
        "openai/toolInvocation/invoked": "CodexPro inventory ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const inventory = await codexproInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        name: z.string().describe("Exact skill name from skill_inventory or codexpro_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source override. Without it, the highest-precedence skill is loaded."),
        path: z.string().optional().describe("Optional exact sanitized path override for diagnostics or an explicitly selected suppressed duplicate."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: auto when source/path is not workspace."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to scan while resolving the requested skill. Default: 500."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      const includeGlobalDefault =
        args.source === undefined ||
        (args.source !== undefined && args.source !== "workspace") ||
        Boolean(requestedPath && !requestedPath.startsWith("$WORKSPACE/"));
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: requestedPath,
        includeGlobal: parseBool(args.include_global_skills, includeGlobalDefault),
        maxSkills: limitInt(args.max_skills, 500, 1, 500),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List workspaces opened in this MCP session and identify the currently selected workspace.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro workspaces...",
        "openai/toolInvocation/invoked": "CodexPro workspaces listed"
      }
    },
    async () => {
      const selectedWorkspaceId = workspaces.currentWorkspaceId();
      const current = workspaces.listWorkspaces();
      const text = current
        .map((workspace) => `- ${workspace.id} — ${workspace.root}${workspace.id === selectedWorkspaceId ? " (selected)" : ""} (opened ${workspace.openedAt})`)
        .join("\n");
      return textResult(text, {
        workspaces: current,
        count: current.length,
        selected_workspace_id: selectedWorkspaceId
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Open and select the configured default workspace for this MCP session. Use this to return to the launch workspace after switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexPro workspace...",
        "openai/toolInvocation/invoked": "Current CodexPro workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.selectDefaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open and select an allowed local project for this MCP session. Later tool calls may omit workspace_id to use this selection.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXPRO_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexPro workspace...",
        "openai/toolInvocation/invoked": "CodexPro workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexProError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(args.root ?? args.path);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "inspect_workspace",
    {
      title: "Inspect Workspace",
      description: "Build a bounded repository map with languages, project types, entrypoints, areas, symbols, relationships, and coverage warnings.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional workspace-relative area to emphasize. Default: entire workspace."),
        max_files: z.number().int().min(1).max(100000).optional().describe("Maximum returned file records. Default: 300."),
        include_symbols: z.boolean().optional().describe("Include symbols in structured output. Default: true."),
        include_relationships: z.boolean().optional().describe("Include relationships in structured output. Default: true."),
        max_symbols: z.number().int().min(1).max(100000).optional().describe("Maximum returned symbols. Analysis remains bounded by server config."),
        max_relationships: z.number().int().min(1).max(250000).optional().describe("Maximum returned relationships. Analysis remains bounded by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Inspecting workspace analysis...",
        "openai/toolInvocation/invoked": "Workspace analysis ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      if (args.path) guard.resolve(workspace, args.path);
      const result = await inspectWorkspace(config, guard, workspace);
      const prefix = typeof args.path === "string" && args.path.trim()
        ? guard.resolve(workspace, args.path).relPath.replace(/^\.\/?$/, "")
        : "";
      const inScope = (filePath: string) => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`);
      const areaInScope = (areaPath: string) => !prefix || areaPath === "." || inScope(areaPath) || prefix.startsWith(`${areaPath}/`);
      const cardWorkspaceAnalysis = usesToolCard(config, "inspect_workspace");
      const fileLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_files, 300, 1, config.analysisLimits.maxInventoryFiles);
      const symbolLimit = cardWorkspaceAnalysis ? 80 : limitInt(args.max_symbols, 500, 1, config.analysisLimits.maxSymbols);
      const relationshipLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_relationships, 800, 1, config.analysisLimits.maxRelationships);
      const scopedFiles = result.files.filter((file) => inScope(file.path));
      const scopedSymbols = result.symbols.filter((symbol) => inScope(symbol.path));
      const scopedRelationships = result.relationships.filter((relationship) => inScope(relationship.from) || inScope(relationship.to));
      const files = scopedFiles.slice(0, fileLimit);
      const symbols = args.include_symbols === false
        ? []
        : scopedSymbols.slice(0, symbolLimit);
      const relationships = args.include_relationships === false
        ? []
        : scopedRelationships.slice(0, relationshipLimit);
      const outputLimited = files.length < scopedFiles.length ||
        (args.include_symbols !== false && symbols.length < scopedSymbols.length) ||
        (args.include_relationships !== false && relationships.length < scopedRelationships.length);
      const outputWarnings = [
        ...result.warnings,
        ...(outputLimited ? ["Structured output was limited. Use path or max_* arguments to request a narrower or larger result."] : [])
      ];
      const text = [
        "# Workspace Analysis",
        "",
        `Workspace: ${workspace.root}`,
        `Projects: ${result.projectTypes.join(", ") || "unknown"}`,
        `Languages: ${result.languages.join(", ") || "unknown"}`,
        `Entrypoints: ${result.entrypoints.filter(inScope).join(", ") || "none detected"}`,
        `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files analyzed, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? " (partial)" : ""}`,
        `Returned: ${files.length} files, ${symbols.length} symbols, ${relationships.length} relationships`,
        ...(outputWarnings.length ? ["", "## Warnings", "", ...outputWarnings.map((warning) => `- ${warning}`)] : [])
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? ".",
        languages: result.languages,
        project_types: result.projectTypes,
        entrypoints: result.entrypoints.filter(inScope),
        important_files: result.importantFiles.filter(inScope),
        areas: result.areas.filter((area) => areaInScope(area.path)),
        files,
        symbols,
        relationships,
        coverage: result.coverage,
        warnings: outputWarnings,
        output_limited: outputLimited,
        returned: { files: files.length, symbols: symbols.length, relationships: relationships.length },
        cache: result.cache
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config."),
        intent: z.enum(["auto", "text", "symbol", "references", "impact"]).optional().describe("Optional structured search intent. Omit for legacy lexical behavior."),
        symbol: z.string().optional().describe("Optional symbol query. Uses repository analysis and overrides query text."),
        include_tests: z.boolean().optional().describe("Include related tests in structured results. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
        intent: args.intent,
        symbol: args.symbol,
        includeTests: args.include_tests === undefined ? undefined : parseBool(args.include_tests, false)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used
      };
      if (result.analysis) structured.analysis = result.analysis;
      return textResult(result.text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit/apply_patch unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const text = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n${result.text}\n\`\`\``;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "view_image",
    {
      title: "View Image",
      description: "Inspect a PNG, JPEG, GIF, or WebP image from the active workspace. Returns native MCP image content plus dimensions and SHA-256.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("Image path relative to workspace root."),
        max_bytes: z.number().int().min(4096).max(2000000).optional().describe("Maximum image bytes. Default: at least 1 MB, capped at 2 MB.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const result = await viewWorkspaceImage(config, guard, workspace, args.path, args.max_bytes);
      const dimensions = result.width && result.height ? `${result.width}x${result.height}` : "unknown";
      return {
        content: [
          {
            type: "text",
            text: `Image: ${result.path}\nType: ${result.mimeType}\nDimensions: ${dimensions}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}`
          },
          { type: "image", data: result.data, mimeType: result.mimeType }
        ],
        structuredContent: redactStructured({
          workspace_id: workspace.id,
          root: workspace.root,
          path: result.path,
          mime_type: result.mimeType,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes,
          sha256: result.sha256
        })
      };
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. New files use an atomic rename; existing files retain their inode and metadata. Returns a unified diff; pass the SHA from read when overwriting shared files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails instead of overwriting if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const leased = await withDirectTaskOperation(config, workspace, "write", () =>
        writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
          createDirs: args.create_dirs !== false,
          overwrite: args.overwrite !== false,
          expectedSha256: args.expected_sha256
        })
      );
      const result = leased.result;
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement while retaining the existing file inode and metadata. Returns a unified diff; pass the SHA from read to reject stale multi-session edits.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const leased = await withDirectTaskOperation(config, workspace, "edit", () =>
        editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
          replaceAll: parseBool(args.replace_all, false),
          expectedReplacements: args.expected_replacements,
          expectedSha256: args.expected_sha256
        })
      );
      const result = leased.result;
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply one unified diff patch inside the workspace. Paths are validated before applying. Prefer edit for tiny replacements and apply_patch for multi-file diffs.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        patch: z.string().describe("Unified diff patch to apply. File paths must stay inside the workspace and avoid blocked paths.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const leased = await withDirectTaskOperation(config, workspace, "apply_patch", () =>
        applyWorkspacePatch(config, guard, workspace, String(args.patch ?? ""))
      );
      const result = leased.result;
      if (result.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = [
        "# Apply Patch",
        "",
        `Paths: ${result.paths.join(", ")}`,
        `Diff stats: +${result.additions} -${result.deletions}`,
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.diff ? diffBlock(result.diff) : "No diff output."
      ].filter(Boolean).join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        paths: result.paths,
        stdout: result.stdout,
        stderr: result.stderr,
        additions: result.additions,
        deletions: result.deletions,
        changed: result.changed,
        diff: result.diff,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "import_file",
    {
      title: "Import Attachment File",
      description:
        "Import a ChatGPT Apps SDK attachment into the workspace. Accepts only a platform file object with download_url and file_id. Not a general URL downloader. Overwrite is off by default.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        file: z
          .object({
            download_url: z.string().describe("Temporary HTTPS download URL provided by ChatGPT."),
            file_id: z.string().describe("ChatGPT file id for this attachment."),
            mime_type: z.string().optional().describe("Optional MIME type declared by ChatGPT."),
            file_name: z.string().optional().describe("Optional original file name declared by ChatGPT.")
          })
          .describe("ChatGPT Apps SDK file reference from openai/fileParams."),
        destination: z.string().describe("Destination path relative to the workspace root."),
        overwrite: z.boolean().optional().describe("Replace an existing destination file. Default: false."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 of the attachment bytes. Import fails on mismatch.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/fileParams": ["file"],
        "openai/toolInvocation/invoking": "Importing attachment...",
        "openai/toolInvocation/invoked": "Attachment imported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.destination, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await importAttachmentFile(config, guard, workspace, {
        file: args.file,
        destination: String(args.destination ?? ""),
        overwrite: args.overwrite === true,
        expectedSha256: args.expected_sha256
      });
      invalidateWorkspaceAnalysis(workspace.id);
      const text = [
        "# Import File",
        "",
        `Path: ${result.path}`,
        `Bytes: ${result.bytes}`,
        `SHA-256: ${result.sha256}`,
        `Declared MIME: ${result.declared_mime_type ?? "unknown"}`,
        `Detected MIME: ${result.detected_mime_type ?? "unknown"}`,
        `MIME status: ${result.mime_type_status}`,
        `Verified: ${result.verified}`,
        `Overwritten: ${result.overwritten}`
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        declared_mime_type: result.declared_mime_type,
        detected_mime_type: result.detected_mime_type,
        mime_type_status: result.mime_type_status,
        sha256: result.sha256,
        verified: result.verified,
        file_id: result.file_id,
        file_name: result.file_name,
        overwritten: result.overwritten
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command in the workspace, such as tests, build, lint, typecheck, or a project script. Do not use for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(config.maxBashTimeoutMs)
          .optional()
          .describe(`Timeout in milliseconds. Default: 30000. Max: ${config.maxBashTimeoutMs}.`)
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const leased = await withDirectTaskOperation(config, workspace, "bash", () =>
        runBash(config, guard, workspace, String(args.command ?? ""), {
          cwd: args.cwd,
          timeoutMs: args.timeout_ms,
          sessionId: args.session_id
        })
      );
      const result = leased.result;
      const text = bashTextResult(config, result);
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null, ...(leased.task ? codingTaskStructured(leased.task) : {}) });
    }
  );

  registerCodexTool(
    config,
    server,
    "start_background_job",
    {
      title: "Start Durable Background Job",
      description:
        "Start one durable workspace command that may run for hours and must survive ChatGPT/MCP disconnects or CodexPro server restarts. The call returns quickly with a deterministic job id; a separate local runner owns the process and persists status plus bounded logs outside the repository. job_key is an idempotency key: repeating the same request returns the existing job and never starts a duplicate. A reused key with a changed command, cwd, timeout, log, or Git guard contract is rejected. Optional Git HEAD and clean-worktree guards are checked before launch and again by the detached runner. This tool never retries failed jobs and never advances a benchmark to judge/report automatically. Use wait_for_background_job or get_background_job after starting.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        job_key: z.string().min(1).max(160).describe("Stable idempotency key, for example v3.3.0-report-attribution-151cc47:run. Use a different explicit key only for an intentional new command."),
        command: z.string().min(1).max(50_000).describe("One command to run under bash in the selected workspace. The current bash mode and session guard still apply."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to the workspace root. Default: ."),
        timeout_ms: z.number().int().min(1_000).max(24 * 60 * 60_000).optional().describe(`Durable job timeout in milliseconds, up to 24 hours. Default: ${config.backgroundJobDefaultTimeoutMs}.`),
        expected_git_head: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe("Optional full Git commit SHA. The command is not started unless the selected workspace repository is still at this exact HEAD."),
        require_clean_worktree: z.boolean().optional().describe("When true, reject staged, unstaged, or untracked Git changes. Checked before launch and again in the detached runner. Default: false.")
      },
      annotations: BACKGROUND_JOB_START_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      if (workspace.codingTaskId) {
        throw new CodexProError("Durable background jobs are not supported inside CodingTask worktrees because executor ownership cannot be transferred safely while they run. Use bounded bash or Codex collaboration.");
      }
      const job = await startBackgroundJob(config, guard, workspace, String(args.command ?? ""), {
        jobKey: String(args.job_key ?? ""),
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id,
        expectedGitHead: args.expected_git_head,
        requireCleanWorktree: args.require_clean_worktree
      });
      return textResult(backgroundJobText("Durable Background Job", job), {
        workspace_id: workspace.id,
        root: workspace.root,
        job
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "get_background_job",
    {
      title: "Get Durable Background Job",
      description:
        "Read the authoritative persisted status and bounded stdout/stderr tail for one durable background job. Works after MCP reconnects and CodexPro server restarts. It never starts, retries, or cancels a process.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        job_id: z.string().optional().describe("Job id returned by start_background_job. Provide job_id or job_key."),
        job_key: z.string().max(160).optional().describe("Stable idempotency key used at start. Provide job_id or job_key."),
        tail_bytes: z.number().int().min(0).max(30_000).optional().describe("Maximum bytes to read from the end of each log. Default: 4000.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const job = await getBackgroundJob(config, workspace, {
        jobId: args.job_id,
        jobKey: args.job_key,
        tailBytes: args.tail_bytes
      });
      return textResult(backgroundJobText("Durable Background Job Status", job), {
        workspace_id: workspace.id,
        root: workspace.root,
        job
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_background_jobs",
    {
      title: "List Durable Background Jobs",
      description:
        "List durable background jobs belonging to the selected workspace, newest first. Use this to recover a job id after reconnecting. It never reads another allowed workspace's jobs and never starts or changes processes.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum jobs to return. Default: 20."),
        include_terminal: z.boolean().optional().describe("Include completed, failed, timed-out, and canceled jobs. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const jobs = await listBackgroundJobs(config, workspace, {
        limit: args.limit,
        includeTerminal: args.include_terminal ?? true
      });
      const body = jobs.length
        ? jobs.map((job) => `- \`${job.job_id}\` · \`${job.job_key}\` · ${job.status} · ${job.duration_ms ?? "pending"} ms`).join("\n")
        : "- none";
      return textResult(`# Durable Background Jobs\n\n${body}`, {
        workspace_id: workspace.id,
        root: workspace.root,
        jobs,
        count: jobs.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "wait_for_background_job",
    {
      title: "Wait for Durable Background Job",
      description:
        "Read-only bounded wait for a durable background job. It waits at most 60 seconds, returns sooner on terminal status, and can be called repeatedly without affecting the process. The job continues independently when this call returns or the MCP connection drops.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        job_id: z.string().optional().describe("Job id returned by start_background_job. Provide job_id or job_key."),
        job_key: z.string().max(160).optional().describe("Stable idempotency key used at start. Provide job_id or job_key."),
        wait_ms: z.number().int().min(0).max(60_000).optional().describe("Maximum time to wait during this call. Default: 10000."),
        tail_bytes: z.number().int().min(0).max(30_000).optional().describe("Maximum bytes to read from the end of each log. Default: 4000.")
      },
      annotations: SESSION_READ_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const job = await waitForBackgroundJob(config, workspace, {
        jobId: args.job_id,
        jobKey: args.job_key,
        waitMs: args.wait_ms,
        tailBytes: args.tail_bytes
      });
      return textResult(backgroundJobText("Durable Background Job Wait", job), {
        workspace_id: workspace.id,
        root: workspace.root,
        job
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "cancel_background_job",
    {
      title: "Cancel Durable Background Job",
      description:
        "Explicitly request cancellation of one durable background job and wait briefly for authoritative terminal status. The runner sends SIGTERM to the job process group and escalates to SIGKILL after five seconds. Repeating the same cancellation is idempotent. This tool never deletes job state or logs and never cancels jobs from another workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        job_id: z.string().optional().describe("Job id returned by start_background_job. Provide job_id or job_key."),
        job_key: z.string().max(160).optional().describe("Stable idempotency key used at start. Provide job_id or job_key."),
        reason: z.string().max(500).optional().describe("Optional human-readable cancellation reason recorded with the request."),
        wait_ms: z.number().int().min(0).max(10_000).optional().describe("Maximum time to wait for terminal status after requesting cancellation. Default: 5000."),
        tail_bytes: z.number().int().min(0).max(30_000).optional().describe("Maximum bytes to read from the end of each log. Default: 4000.")
      },
      annotations: BACKGROUND_JOB_CANCEL_ANNOTATIONS
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const job = await cancelBackgroundJob(config, workspace, {
        jobId: args.job_id,
        jobKey: args.job_key,
        reason: args.reason,
        waitMs: args.wait_ms,
        tailBytes: args.tail_bytes
      });
      return textResult(backgroundJobText("Durable Background Job Cancellation", job), {
        workspace_id: workspace.id,
        root: workspace.root,
        job
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace status",
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true."),
        since: z.enum(["last_shown", "workspace"]).optional().describe("Use last_shown to suppress unchanged repeated reviews. Default: last_shown."),
        mark_reviewed: z.boolean().optional().describe("Update the last-shown review checkpoint after this call. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const staged = parseBool(args.staged, false);
      const normalizedScopedPath = scopedPath?.trim() ? guard.resolve(workspace, scopedPath).relPath : undefined;
      const status = normalizeGitOutput(gitDiffStatus(config, guard, workspace, normalizedScopedPath, staged));
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, normalizedScopedPath, staged));
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const stats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const untrackedFingerprint = statusError ? "" : await untrackedReviewFingerprint(config, guard, workspace, changedFiles);
      const since = args.since === "workspace" ? "workspace" : "last_shown";
      const markReviewed = parseBool(args.mark_reviewed, true);
      const checkpointKey = reviewCheckpointKey(workspace, { path: normalizedScopedPath, staged });
      const fingerprint = reviewFingerprint(status, `${diff}\0${untrackedFingerprint}`);
      const checkpointHit = includeDiff && since === "last_shown" && reviewCheckpoints.get(checkpointKey) === fingerprint;
      const checkpointWritten = markReviewed && includeDiff;
      if (checkpointWritten) reviewCheckpoints.set(checkpointKey, fingerprint);
      const responseDiff = checkpointHit ? "" : includeDiff ? diff : "";
      const responseStats = checkpointHit ? { additions: 0, deletions: 0, changed: false } : stats;
      const changedPaths = statusError ? [] : changedPathsFromStatus(changedFiles);
      let analysis: Record<string, unknown> | undefined;
      if (config.analysisEnabled && changedPaths.length && !checkpointHit) {
        try {
          const impact = await reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
          analysis = {
            schema_version: impact.schemaVersion,
            changed_paths: impact.changedPaths,
            affected_areas: impact.affectedAreas,
            dependent_files: impact.dependentFiles,
            related_tests: impact.relatedTests,
            risk_signals: impact.riskSignals,
            recommended_commands: impact.recommendedCommands,
            coverage: impact.coverage,
            warnings: impact.warnings,
            cache: impact.cache
          };
        } catch (error) {
          analysis = {
            schema_version: 1,
            changed_paths: changedPaths,
            affected_areas: [],
            dependent_files: [],
            related_tests: [],
            risk_signals: [],
            recommended_commands: [],
            warnings: [`Change analysis unavailable: ${errorText(error)}`]
          };
        }
      }
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : checkpointHit
          ? "- No changes since last shown review."
          : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = checkpointHit
        ? "\n\nNo new diff since last shown review."
        : includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
            : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const analysisText = analysis
        ? `\n\n## Analysis\n\nAffected areas: ${(analysis.affected_areas as string[]).join(", ") || "none"}\nRisks: ${((analysis.risk_signals as Array<{ label?: string }>) ?? []).map((risk) => risk.label).filter(Boolean).join(", ") || "none"}\nRelated tests: ${((analysis.related_tests as Array<{ path?: string }>) ?? []).map((file) => file.path).filter(Boolean).join(", ") || "none"}`
        : "";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${responseStats.additions} -${responseStats.deletions}${diffText}${analysisText}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: checkpointHit ? [] : changedFiles,
        staged,
        include_diff: includeDiff,
        additions: responseStats.additions,
        deletions: responseStats.deletions,
        changed: !statusError && (checkpointHit ? false : changedFiles.length > 0 || responseStats.changed),
        diff: responseDiff,
        review_since: since,
        review_marked: checkpointWritten,
        review_checkpoint_hit: checkpointHit,
        ...(analysis ? { analysis } : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "wait_for_handoff",
    {
      title: "Wait For Handoff",
      description:
        "Read-only long-poll of the local handoff run state so ChatGPT can stay the planner/reviewer while a local executor runs. Reads .ai-bridge/handoff-run-state.json and returns the run status plus status/diff/log/test excerpts. It never starts processes or runs shell commands; it only observes local handoff state written by execute-handoff/watch-handoff/loop-handoff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        plan_hash: z.string().optional().describe("Expected current-plan.md hash. If set, only a terminal run with this plan_hash counts as completed."),
        since_iteration: z.number().int().min(0).optional().describe("Only treat a run with iteration greater than this as the awaited completion."),
        max_wait_seconds: z.number().int().min(1).max(60).optional().describe("Maximum seconds to long-poll before returning the current state. Default: 20."),
        poll_ms: z.number().int().min(250).max(5000).optional().describe("Poll interval in milliseconds. Default: 1000."),
        include_diff: z.boolean().optional().describe("Include the implementation diff excerpt when completed. Default: true."),
        include_log_excerpt: z.boolean().optional().describe("Include the tail of execution-log.jsonl when completed. Default: true."),
        include_tests: z.boolean().optional().describe("Include the loop-tests.txt excerpt when completed. Default: true.")
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Waiting for local handoff result...",
        "openai/toolInvocation/invoked": "Local handoff state ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const maxWaitSeconds = limitInt(args.max_wait_seconds, 20, 1, 60);
      const pollMs = limitInt(args.poll_ms, 1000, 250, 5000);
      const includeDiff = parseBool(args.include_diff, true);
      const includeLog = parseBool(args.include_log_excerpt, true);
      const includeTests = parseBool(args.include_tests, true);
      const expectedPlanHash =
        typeof args.plan_hash === "string" && args.plan_hash.trim() ? args.plan_hash.trim() : undefined;
      const sinceIteration =
        Number.isFinite(Number(args.since_iteration)) && args.since_iteration !== undefined
          ? Math.floor(Number(args.since_iteration))
          : undefined;

      const stateRel = `${config.contextDir}/handoff-run-state.json`;
      const contextPrefix = `${config.contextDir.replace(/\/+$/, "")}/`;
      const terminalStates = new Set(["completed", "failed", "timed_out"]);

      const readState = async (): Promise<Record<string, any> | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, stateRel);
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      };

      const isAwaited = (state: Record<string, any> | undefined): boolean =>
        Boolean(
          state &&
            terminalStates.has(state.state) &&
            (!expectedPlanHash || state.plan_hash === expectedPlanHash) &&
            (sinceIteration === undefined || (typeof state.iteration === "number" && state.iteration > sinceIteration))
        );

      const deadline = Date.now() + maxWaitSeconds * 1000;
      let state = await readState();
      while (Date.now() < deadline && !isAwaited(state)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        state = await readState();
      }

      const awaitedTerminal = isAwaited(state);
      const awaitedCompleted = awaitedTerminal && state?.state === "completed";
      const planHashMismatch = Boolean(expectedPlanHash && state && state.plan_hash !== expectedPlanHash);
      const reportedState = awaitedTerminal
        ? String(state?.state)
        : state
          ? state.state === "running" || planHashMismatch || sinceIteration !== undefined
            ? "running"
            : String(state.state)
          : "unknown";

      const excerpt = async (rel: string, maxChars: number, tailLines?: number): Promise<string | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, rel);
          const body = tailLines
            ? raw.split(/\r?\n/).filter(Boolean).slice(-tailLines).join("\n")
            : raw;
          const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n...[excerpt truncated]` : body;
          return redactSensitiveText(trimmed);
        } catch {
          return undefined;
        }
      };
      const bridgeArtifact = (value: unknown, fallback: string): string => {
        const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
        const normalized = path.posix.normalize(raw.split(path.sep).join("/")).replace(/^\.\//, "");
        return normalized.startsWith(contextPrefix) ? normalized : fallback;
      };

      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        state: reportedState,
        awaited_completed: awaitedCompleted,
        awaited_terminal: awaitedTerminal,
        succeeded: awaitedCompleted,
        state_file: stateRel,
        ...(state ? { run_state: state.state } : {}),
        ...(typeof state?.iteration === "number" ? { iteration: state.iteration } : {}),
        ...(state?.plan_hash ? { plan_hash: state.plan_hash } : {}),
        ...(expectedPlanHash ? { expected_plan_hash: expectedPlanHash, plan_hash_mismatch: planHashMismatch } : {}),
        ...(state && "exit_code" in state ? { exit_code: state.exit_code } : {}),
        ...(state && "timed_out" in state ? { timed_out: state.timed_out } : {}),
        ...(state?.started_at ? { started_at: state.started_at } : {}),
        ...(state?.finished_at ? { finished_at: state.finished_at } : {}),
        ...(state?.executor ? { executor: state.executor } : {}),
        ...(state?.model ? { model: state.model } : {}),
        ...(awaitedTerminal ? {} : { next_poll_after_seconds: Math.max(1, Math.ceil(pollMs / 1000)) })
      };

      if (awaitedTerminal) {
        const statusFile = bridgeArtifact(state?.status_file, `${config.contextDir}/agent-status.md`);
        const diffFile = bridgeArtifact(state?.diff_file, `${config.contextDir}/implementation-diff.patch`);
        const logFile = bridgeArtifact(state?.log_file, `${config.contextDir}/execution-log.jsonl`);
        const testsFile = bridgeArtifact(state?.tests_file, `${config.contextDir}/loop-tests.txt`);
        structured.status_file = statusFile;
        structured.diff_file = diffFile;
        structured.log_file = logFile;
        const status = await excerpt(statusFile, 6_000);
        if (status) structured.status_excerpt = status;
        if (includeDiff) {
          const diff = await excerpt(diffFile, 12_000);
          if (diff) structured.diff_excerpt = diff;
        }
        if (includeLog) {
          const log = await excerpt(logFile, 6_000, 20);
          if (log) structured.log_excerpt = log;
        }
        if (includeTests) {
          const tests = await excerpt(testsFile, 4_000);
          if (tests) {
            structured.tests_file = testsFile;
            structured.tests_excerpt = tests;
          }
        }
      }

      const summary = !state
        ? `No handoff run state found at ${stateRel}. Start a run with handoff_to_agent + local execute-handoff/watch-handoff, then call wait_for_handoff again.`
        : awaitedTerminal
          ? `Handoff run ${state.state} (iteration ${state.iteration ?? 1}, exit ${state.exit_code ?? "null"}).`
          : planHashMismatch
            ? `Executor has not completed the expected plan yet (last known run plan_hash=${state.plan_hash ?? "unknown"}). Still waiting.`
            : `Handoff run is ${state.state}. Re-poll after ~${Math.max(1, Math.ceil(pollMs / 1000))}s.`;

      const lines = [
        "# Wait For Handoff",
        "",
        summary,
        "",
        `State file: ${stateRel}`,
        ...(state?.plan_hash ? [`Plan hash: ${state.plan_hash}`] : []),
        ...(awaitedTerminal && structured.status_excerpt ? ["", "## Status", "", `\`\`\`text\n${structured.status_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.diff_excerpt ? ["", "## Diff", "", `\`\`\`diff\n${structured.diff_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.tests_excerpt ? ["", "## Tests", "", `\`\`\`text\n${structured.tests_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.log_excerpt ? ["", "## Log tail", "", `\`\`\`text\n${structured.log_excerpt}\n\`\`\``] : [])
      ];
      return textResult(lines.join("\n"), structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const leased = await withDirectTaskOperation(config, workspace, "export_pro_context", () =>
        exportProContext(config, guard, workspace, {
          title: args.title,
          selectedPaths: args.selected_paths,
          extraGlobs: args.extra_globs,
          includeImportantFiles: args.include_important_files,
          includeChangedFiles: args.include_changed_files,
          includeDiff: args.include_diff,
          includeAiBridge: args.include_ai_bridge,
          maxDepth: args.max_depth,
          maxFiles: args.max_files,
          maxFileBytes: args.max_file_bytes,
          maxTotalBytes: args.max_total_bytes
        })
      );
      const result = leased.result;
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexpro pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read. It selects the newest page by default, returns that page chronologically, and reads the file in blocks instead of loading the full JSONL. Memory use still scales with the largest individual JSONL record scanned.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            direction: z.enum(["head", "tail"]).optional().describe("Page direction. tail selects the newest page and is the default; head reads from the start. Messages inside each page are returned chronologically."),
            cursor: z.number().int().min(0).optional().describe("Opaque byte cursor returned as next_cursor or resume_cursor by a previous page. Reuse it only with the same session and direction. Omit for the newest tail page or the first head page."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum returned transcript content bytes. Default: 80000."),
            exclude_tool_outputs: z.boolean().optional().describe("Exclude function_call_output messages. Default: false."),
            max_tool_output_bytes: z.number().int().min(0).max(400000).optional().describe("Maximum bytes retained per tool output before it is truncated. Default: 20000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            direction: args.direction,
            cursor: args.cursor,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes,
            excludeToolOutputs: args.exclude_tool_outputs,
            maxToolOutputBytes: args.max_tool_output_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            direction: result.direction,
            cursor: result.cursor,
            resume_cursor: result.resume_cursor,
            next_cursor: result.next_cursor ?? null,
            has_more: result.has_more,
            source_size_bytes: result.source_size_bytes,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const leased = await withDirectTaskOperation(config, workspace, "handoff_to_agent", () =>
        writeAgentHandoff(config, guard, workspace, {
          agent: args.agent ?? "custom",
          agentName: args.agent_name,
          model: args.model,
          title: cleanOneLine(args.title, "Agent implementation plan"),
          plan: String(args.plan ?? ""),
          append: parseBool(args.append, false),
          eventName: "handoff_to_agent"
        })
      );
      const result = leased.result;

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      const leased = await withDirectTaskOperation(config, workspace, "handoff_to_codex", () =>
        writeAgentHandoff(config, guard, workspace, {
          agent: "codex",
          title: cleanOneLine(args.title, "Codex implementation plan"),
          plan: String(args.plan ?? ""),
          append: parseBool(args.append, false),
          eventName: "handoff_to_codex"
        })
      );
      const result = leased.result;
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff,
        ...(leased.task ? codingTaskStructured(leased.task) : {})
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "create_coding_task",
    {
      title: "Create CodingTask",
      description: "Create or reopen one persistent isolated CodingTask worktree. The source workspace stays untouched; direct ChatGPT coding and Codex collaboration share this task workspace and transfer exclusive ownership explicitly.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Allowed source Git workspace. Omit to use the selected workspace."),
        task_key: z.string().min(1).max(160).describe("Stable idempotency key. Reusing it with the same contract returns the existing task."),
        title: z.string().min(1).max(500).describe("Short user-facing task title."),
        goal: z.string().min(1).max(20_000).describe("Implementation goal and acceptance context shared by both executors."),
        executor: z.enum(["direct", "codex"]).optional().describe("Initial owner. Default: direct."),
        base_sha: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe("Optional exact committed base. Default: current source workspace HEAD.")
      },
      annotations: CODEX_TASK_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Creating isolated CodingTask...",
        "openai/toolInvocation/invoked": "CodingTask ready"
      }
    },
    async (args) => {
      assertCodingTaskExecutionEnabled(config);
      if ((args.executor ?? "direct") === "codex") await resolveCodexExecutable(config);
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      if (workspace.codingTaskId) throw new CodexProError("Create a CodingTask from its allowed source workspace, not from another task worktree.");
      const created = await createCodingTask(
        codingTaskStoreConfig(config),
        workspace,
        { assertSourceWorkspace: (sourceRoot) => {
          if (!config.allowedRoots.some((root) => {
            const relative = path.relative(root, sourceRoot);
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
          })) throw new CodexProError("CodingTask source workspace is outside allowed roots.");
        } },
        {
          taskKey: String(args.task_key ?? ""),
          title: String(args.title ?? ""),
          goal: String(args.goal ?? ""),
          executor: args.executor ?? "direct",
          baseSha: await resolveCodingTaskBaseSha(workspace, args.base_sha, {
            assertSourceWorkspace: (sourceRoot) => {
              if (!config.allowedRoots.some((root) => {
                const relative = path.relative(root, sourceRoot);
                return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
              })) throw new CodexProError("CodingTask source workspace is outside allowed roots.");
            }
          })
        }
      );
      return textResult(codingTaskText(created.reused ? "CodingTask Reopened" : "CodingTask Created", created.task), {
        ...codingTaskStructured(created.task),
        reused: created.reused
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "get_coding_task",
    {
      title: "Get CodingTask",
      description: "Read the authoritative persisted CodingTask state, ownership lease, active run, and resumable Codex thread identity.",
      inputSchema: {
        task_id: z.string().regex(/^task_[a-f0-9]{24}$/),
        operation_id: z.string().min(1).max(160).optional().describe("Optional Codex operation id. By default the active or most recent recorded Codex run is included."),
        include_run: z.boolean().optional().describe("Include persisted Codex progress, plans, diffs, and final response when available. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Reading CodingTask...", "openai/toolInvocation/invoked": "CodingTask status ready" }
    },
    async (args) => {
      const task = await allowedCodingTask(config, args.task_id);
      const liveReview = task.activeOperation
        ? undefined
        : await reviewCodingTask(codingTaskStoreConfig(config), task.taskId, {
            maxGitOutputBytes: config.maxOutputBytes,
            isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
          });
      const gitObservation = liveReview
        ? {
            capturedAt: liveReview.capturedAt,
            headSha: liveReview.headSha,
            status: liveReview.status,
            diffStat: liveReview.diffStat,
            diffSha256: liveReview.diffSha256,
            dirty: liveReview.dirty,
            stale: false
          }
        : task.lastGitObservation
          ? { ...task.lastGitObservation, stale: true }
          : null;
      const reviewSummary = liveReview
        ? {
            changed_files_count: liveReview.changedFileCount,
            additions: liveReview.additions,
            deletions: liveReview.deletions,
            content_complete: liveReview.contentComplete,
            omitted_path_count: liveReview.omittedPathCount
          }
        : null;
      let run: CodingTaskRunView | undefined;
      let runReadError: string | undefined;
      if (args.include_run !== false) {
        // Log names are bounded display metadata and may be hashed. They are never an
        // authority for restoring a run identity; use the active operation or scan the
        // immutable run definitions through getLatestCodingTaskRun instead. This
        // read-only tool never reconciles, relaunches, or persists recovery state.
        const operationId = args.operation_id
          ?? (task.activeOperation?.executor === "codex" ? task.activeOperation.operationId : undefined);
        if (operationId) {
          try {
            run = await getCodingTaskRun(codingTaskStoreConfig(config), task.taskId, operationId);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") runReadError = errorText(error);
          }
        } else {
          try {
            run = await getLatestCodingTaskRun(codingTaskStoreConfig(config), task.taskId);
          } catch (error) {
            runReadError = errorText(error);
          }
        }
      }
      const gitText = gitObservation
        ? `Git snapshot: ${gitObservation.dirty ? "dirty" : "clean"} at ${gitObservation.headSha.slice(0, 12)} · ${gitObservation.capturedAt}${gitObservation.stale ? " (last completed snapshot; Codex is active)" : ""}`
        : "Git snapshot: unavailable while an operation is active.";
      const text = `${run ? codingTaskRunText("CodingTask", task, run) : codingTaskText("CodingTask", task)}\n\n${gitText}${runReadError ? `\nRun read error: ${runReadError}` : ""}`;
      return textResult(text, {
        ...codingTaskStructured(task),
        run: run ?? null,
        runner_alive: run?.runnerAlive ?? null,
        stranded: run ? ["queued", "running"].includes(run.status) && !run.runnerAlive : false,
        recovery_needed: run ? ["queued", "running"].includes(run.status) && !run.runnerAlive : false,
        recovery_action: run && ["queued", "running"].includes(run.status) && !run.runnerAlive
          ? (config.writeMode === "workspace" && config.bashMode === "full"
              ? "Retry run_coding_task with the same operation_id, or use followup_coding_task. Use cancel_coding_task to stop without relaunching."
              : "Enable writeMode=workspace and bashMode=full only if you intend to resume execution. A stranded running operation may be canceled without enabling execution; a queued orphan remains passive until an explicit recovery or supported terminal cancellation.")
          : null,
        run_read_error: runReadError ?? null,
        git_observation: gitObservation,
        review_summary: reviewSummary
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_coding_tasks",
    {
      title: "List CodingTasks",
      description: "List persistent CodingTasks whose source repositories are still within this server's allowed roots.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Listing CodingTasks...", "openai/toolInvocation/invoked": "CodingTask list ready" }
    },
    async (args) => {
      const all = await listCodingTasks(codingTaskStoreConfig(config), {
        limit: args.limit ?? 100,
        allowedSourceRoots: config.allowedRoots
      });
      const tasks = all.filter((task) => {
        try { assertCodingTaskSourceAllowed(config, task); return true; } catch { return false; }
      });
      const text = tasks.length
        ? ["# CodingTasks", "", ...tasks.map((task) => `- \`${task.taskId}\` · ${task.executor} · ${task.lifecycle} · r${task.revision} · ${task.title}`)].join("\n")
        : "# CodingTasks\n\nNo CodingTasks are visible for the current allowed roots.";
      return textResult(text, { tasks, task_count: tasks.length });
    }
  );

  registerCodexTool(
    config,
    server,
    "transition_coding_task",
    {
      title: "Transition CodingTask",
      description: "Atomically transfer exclusive CodingTask ownership between direct ChatGPT coding and Codex collaboration. Refuses active operations and records a Git snapshot before confirming the handoff.",
      inputSchema: {
        task_id: z.string().regex(/^task_[a-f0-9]{24}$/),
        to: z.enum(["direct", "codex"]),
        expected_revision: z.number().int().min(1).describe("Revision from the latest task read; stale transitions fail closed."),
        transition_key: z.string().min(1).max(160).describe("Stable idempotency key for this handoff.")
      },
      annotations: CODEX_TASK_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Transferring CodingTask ownership...", "openai/toolInvocation/invoked": "CodingTask ownership transferred" }
    },
    async (args) => {
      const current = await allowedCodingTask(config, args.task_id);
      assertIndependentCodingTaskControl(current, "CodingTask ownership transfer");
      const priorTransition = current.lastTransition;
      if (priorTransition && priorTransition.key === args.transition_key && priorTransition.to === args.to) {
        return textResult(codingTaskText("CodingTask Transition", current), {
          ...codingTaskStructured(current),
          transition: priorTransition,
          reused: true
        });
      }
      if (args.to === "codex") {
        assertCodingTaskExecutionEnabled(config);
        await resolveCodexExecutable(config);
      }
      const task = await transitionCodingTaskExecutor(codingTaskStoreConfig(config), current.taskId, {
        expectedRevision: args.expected_revision,
        expectedExecutorEpoch: current.executorLease.epoch,
        expectedLeaseId: current.executorLease.leaseId,
        transitionKey: args.transition_key,
        to: args.to,
        maxGitOutputBytes: config.maxOutputBytes
      });
      assertCodingTaskSourceAllowed(config, task);
      return textResult(codingTaskText("CodingTask Transition", task), {
        ...codingTaskStructured(task),
        transition: task.lastTransition ?? null
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "run_coding_task",
    {
      title: "Run CodingTask with Codex",
      description: "Start one durable Codex App Server turn in the task worktree and return promptly. The persistent Codex thread, progress, plans, diffs, and final response remain attached to the same CodingTask across reconnects.",
      inputSchema: {
        task_id: z.string().regex(/^task_[a-f0-9]{24}$/),
        operation_id: z.string().min(1).max(160).describe("Stable idempotency key for this Codex turn."),
        prompt: z.string().min(1).max(262_144).describe("Implementation request for Codex. Include acceptance criteria and verification expectations."),
        expected_revision: z.number().int().min(1).describe("Revision from the latest task read; stale starts fail closed."),
        timeout_ms: z.number().int().min(1_000).max(24 * 60 * 60_000).optional().describe(`Maximum turn duration. Default: ${config.codingTaskDefaultTimeoutMs}.`)
      },
      annotations: CODEX_TASK_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Starting Codex collaboration...", "openai/toolInvocation/invoked": "Codex collaboration started" }
    },
    async (args) => {
      assertCodingTaskExecutionEnabled(config);
      const current = await allowedCodingTask(config, args.task_id);
      assertIndependentCodingTaskControl(current, "Direct CodingTask run");
      if (current.executor !== "codex") throw new CodexProError("Transition this CodingTask to executor=codex before starting a Codex turn.");
      const run = await launchCodingTaskRun(
        { dataRoot: config.codingTaskDir, codexBinary: await resolveCodexExecutable(config), env: { CODEX_HOME: config.codexDir }, maxLogBytes: config.codingTaskMaxLogBytes },
        current.taskId,
        {
          operationId: args.operation_id,
          prompt: args.prompt,
          expectedRevision: current.revision,
          executorEpoch: current.executorLease.epoch,
          leaseId: current.executorLease.leaseId,
          threadId: current.codexThreadId,
          model: config.codexModel,
          effort: config.codexReasoningEffort,
          timeoutMs: args.timeout_ms ?? config.codingTaskDefaultTimeoutMs
        }
      );
      const task = await allowedCodingTask(config, current.taskId);
      return textResult(codingTaskRunText("Codex Collaboration", task, run), {
        ...codingTaskStructured(task),
        run
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "followup_coding_task",
    {
      title: "Follow Up CodingTask",
      description: "Continue the same Codex collaboration context. An active turn is steered in place; an idle task starts a new turn by resuming its persisted Codex thread.",
      inputSchema: {
        task_id: z.string().regex(/^task_[a-f0-9]{24}$/),
        request_key: z.string().min(1).max(160).describe("Stable idempotency key for this follow-up."),
        prompt: z.string().min(1).max(262_144).describe("Follow-up guidance, correction, or next requested change."),
        expected_revision: z.number().int().min(1).optional().describe("Optional revision guard. Recommended for idle follow-ups; active turns may heartbeat to newer revisions."),
        timeout_ms: z.number().int().min(1_000).max(24 * 60 * 60_000).optional()
      },
      annotations: CODEX_TASK_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Sending Codex follow-up...", "openai/toolInvocation/invoked": "Codex follow-up accepted" }
    },
    async (args) => {
      assertCodingTaskExecutionEnabled(config);
      const current = await allowedCodingTask(config, args.task_id);
      assertIndependentCodingTaskControl(current, "Direct CodingTask follow-up");
      if (current.executor !== "codex") throw new CodexProError("Transition this CodingTask to executor=codex before sending a Codex follow-up.");
      if (current.activeOperation?.executor === "codex") {
        await reconcileCodingTaskRun(
          { dataRoot: config.codingTaskDir, codexBinary: await resolveCodexExecutable(config), env: { CODEX_HOME: config.codexDir }, maxLogBytes: config.codingTaskMaxLogBytes },
          current.taskId,
          current.activeOperation.operationId,
          { relaunchQueued: true }
        );
      }
      const reconciled = await allowedCodingTask(config, current.taskId);
      const followup = await submitCodingTaskFollowup(
        { dataRoot: config.codingTaskDir, codexBinary: await resolveCodexExecutable(config), env: { CODEX_HOME: config.codexDir }, maxLogBytes: config.codingTaskMaxLogBytes },
        reconciled.taskId,
        {
          requestKey: args.request_key,
          prompt: args.prompt,
          expectedRevision: args.expected_revision,
          model: config.codexModel,
          effort: config.codexReasoningEffort,
          timeoutMs: args.timeout_ms ?? config.codingTaskDefaultTimeoutMs
        }
      );
      const task = await allowedCodingTask(config, current.taskId);
      if (followup.mode === "steer") {
        return textResult(`${codingTaskText("Codex Follow-up", task)}\n\nFollow-up: ${followup.steer.status}\nRequest: \`${followup.steer.requestKey}\``, {
          ...codingTaskStructured(task),
          followup
        });
      }
      return textResult(codingTaskRunText("Codex Follow-up", task, followup.run), {
        ...codingTaskStructured(task),
        followup,
        run: followup.run
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "cancel_coding_task",
    {
      title: "Cancel CodingTask Run",
      description: "Request cancellation of the currently active Codex turn. The detached runner observes the persisted request, interrupts App Server, and records the terminal state.",
      inputSchema: {
        task_id: z.string().regex(/^task_[a-f0-9]{24}$/),
        operation_id: z.string().min(1).max(160).optional().describe("Codex operation to cancel. Omit for the current operation; include it when retrying after a lost response."),
        reason: z.string().max(1_000).optional()
      },
      annotations: BACKGROUND_JOB_CANCEL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Canceling Codex collaboration...", "openai/toolInvocation/invoked": "Cancellation requested" }
    },
    async (args) => {
      const current = await allowedCodingTask(config, args.task_id);
      if (!current.activeOperation && args.operation_id) {
        const queued = await getCodingTaskRun(codingTaskStoreConfig(config), current.taskId, args.operation_id).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (queued?.status === "queued" && !queued.runnerAlive) {
          const canceledRun = await cancelQueuedCodingTaskRun(
            codingTaskStoreConfig(config),
            current.taskId,
            args.operation_id,
            args.reason
          );
          return textResult(`${codingTaskText("CodingTask Cancellation", current)}\n\nQueued run \`${args.operation_id}\` was canceled before launch.`, {
            ...codingTaskStructured(current),
            run: canceledRun,
            cancellation: { operation_id: args.operation_id, status: "canceled", before_launch: true }
          });
        }
      }
      const active = current.activeOperation?.executor === "codex" ? current.activeOperation : undefined;
      const completed = current.lastCompletedOperation?.executor === "codex" ? current.lastCompletedOperation : undefined;
      const operationId = args.operation_id ?? active?.operationId ?? completed?.operationId;
      if (active && operationId !== active.operationId) {
        throw new CodexProError(`CodingTask has a different active Codex operation: ${active.operationId}`);
      }
      const completedEpoch = completed?.executorEpoch;
      const executorEpoch = operationId === active?.operationId
        ? current.executorLease.epoch
        : operationId === completed?.operationId && completedEpoch !== undefined
          ? completedEpoch
          : undefined;
      if (!operationId || !executorEpoch) {
        throw new CodexProError("CodingTask has no active Codex turn to cancel.");
      }
      // Cancellation is the durable authority and must win before any dead-run
      // reconciliation. Live runners observe this request; dead runners are then
      // fenced to a canceled terminal state without ever being relaunched.
      const canceled = await requestCodingTaskCancellation(codingTaskStoreConfig(config), current.taskId, {
        executor: "codex",
        executorEpoch,
        leaseId: current.executorLease.leaseId,
        operationId,
        reason: args.reason
      });
      let run: CodingTaskRunView | undefined;
      if (active) {
        run = await reconcileCodingTaskRun(
          codingTaskStoreConfig(config),
          current.taskId,
          operationId,
          { relaunchQueued: false, staleMs: 0 }
        );
      }
      const authoritative = await allowedCodingTask(config, current.taskId);
      return textResult(`${codingTaskText("CodingTask Cancellation", authoritative)}\n\nCancellation requested at ${canceled.request.requestedAt}.`, {
        ...codingTaskStructured(authoritative),
        run: run ?? null,
        cancellation: canceled.request
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "review_coding_task",
    {
      title: "Review CodingTask",
      description: "Review the complete isolated task worktree against its committed base, including authoritative Git status, diff statistics, binary-safe diff hash, and bounded patch.",
      inputSchema: { task_id: z.string().regex(/^task_[a-f0-9]{24}$/) },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Reviewing CodingTask changes...", "openai/toolInvocation/invoked": "CodingTask review ready" }
    },
    async (args) => {
      const task = await allowedCodingTask(config, args.task_id);
      const review = await reviewCodingTask(codingTaskStoreConfig(config), task.taskId, {
        maxGitOutputBytes: config.maxOutputBytes,
        isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
      });
      const text = [
        codingTaskText("CodingTask Review", task),
        "",
        `Dirty: ${review.dirty ? "yes" : "no"}`,
        `Diff SHA-256: ${review.diffSha256}`,
        `Visible diff SHA-256: ${review.visibleDiffSha256}`,
        `Content complete: ${review.contentComplete ? "yes" : "no"}`,
        review.omittedPathCount ? `Omitted blocked paths: ${review.omittedPathCount} (${review.omittedPaths.join(", ")})` : "",
        "",
        "## Status",
        "",
        "```text",
        review.status || "clean",
        "```",
        review.diff ? diffBlock(review.diff) : "\nNo changes against the task base."
      ].join("\n");
      return textResult(text, {
        ...codingTaskStructured(task),
        review,
        visible_diff_sha256: review.visibleDiffSha256,
        content_complete: review.contentComplete,
        omitted_paths: review.omittedPaths,
        omitted_path_count: review.omittedPathCount
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "propose_goal",
    {
      title: "Propose Goal",
      description: "Persist an inert, fingerprinted Pro orchestration contract. supervised keeps one semantic turn, zero retries, and integration under explicit Pro actions. persistent may include up to three ordered mandatory continuation intents (four semantic turns total) plus 0-2 total fresh retries per work item. A fresh retry repeats the exact approved prompt under a new operation ID after the fixed fingerprinted infra-pre-turn-v1 backoff; same-operation recovery is not a retry, and retries do not consume turns. The scheduler cannot invent or mutate prompts. Intermediate successful turns stay private and non-integrable; deterministic private integration waits for the final authorized turn. Proposal starts nothing.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Allowed source Git workspace. Omit to use the selected workspace."),
        goal_key: z.string().min(1).max(160).describe("Stable idempotency key for this exact proposal."),
        title: z.string().min(1).max(500),
        goal: z.string().min(1).max(20_000),
        exclusions: z.array(z.string().min(1).max(2_000)).max(100).optional(),
        completion_criteria: z.array(z.string().min(1).max(2_000)).min(1).max(100),
        verification: z.array(z.string().min(1).max(2_000)).max(100).optional(),
        execution_policy: z.enum(["supervised", "persistent"]).optional().describe("supervised uses explicit Pro launch/integration; persistent automatically schedules dependencies and mechanically integrates verified worker patches only into the private integration worktree."),
        workspace_policy: z.enum(["isolated", "live"]).optional().describe("Use isolated to keep reviewed checkpoints private until final apply, or live to allow separately confirmed projection of reviewed checkpoints into source."),
        worker_model: z.string().min(1).max(160).optional(),
        worker_effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        limits: z.object({
          max_concurrency: z.number().int().min(1).max(8).optional(),
          timeout_ms: z.number().int().min(1_000).max(86_400_000).optional(),
          max_turns_per_worker: z.number().int().min(1).max(4).optional().describe("Total authorized turns including the initial turn. supervised requires 1; persistent requires 1-4 and exactly one fewer continuation_intents on every work item."),
          max_retries_per_worker: z.number().int().min(0).max(2).optional().describe("Persistent-only total fresh retry budget per work item across all semantic turns. Fixed infra-pre-turn-v1 policy; supervised requires 0."),
          max_log_bytes: z.number().int().min(65_536).max(104_857_600).optional()
        }).optional(),
        permissions: z.object({
          file_globs: z.array(z.string().min(1).max(1_000)).min(1).max(200),
          commands: z.array(z.string().min(1).max(1_000)).max(100).optional(),
          network: z.literal(false).optional(),
          source_effects: z.object({
            apply: z.boolean().optional().describe("Permit source effects. Must be true for workspace_policy=live and for final apply_goal."),
            commit: z.literal(false).optional(),
            push: z.literal(false).optional(),
            draft_pr: z.literal(false).optional()
          }).optional()
        }),
        base_sha: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(),
        work: z.array(z.object({
          work_id: z.string().regex(/^work_[a-z0-9][a-z0-9_-]{0,63}$/),
          title: z.string().min(1).max(500),
          goal: z.string().min(1).max(20_000),
          acceptance_criteria: z.array(z.string().min(1).max(2_000)).min(1).max(50),
          verification: z.array(z.string().min(1).max(2_000)).max(50).optional(),
          depends_on: z.array(z.string().regex(/^work_[a-z0-9][a-z0-9_-]{0,63}$/)).max(50).optional(),
          parallel_group: z.string().min(1).max(100).optional(),
          file_globs: z.array(z.string().min(1).max(1_000)).max(100).optional(),
          continuation_intents: z.array(z.object({
            intent_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
            prompt: z.string().min(1).max(65_536).describe("Exact Pro-approved continuation prompt. The scheduler executes it verbatim and never invents a prompt.")
          })).max(3).optional().describe("Persistent-only ordered mandatory turns after the initial turn. Count must equal max_turns_per_worker - 1.")
        })).min(1).max(50)
      },
      annotations: GOAL_PLAN_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Persisting Goal proposal...", "openai/toolInvocation/invoked": "Goal proposal ready for review" }
    },
    async (args) => {
      const requestedWorkspacePolicy = args.workspace_policy ?? "isolated";
      if (requestedWorkspacePolicy === "live") assertGoalLiveProjectionSupported();
      const workspace = await workspaces.getWorkspaceAsync(args.workspace_id);
      if (workspace.codingTaskId) throw new CodexProError("Propose a Goal from its allowed source repository, not from a CodingTask worktree.");
      const executionPolicy = args.execution_policy ?? "supervised";
      const workspacePolicy = requestedWorkspacePolicy;
      const sourceEffects = args.permissions.source_effects ?? {};
      const maxTurnsPerWorker = args.limits?.max_turns_per_worker ?? 1;
      if (executionPolicy === "persistent") {
        if (workspacePolicy !== "isolated") throw new CodexProError("Persistent Goals require workspace_policy=isolated; they never project into the source workspace.");
        if ((args.permissions.commands ?? []).length) throw new CodexProError("Persistent Goals require permissions.commands to be empty.");
        if (sourceEffects.apply || sourceEffects.commit || sourceEffects.push || sourceEffects.draft_pr) {
          throw new CodexProError("Persistent Goals require every source effect to be false.");
        }
        const mismatchedWork = args.work.find((item: any) => (item.continuation_intents?.length ?? 0) !== maxTurnsPerWorker - 1);
        if (mismatchedWork) {
          throw new CodexProError(`Persistent Goal work ${mismatchedWork.work_id} must provide exactly ${maxTurnsPerWorker - 1} ordered continuation_intents for ${maxTurnsPerWorker} total authorized turn(s).`);
        }
      } else if (maxTurnsPerWorker !== 1 || (args.limits?.max_retries_per_worker ?? 0) !== 0 || args.work.some((item: any) => (item.continuation_intents?.length ?? 0) > 0)) {
        throw new CodexProError("Supervised Goals support exactly one semantic turn, zero retries, and no continuation_intents.");
      }
      const proposed = await proposeGoal(
        goalStoreConfig(config),
        workspace,
        { assertSourceWorkspace: (sourceRoot) => {
          if (!config.allowedRoots.some((root) => {
            const relative = path.relative(root, sourceRoot);
            return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
          })) throw new CodexProError("Goal source workspace is outside allowed roots.");
        } },
        {
          goalKey: args.goal_key,
          title: args.title,
          goal: args.goal,
          exclusions: args.exclusions,
          completionCriteria: args.completion_criteria,
          verification: args.verification,
          executionPolicy,
          workspacePolicy,
          workerModel: args.worker_model ?? config.codexModel,
          workerEffort: args.worker_effort ?? config.codexReasoningEffort,
          limits: {
            maxConcurrency: args.limits?.max_concurrency ?? Math.min(3, args.work.length),
            timeoutMs: args.limits?.timeout_ms ?? config.codingTaskDefaultTimeoutMs,
            maxTurnsPerWorker,
            maxRetriesPerWorker: args.limits?.max_retries_per_worker ?? 0,
            maxLogBytes: args.limits?.max_log_bytes ?? config.codingTaskMaxLogBytes
          },
          permissions: {
            fileGlobs: args.permissions.file_globs,
            commands: args.permissions.commands ?? [],
            network: false,
            sourceEffects: {
              apply: sourceEffects.apply ?? false,
              commit: false,
              push: false,
              draftPr: false
            }
          },
          contentPolicy: executionPolicy === "persistent" ? createGoalContentPolicySnapshot(config.blockedGlobs) : undefined,
          baseSha: await resolveCodingTaskBaseSha(workspace, args.base_sha, {
            assertSourceWorkspace: (sourceRoot) => {
              if (!config.allowedRoots.some((root) => {
                const relative = path.relative(root, sourceRoot);
                return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
              })) throw new CodexProError("Goal source workspace is outside allowed roots.");
            }
          }),
          work: args.work.map((item: any) => ({
            workId: item.work_id,
            title: item.title,
            goal: item.goal,
            acceptanceCriteria: item.acceptance_criteria,
            verification: item.verification,
            dependsOn: item.depends_on,
            parallelGroup: item.parallel_group,
            fileGlobs: item.file_globs,
            continuationIntents: item.continuation_intents?.map((intent: any) => ({ intentId: intent.intent_id, prompt: intent.prompt }))
          }))
        }
      );
      return textResult(goalText(proposed.reused ? "Goal Proposal Reopened" : "Goal Proposal", proposed.goal), {
        ...goalStructured(proposed.goal),
        reused: proposed.reused,
        execution_started: false,
        approval_required: true,
        available_actions: [{ tool: "approve_goal", label: "Approve exact contract", execution_required: false }]
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "get_goal",
    {
      title: "Get Goal",
      description: "Passively read the authoritative persisted Goal contract, approval, work graph, bounded semantic-turn/attempt history, and Blackboard summaries. Retry classifications and not-before times are persisted engine authority. This status tool never starts, resumes, reconciles, or relaunches workers.",
      inputSchema: { goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/) },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Reading Goal...", "openai/toolInvocation/invoked": "Goal status ready" }
    },
    async (args) => {
      const goal = await allowedGoal(config, args.goal_id);
      const schedulerView = await passiveGoalSchedulerView(config, goal);
      return textResult(goalText("Goal", schedulerView?.goal ?? goal), {
        ...goalStructured(schedulerView?.goal ?? goal),
        ...goalSchedulerStructured(schedulerView)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_goals",
    {
      title: "List Goals",
      description: "Passively list compact durable Goal summaries inside allowed roots, including only aggregate semantic-turn, attempt, retry, and backoff counts. Never returns exact prompts, raw errors, full attempt evidence, or full Goal state, and never starts work.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Listing Goals...", "openai/toolInvocation/invoked": "Goal list ready" }
    },
    async (args) => {
      const goals = (await listGoals(goalStoreConfig(config), {
        limit: args.limit ?? 20,
        allowedSourceRoots: config.allowedRoots
      })).filter((goal) => {
        try {
          assertGoalSourceAllowed(config, goal);
          return true;
        } catch {
          return false;
        }
      });
      const schedulerViews = await Promise.all(goals.map((goal) => passiveGoalSchedulerView(config, goal)));
      const listedGoals = goals.map((goal, index) => goalListSummary(goal, goalSchedulerStructured(schedulerViews[index])));
      return textResult(`# Goals\n\n${goals.length ? goals.map((goal) => `- ${goal.goalId}: ${goal.title} [${goal.lifecycle}]`).join("\n") : "No Goals found."}`, {
        goals: listedGoals,
        goal_count: goals.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "approve_goal",
    {
      title: "Approve Goal",
      description: "Bind explicit user approval to the exact persisted Goal contract fingerprint. For a Live contract, the card must clearly show that separately confirmed reviewed checkpoints may change the source working tree. Approval itself does not start workers or project changes.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        contract_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        approval_key: z.string().min(1).max(160),
        confirm: z.literal(true).describe("Must be true only after explicit user approval of this exact contract.")
      },
      annotations: GOAL_CONSENT_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Recording Goal approval...", "openai/toolInvocation/invoked": "Goal contract approved" }
    },
    async (args) => {
      await allowedGoal(config, args.goal_id);
      const goal = await approveGoal(goalStoreConfig(config), args.goal_id, {
        expectedRevision: args.expected_revision,
        contractFingerprint: args.contract_fingerprint,
        approvalKey: args.approval_key
      });
      assertGoalSourceAllowed(config, goal);
      return textResult(`${goalText("Goal Approved", goal)}\n\nApproval is persisted. No worker has started; use the explicit Goal execution action when ready.`, {
        ...goalStructured(goal),
        execution_started: false,
        available_actions: [{ tool: "start_goal", label: goal.executionPolicy === "persistent" ? "Start persistent scheduling" : "Start supervised work", execution_required: true }]
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "publish_goal_blackboard",
    {
      title: "Publish Goal Blackboard Record",
      description: "Publish one bounded structured discovery, contract, ownership note, question, answer, blocker, verification result, or Pro decision. Worker-authored records cannot change scope or publish decisions.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        record_key: z.string().min(1).max(160),
        kind: z.enum(["discovery", "contract", "file_ownership", "question", "answer", "blocker", "verification", "decision"]),
        author: z.union([z.literal("pro"), z.string().regex(/^worker:work_[a-z0-9][a-z0-9_-]{0,63}$/)]),
        work_id: z.string().regex(/^work_[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
        summary: z.string().min(1).max(4_000),
        evidence: z.array(z.string().min(1).max(2_000)).max(50).optional(),
        paths: z.array(z.string().min(1).max(1_000)).max(100).optional()
      },
      annotations: GOAL_PLAN_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Publishing Goal record...", "openai/toolInvocation/invoked": "Goal Blackboard updated" }
    },
    async (args) => {
      await allowedGoal(config, args.goal_id);
      const published = await publishGoalBlackboard(goalStoreConfig(config), args.goal_id, {
        expectedRevision: args.expected_revision,
        recordKey: args.record_key,
        kind: args.kind,
        author: args.author,
        workId: args.work_id,
        summary: args.summary,
        evidence: args.evidence,
        paths: args.paths
      });
      assertGoalSourceAllowed(config, published.goal);
      return textResult(`${goalText("Goal Blackboard Updated", published.goal)}\n\nRecord: ${published.record.kind} · ${published.record.summary}`, {
        ...goalStructured(published.goal),
        record: {
          recordId: published.record.recordId,
          recordKey: published.record.recordKey,
          fingerprint: published.record.fingerprint,
          kind: published.record.kind,
          author: published.record.author,
          workId: published.record.workId ?? null,
          summary: safeGoalSummary(published.record.summary, 500),
          evidenceCount: published.record.evidence.length,
          pathCount: published.record.paths.length,
          createdAt: published.record.createdAt
        },
        reused: published.reused
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "start_goal",
    {
      title: "Start Goal",
      description: "Start an approved Goal or recover it with the same start_key. supervised launches dependency-ready one-turn workers for explicit Pro review/integration. persistent starts or recovers a detached shell-free scheduler; its approved authority includes only the fixed fingerprinted retry policy, and same-operation recovery is not a fresh retry. The scheduler automatically launches dependencies and integrates only final-turn verified patches into the private integration worktree. Never projects, applies, completes, commits, pushes, or opens a PR.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        start_key: z.string().min(1).max(160).describe("Stable idempotency key reused for every start/continue retry of this Goal.")
      },
      annotations: GOAL_EXECUTION_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Starting approved Goal execution...", "openai/toolInvocation/invoked": "Goal execution started" }
    },
    async (args) => {
      assertGoalExecutionEnabled(config);
      const current = await allowedGoal(config, args.goal_id);
      const codexBinary = await resolveCodexExecutable(config);
      if (current.executionPolicy === "persistent") {
        const started = await startPersistentGoal(
          { dataRoot: config.codingTaskDir, codexBinary, codexDir: config.codexDir, maxOutputBytes: config.maxOutputBytes },
          args.goal_id,
          {
            expectedRevision: args.expected_revision,
            startKey: args.start_key,
            runtimeContentPolicy: createGoalContentPolicySnapshot(config.blockedGlobs)
          }
        );
        assertGoalSourceAllowed(config, started.goal);
        const schedulerView = await getPersistentGoalScheduler(goalStoreConfig(config), started.goal.goalId);
        return textResult(`${goalText(started.reused ? "Persistent Goal Scheduler Recovered" : "Persistent Goal Scheduler Started", schedulerView.goal)}\n\nThe detached scheduler may automatically launch dependency-ready workers and mechanically integrate verified terminal patches into the private Goal integration worktree. Pro review, source projection/application, and completion remain separate.`, {
          ...goalStructured(schedulerView.goal),
          ...goalSchedulerStructured(schedulerView),
          scheduler_definition_fingerprint: started.definition.fingerprint,
          reused: started.reused,
          launched_run_count: 0
        });
      }
      const started = await startGoal(
        {
          dataRoot: config.codingTaskDir,
          codexBinary,
          codexDir: config.codexDir,
          maxOutputBytes: config.maxOutputBytes
        },
        args.goal_id,
        { expectedRevision: args.expected_revision, startKey: args.start_key }
      );
      assertGoalSourceAllowed(config, started.goal);
      return textResult(`${goalText("Goal Started", started.goal)}\n\nLaunched or recovered ${started.runs.length} dependency-ready worker run(s).`, {
        ...goalStructured(started.goal),
        runs: started.runs,
        launched_run_count: started.runs.length
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "refresh_goal",
    {
      title: "Refresh Goal",
      description: "Reconcile persisted worker-run results into Goal work status without starting, relaunching, integrating, or applying anything. This is the explicit mutating counterpart to passive get_goal.",
      inputSchema: { goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/) },
      annotations: GOAL_PLAN_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Refreshing Goal worker state...", "openai/toolInvocation/invoked": "Goal worker state refreshed" }
    },
    async (args) => {
      const current = await allowedGoal(config, args.goal_id);
      const goal = current.executionPolicy === "persistent" && current.lifecycle === "canceling"
        ? await reconcilePersistentGoalCancellation(goalStoreConfig(config), args.goal_id)
        : await refreshGoal(goalStoreConfig(config), args.goal_id);
      assertGoalSourceAllowed(config, goal);
      const schedulerView = await passiveGoalSchedulerView(config, goal);
      return textResult(goalText("Goal Refreshed", schedulerView?.goal ?? goal), {
        ...goalStructured(schedulerView?.goal ?? goal),
        ...goalSchedulerStructured(schedulerView)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "integrate_goal_work",
    {
      title: "Integrate Goal Work",
      description: "After Pro reviews a terminal Goal worker, apply only its approved, policy-visible patch to the isolated Goal integration worktree and create an internal detached checkpoint. Never changes the source workspace or a remote.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        work_id: z.string().regex(/^work_[a-z0-9][a-z0-9_-]{0,63}$/),
        expected_revision: z.number().int().min(1),
        integration_key: z.string().min(1).max(160)
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Integrating reviewed Goal work...", "openai/toolInvocation/invoked": "Goal work integrated" }
    },
    async (args) => {
      assertCodingTaskExecutionEnabled(config);
      const current = await allowedGoal(config, args.goal_id);
      if (current.executionPolicy === "persistent") {
        throw new CodexProError("Persistent Goal work is mechanically integrated by its scheduler after exact terminal, provenance, path, and content checks. integrate_goal_work remains an explicit Pro action only for supervised Goals.");
      }
      const goal = await integrateGoalWork(
        { dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes },
        args.goal_id,
        {
          expectedRevision: args.expected_revision,
          workId: args.work_id,
          integrationKey: args.integration_key,
          isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
        }
      );
      assertGoalSourceAllowed(config, goal);
      return textResult(goalText("Goal Work Integrated", goal), {
        ...goalStructured(goal),
        integrated_work_id: args.work_id
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "review_goal",
    {
      title: "Review Goal",
      description: "Passively review the private Goal integration worktree against its approved committed base, run integrated git diff --check, and return the same bounded persisted semantic-turn/attempt authority as get_goal. Use this result for Pro's final evidence judgment; do not open the private worktree with open_workspace, read, or bash. Blocked path content remains omitted. This never starts or reconciles workers, applies, commits to source, pushes, or creates a PR.",
      inputSchema: { goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/) },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Reviewing integrated Goal...", "openai/toolInvocation/invoked": "Goal review ready" }
    },
    async (args) => {
      await allowedGoal(config, args.goal_id);
      const result = await reviewGoal(
        { dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes },
        args.goal_id,
        (relativePath) => !guard.isBlockedRelativePath(relativePath)
      );
      assertGoalSourceAllowed(config, result.goal);
      const schedulerView = await passiveGoalSchedulerView(config, result.goal);
      const review = result.review;
      const publicReview = publicGoalReview(review);
      const text = [
        goalText("Goal Review", result.goal),
        "",
        `Integrated changes against approved base: ${review.changedFileCount ? "yes" : "no"}`,
        `Uncommitted integration-worktree changes: ${review.dirty ? "yes" : "no"}`,
        `Changed files: ${review.changedFileCount}; visible additions: ${review.additions}; visible deletions: ${review.deletions}`,
        `Content complete: ${review.contentComplete ? "yes" : "no"}`,
        `Integrated verification: PASSED (${result.verification.command})`,
        `Review fingerprint: ${result.reviewFingerprint}`,
        `Live projection eligible: ${result.projectionEligible ? "yes" : "no"}`,
        result.projectionBlockers.length ? `Projection blockers: ${result.projectionBlockers.join(", ")}` : "",
        review.omittedPathCount ? `Omitted blocked paths: ${review.omittedPaths.join(", ")}` : "",
        review.diff ? diffBlock(review.diff) : "\nNo integrated changes."
      ].filter(Boolean).join("\n");
      return textResult(text, {
        ...goalStructured(result.goal),
        ...goalSchedulerStructured(schedulerView),
        review: publicReview,
        changed_files_count: review.changedFileCount,
        verification: result.verification,
        integration_head_sha: result.integrationHeadSha,
        review_fingerprint: result.reviewFingerprint,
        projection_eligible: result.projectionEligible,
        projection_blockers: result.projectionBlockers,
        verification_passed: true,
        integrated_changes_present: review.changedFileCount > 0,
        integration_worktree_clean: !review.dirty,
        content_complete: review.contentComplete,
        omitted_paths: review.omittedPaths
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "project_goal",
    {
      title: "Project Reviewed Goal Checkpoint",
      description: "Project one exact review_goal-approved integration checkpoint from a supervised Live Goal into its allowed source working tree. This is a separately confirmed, journaled source effect; it never stages, commits, pushes, launches Codex, or projects unreviewed work.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        projection_key: z.string().min(1).max(160).describe("Stable idempotency key for this exact reviewed checkpoint."),
        integration_head_sha: z.string().regex(/^[0-9a-f]{40}$/).describe("Exact integration checkpoint returned by review_goal."),
        review_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).describe("Deterministic review fingerprint returned by review_goal."),
        confirm: z.literal(true).describe("True only after the user explicitly approves projecting this exact reviewed checkpoint into source.")
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Projecting reviewed Goal checkpoint...", "openai/toolInvocation/invoked": "Goal checkpoint projected" }
    },
    async (args) => {
      assertGoalLiveProjectionSupported();
      assertGoalSourceWriteEnabled(config);
      const current = await allowedGoal(config, args.goal_id);
      if (!["running", "waiting_review", "paused"].includes(current.lifecycle)) {
        throw new CodexProError("Goal projection and projection recovery require a nonterminal running, paused, or review-waiting Goal. Canceled, failed, completed, or merely approved Goals cannot resume projection work.");
      }
      let result: Awaited<ReturnType<typeof projectGoal>>;
      try {
        result = await projectGoal(
          { dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes },
          args.goal_id,
          {
            expectedRevision: args.expected_revision,
            projectionKey: args.projection_key,
            integrationHeadSha: args.integration_head_sha,
            reviewFingerprint: args.review_fingerprint,
            isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
          }
        );
      } catch (error) {
        return goalMutationErrorResult(config, args.goal_id, error);
      }
      assertGoalSourceAllowed(config, result.goal);
      return textResult(`${goalText("Goal Checkpoint Projected", result.goal)}\n\nProjection: ${result.projection.projectionId} [${result.projection.status}]. No stage, commit, push, or Codex process was created.`, {
        ...goalStructured(result.goal),
        projection: publicGoalProjection(result.projection),
        projection_id: result.projection.projectionId,
        projection_status: result.projection.status,
        reused: result.reused,
        recovered: result.recovered
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "revert_goal_projection",
    {
      title: "Revert Goal Projection",
      description: "Revert the latest unapplied Live projection owned by this Goal while preserving unrelated source changes. This is a separately confirmed, journaled source effect; external same-path edits fail closed and completed/adopted projections cannot be reverted.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        projection_id: z.string().regex(/^proj_[a-f0-9]{24}$/),
        revert_key: z.string().min(1).max(160).describe("Stable idempotency key for this exact projection revert."),
        confirm: z.literal(true).describe("True only after the user explicitly approves reverting this exact Goal-owned projection.")
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Reverting Goal projection...", "openai/toolInvocation/invoked": "Goal projection reverted" }
    },
    async (args) => {
      assertGoalLiveProjectionSupported();
      assertGoalSourceWriteEnabled(config);
      await allowedGoal(config, args.goal_id);
      let result: Awaited<ReturnType<typeof revertGoalProjection>>;
      try {
        result = await revertGoalProjection(
          { dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes },
          args.goal_id,
          {
            expectedRevision: args.expected_revision,
            projectionId: args.projection_id,
            revertKey: args.revert_key,
            isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
          }
        );
      } catch (error) {
        return goalMutationErrorResult(config, args.goal_id, error);
      }
      assertGoalSourceAllowed(config, result.goal);
      return textResult(`${goalText("Goal Projection Reverted", result.goal)}\n\nProjection: ${result.projection.projectionId} [${result.projection.status}]. Unrelated source changes were preserved.`, {
        ...goalStructured(result.goal),
        projection: publicGoalProjection(result.projection),
        projection_id: result.projection.projectionId,
        projection_status: result.projection.status,
        reused: result.reused,
        recovered: result.recovered
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "pause_goal",
    {
      title: "Pause Goal Scheduling",
      description: "Pause new Goal scheduling while allowing an already-running attempt to finish and publish evidence under its approved lease. Persistent pause prevents every backoff retry, next semantic turn, dependency launch, and private integration until explicit resume. Once automatic private integration reaches waiting_review, the stopped scheduler remains available for Pro review and cannot be paused/resumed back into execution. This is not a worker interrupt; use cancel_goal to stop active workers.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        pause_key: z.string().min(1).max(160)
      },
      annotations: GOAL_PLAN_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Pausing Goal scheduling...", "openai/toolInvocation/invoked": "Goal scheduling paused" }
    },
    async (args) => {
      const current = await allowedGoal(config, args.goal_id);
      if (current.executionPolicy === "persistent" && current.lifecycle !== "running") {
        throw new CodexProError("Persistent Goal scheduling can pause only while lifecycle=running. A review-waiting persistent Goal has already stopped its scheduler and must remain available for Pro review.");
      }
      const goal = await pauseGoal(goalStoreConfig(config), args.goal_id, { expectedRevision: args.expected_revision, requestKey: args.pause_key });
      assertGoalSourceAllowed(config, goal);
      const schedulerView = await passiveGoalSchedulerView(config, goal);
      const note = goal.executionPolicy === "persistent"
        ? "The durable pause fence prevents new scheduling. Already-running workers keep their approved leases; resume_goal explicitly wakes persistent scheduling."
        : "Already-running workers continue; no new work will launch until resume_goal and an explicit start_goal continuation.";
      return textResult(`${goalText("Goal Paused", schedulerView?.goal ?? goal)}\n\n${note}`, {
        ...goalStructured(schedulerView?.goal ?? goal),
        ...goalSchedulerStructured(schedulerView)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "resume_goal",
    {
      title: "Resume Goal Scheduling",
      description: "Resume a paused Goal inside the unchanged approved contract. supervised only reopens scheduling state and still needs start_goal for worker launch. persistent explicitly wakes or recovers its detached scheduler; due fixed-policy retries may then launch within the already-approved start authority. This tool requires the same execution gate as start_goal.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        resume_key: z.string().min(1).max(160)
      },
      annotations: GOAL_EXECUTION_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Resuming Goal scheduling...", "openai/toolInvocation/invoked": "Goal scheduling resumed" }
    },
    async (args) => {
      assertGoalExecutionEnabled(config);
      const current = await allowedGoal(config, args.goal_id);
      if (current.executionPolicy === "persistent") {
        const resumed = await resumePersistentGoal(
          {
            dataRoot: config.codingTaskDir,
            codexBinary: await resolveCodexExecutable(config),
            codexDir: config.codexDir,
            maxOutputBytes: config.maxOutputBytes
          },
          args.goal_id,
          {
            expectedRevision: args.expected_revision,
            resumeKey: args.resume_key,
            runtimeContentPolicy: createGoalContentPolicySnapshot(config.blockedGlobs)
          }
        );
        assertGoalSourceAllowed(config, resumed.goal);
        const schedulerView = await getPersistentGoalScheduler(goalStoreConfig(config), resumed.goal.goalId);
        return textResult(`${goalText("Persistent Goal Resumed", schedulerView.goal)}\n\nThe detached scheduler wake is persisted; it may schedule dependencies and mechanically integrate verified patches only in the private integration worktree.`, {
          ...goalStructured(schedulerView.goal),
          ...goalSchedulerStructured(schedulerView),
          scheduler_definition_fingerprint: resumed.definition.fingerprint,
          reused: resumed.reused
        });
      }
      const goal = await resumeGoal(goalStoreConfig(config), args.goal_id, { expectedRevision: args.expected_revision, requestKey: args.resume_key });
      assertGoalSourceAllowed(config, goal);
      return textResult(goalText("Goal Resumed", goal), goalStructured(goal));
    }
  );

  registerCodexTool(
    config,
    server,
    "cancel_goal",
    {
      title: "Cancel Goal",
      description: "Durably cancel every active Goal-owned worker and any scheduled backoff retry before marking the Goal terminal. Does not require or resolve a Codex executable and never launches or relaunches work.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        cancel_key: z.string().min(1).max(160),
        reason: z.string().min(1).max(1_000).optional()
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Canceling Goal workers...", "openai/toolInvocation/invoked": "Goal canceled" }
    },
    async (args) => {
      const current = await allowedGoal(config, args.goal_id);
      const goal = current.executionPolicy === "persistent"
        ? await requestPersistentGoalCancel(goalStoreConfig(config), args.goal_id, {
            expectedRevision: args.expected_revision,
            cancelKey: args.cancel_key,
            reason: args.reason
          })
        : await cancelGoal(goalStoreConfig(config), args.goal_id, {
            expectedRevision: args.expected_revision,
            cancelKey: args.cancel_key,
            reason: args.reason
          });
      assertGoalSourceAllowed(config, goal);
      const schedulerView = await passiveGoalSchedulerView(config, goal);
      const title = goal.lifecycle === "canceling" ? "Goal Cancellation Requested" : "Goal Canceled";
      const cancellationNote = current.executionPolicy === "persistent"
        ? "Persistent cancellation records authority before store-only child reconciliation and never resolves or launches Codex."
        : "Supervised Goal workers were canceled without relaunching work.";
      return textResult(`${goalText(title, schedulerView?.goal ?? goal)}\n\n${cancellationNote}`, {
        ...goalStructured(schedulerView?.goal ?? goal),
        ...goalSchedulerStructured(schedulerView),
        cancellation_pending: goal.lifecycle === "canceling"
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "complete_goal",
    {
      title: "Complete Goal",
      description: "Record Pro's final semantic judgment against every persisted completion criterion and verification requirement. Isolated Goals remain source-neutral. Live Goals require the exact review fingerprint and authoritatively verify that the completed integration checkpoint is already projected; completion never rewrites source.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        completion_key: z.string().min(1).max(160),
        summary: z.string().min(1).max(20_000),
        criteria: z.array(z.object({
          requirement: z.string().min(1).max(2_000),
          status: z.enum(["passed", "failed", "skipped"]),
          evidence: z.string().min(1).max(4_000)
        })).max(100),
        verification: z.array(z.object({
          requirement: z.string().min(1).max(2_000),
          status: z.enum(["passed", "failed", "skipped"]),
          evidence: z.string().min(1).max(4_000)
        })).max(100),
        review_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("Required for Live Goals: the exact fingerprint returned by review_goal for the projected integration checkpoint."),
        confirm: z.literal(true).describe("True only after Pro reviewed the integrated diff and evidence.")
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Recording Goal completion...", "openai/toolInvocation/invoked": "Goal completion recorded" }
    },
    async (args) => {
      await allowedGoal(config, args.goal_id);
      const goal = await completeGoal({ dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes }, args.goal_id, {
        expectedRevision: args.expected_revision,
        completionKey: args.completion_key,
        summary: args.summary,
        criteria: args.criteria,
        verification: args.verification,
        reviewFingerprint: args.review_fingerprint
      });
      assertGoalSourceAllowed(config, goal);
      const completionNote = goal.workspacePolicy === "live"
        ? "The result is accepted. Any already-projected checkpoint remains in source; apply_goal finalizes that exact projection without writing it twice when it matches the completed integration checkpoint."
        : "The result is accepted but remains isolated until a separately authorized apply_goal call.";
      return textResult(`${goalText("Goal Completed", goal)}\n\n${completionNote}`, goalStructured(goal));
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_goal",
    {
      title: "Apply Goal to Source",
      description: "Apply a completed Goal's reviewed patch to its allowed source workspace without staging or committing. Requires contract permission, explicit user confirmation, exact source HEAD, no overlap with pre-existing dirty paths, and persisted authoritative readback.",
      inputSchema: {
        goal_id: z.string().regex(/^goal_[a-f0-9]{24}$/),
        expected_revision: z.number().int().min(1),
        application_key: z.string().min(1).max(160),
        confirm: z.literal(true).describe("True only after the user explicitly approves this source-workspace effect.")
      },
      annotations: GOAL_APPROVAL_ANNOTATIONS,
      _meta: { ...toolCardMeta(), "openai/toolInvocation/invoking": "Applying completed Goal to source...", "openai/toolInvocation/invoked": "Goal applied to source" }
    },
    async (args) => {
      assertGoalSourceWriteEnabled(config);
      await allowedGoal(config, args.goal_id);
      const goal = await applyCompletedGoal(
        { dataRoot: config.codingTaskDir, maxOutputBytes: config.maxOutputBytes },
        args.goal_id,
        {
          expectedRevision: args.expected_revision,
          applicationKey: args.application_key,
          isPathContentAllowed: (relativePath) => !guard.isBlockedRelativePath(relativePath)
        }
      );
      assertGoalSourceAllowed(config, goal);
      const applicationNote = goal.sourceApplication?.zeroWrite
        ? `The already-current Live projection ${goal.sourceApplication.adoptedProjectionId ?? ""} was finalized without rewriting source.`
        : `Source application: ${goal.sourceApplication?.status}.`;
      return textResult(`${goalText("Goal Applied", goal)}\n\n${applicationNote} No stage, commit, push, or PR was created.`, goalStructured(goal));
    }
  );

  return server;
}
