import { createHash } from "node:crypto";
import { buildGoalWorkerPrompt } from "./goalPrompt.js";

export const GOAL_STATE_VERSION = 1 as const;
export const GOAL_ID_PATTERN = /^goal_[a-f0-9]{24}$/;
export const GOAL_WORK_ID_PATTERN = /^work_[a-z0-9][a-z0-9_-]{0,63}$/;
export const GOAL_CONTINUATION_INTENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type GoalLifecycle = "proposed" | "approved" | "running" | "paused" | "canceling" | "waiting_review" | "completed" | "failed" | "canceled";
export type GoalExecutionPolicy = "supervised" | "persistent";
export type GoalWorkspacePolicy = "live" | "isolated";
export type GoalApprovalStatus = "pending" | "approved" | "rejected";
export type GoalWorkStatus = "planned" | "ready" | "launching" | "running" | "continuing" | "waiting_review" | "integrating" | "integrated" | "blocked" | "failed" | "canceled";
export type GoalBlackboardKind = "discovery" | "contract" | "file_ownership" | "question" | "answer" | "blocker" | "verification" | "decision";
export type GoalEventKind = "proposed" | "approved" | "approval_rejected" | "started" | "paused" | "resumed" | "cancel_requested" | "canceled" | "scheduler_updated" | "work_updated" | "blackboard_published" | "integration_updated" | "projection_updated" | "completed" | "failed";

export interface GoalContentPolicySnapshot {
  version: 1;
  algorithm: "blocked-globs-ci-v1";
  blockedGlobs: string[];
  fingerprint: string;
}

export type GoalSchedulerStatus = "queued" | "running" | "stopped" | "failed";

export interface GoalSchedulerAuthority {
  epoch: number;
  leaseId: string;
  startKey: string;
  definitionFingerprint: string;
  status: GoalSchedulerStatus;
  requestedAt: string;
  acquiredAt?: string;
  stoppedAt?: string;
  stopReason?: "paused" | "canceled" | "failed" | "semantic_review" | "scheduler_failed";
  error?: string;
}

export interface GoalCancelRequest {
  cancelKey: string;
  reason?: string;
  requestedAt: string;
}

export interface GoalWorkLaunchReservation {
  launchKey: string;
  taskKey: string;
  taskId: string;
  schedulerEpoch: number;
  schedulerLeaseId: string;
  operationId: string;
  baseSha: string;
  reservedAt: string;
}

export interface GoalContinuationIntent {
  intentId: string;
  prompt: string;
  fingerprint: string;
}

export interface GoalRetryPolicy {
  version: 1;
  algorithm: "infra-pre-turn-v1";
  backoffMs: [1000, 5000];
  retryableFailures: Array<{ code: "app_server_startup" | "app_server_initialize_transport"; category: "infrastructure"; phase: "runner_start" | "app_server_initialize"; outcomeKnown: true; turnStarted: false }>;
  fingerprint: string;
}

export const GOAL_RETRYABLE_FAILURES_V1: GoalRetryPolicy["retryableFailures"] = [
  { code: "app_server_startup", category: "infrastructure", phase: "runner_start", outcomeKnown: true, turnStarted: false },
  { code: "app_server_initialize_transport", category: "infrastructure", phase: "app_server_initialize", outcomeKnown: true, turnStarted: false }
];

export type GoalWorkAttemptStatus = "reserved" | "backoff" | "running" | "succeeded" | "failed" | "canceled";

export interface GoalWorkAttemptFailure {
  code: string;
  category: "infrastructure" | "model_or_tool" | "policy" | "cancellation" | "identity" | "resource" | "unknown";
  phase: "runner_start" | "app_server_initialize" | "thread_establish" | "turn_start" | "turn_active" | "terminal_writeback" | "reconciliation" | "unknown";
  retryable: boolean;
  outcomeKnown: boolean;
  turnStarted: boolean;
  summarySha256: string;
  summary?: string;
  occurredAt: string;
}

export interface GoalWorkAttempt {
  attemptIndex: number;
  operationId: string;
  status: GoalWorkAttemptStatus;
  taskRevision?: number;
  executorEpoch?: number;
  executorLeaseId?: string;
  runFingerprint?: string;
  runStatus?: "queued" | "running" | "waiting_review" | "completed" | "failed" | "canceled";
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  startObservation?: GoalWorkTurnObservation;
  terminalObservation?: GoalWorkTurnObservation;
  failure?: GoalWorkAttemptFailure;
  scheduledAt: string;
  notBefore: string;
  startedAt?: string;
  finishedAt?: string;
}

export type GoalWorkTurnStatus = "reserved" | "running" | "succeeded" | "failed" | "canceled";

export interface GoalWorkTurnObservation {
  capturedAt: string;
  headSha: string;
  status: string;
  diffStat: string;
  diffSha256: string;
  dirty: boolean;
  changedPaths: string[];
  statusSha256?: string;
  diffStatSha256?: string;
  changedPathsSha256?: string;
  changedPathCount?: number;
}

export interface GoalWorkTurn {
  turnIndex: number;
  intentId: "initial" | string;
  intentFingerprint: string;
  promptSha256: string;
  operationId: string;
  previousOperationId?: string;
  taskId: string;
  baseSha: string;
  taskRevision?: number;
  executorEpoch?: number;
  executorLeaseId?: string;
  status: GoalWorkTurnStatus;
  runFingerprint?: string;
  runStatus?: "queued" | "running" | "waiting_review" | "completed" | "failed" | "canceled";
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  resultSummary?: string;
  resultSha256?: string;
  stopReason?: "terminal_success" | "failed" | "canceled";
  terminalObservation?: GoalWorkTurnObservation;
  attempts?: GoalWorkAttempt[];
  reservedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface GoalResourceLimits {
  maxConcurrency: number;
  timeoutMs: number;
  maxTurnsPerWorker: number;
  maxRetriesPerWorker: number;
  maxLogBytes: number;
}

export interface GoalSourceEffects {
  apply: boolean;
  commit: boolean;
  push: boolean;
  draftPr: boolean;
}

export interface GoalPermissions {
  fileGlobs: string[];
  commands: string[];
  network: boolean;
  sourceEffects: GoalSourceEffects;
}

export interface GoalWorkItem {
  workId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  verification: string[];
  dependsOn: string[];
  parallelGroup?: string;
  fileGlobs: string[];
  continuationIntents?: GoalContinuationIntent[];
  turns?: GoalWorkTurn[];
  status: GoalWorkStatus;
  launch?: GoalWorkLaunchReservation;
  baseSha?: string;
  codingTaskId?: string;
  operationId?: string;
  reviewDiffSha256?: string;
  integrationKey?: string;
  integratedCommitSha?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface GoalApproval {
  status: GoalApprovalStatus;
  contractFingerprint: string;
  approvalKey?: string;
  approvedAt?: string;
  rejectedAt?: string;
  reason?: string;
}

export interface GoalBlackboardRecord {
  recordId: string;
  recordKey: string;
  fingerprint: string;
  kind: GoalBlackboardKind;
  author: "pro" | `worker:${string}`;
  workId?: string;
  summary: string;
  evidence: string[];
  paths: string[];
  createdAt: string;
}

export interface GoalEvent {
  at: string;
  kind: GoalEventKind;
  message?: string;
  workId?: string;
}

export interface GoalEvidenceResult {
  requirement: string;
  status: "passed" | "failed" | "skipped";
  evidence: string;
}

export interface GoalCompletion {
  completionKey: string;
  summary: string;
  criteria: GoalEvidenceResult[];
  verification: GoalEvidenceResult[];
  completedAt: string;
  reviewFingerprint?: string;
}

export interface GoalSourceApplication {
  applicationKey: string;
  status: "applying" | "applied" | "failed";
  patchSha256: string;
  sourceHeadSha: string;
  sourceDirtyPathsBefore: string[];
  sourceDirtyPathsAfter?: string[];
  startedAt: string;
  appliedAt?: string;
  error?: string;
  zeroWrite?: boolean;
  adoptedProjectionId?: string;
  reviewFingerprint?: string;
}

export type GoalProjectionStatus = "prepared" | "applying" | "applied" | "reverting" | "reverted" | "recovery_required" | "adopted";

export interface GoalProjection {
  projectionId: string;
  projectionKey: string;
  fingerprint: string;
  status: GoalProjectionStatus;
  fromIntegrationSha: string;
  toIntegrationSha: string;
  reviewFingerprint: string;
  deltaPatchSha256: string;
  cumulativePatchSha256: string;
  changedPaths: string[];
  journalRelativePath: string;
  sourceHeadSha: string;
  sourceDirtyPathsBefore: string[];
  sourceDirtyPathsAfter?: string[];
  beforeManifestSha256: string;
  afterManifestSha256: string;
  preparedAt: string;
  appliedAt?: string;
  revertKey?: string;
  revertedAt?: string;
  error?: string;
}

export interface GoalLiveState {
  projectedIntegrationSha: string;
  pendingProjectionId?: string;
  projections: GoalProjection[];
  adoptedAt?: string;
  adoptedProjectionId?: string;
  adoptedReviewFingerprint?: string;
}

export interface GoalState {
  version: typeof GOAL_STATE_VERSION;
  goalId: string;
  goalKey: string;
  createFingerprint: string;
  contractFingerprint: string;
  title: string;
  goal: string;
  exclusions: string[];
  completionCriteria: string[];
  verification: string[];
  executionPolicy: GoalExecutionPolicy;
  workspacePolicy: GoalWorkspacePolicy;
  workerModel: string;
  workerEffort: "low" | "medium" | "high" | "xhigh";
  limits: GoalResourceLimits;
  permissions: GoalPermissions;
  contentPolicy?: GoalContentPolicySnapshot;
  retryPolicy?: GoalRetryPolicy;
  lifecycle: GoalLifecycle;
  approval: GoalApproval;
  sourceRoot: string;
  sourceGitCommonDir: string;
  baseSha: string;
  sourceDirtyAtCreation: boolean;
  sourceStatusEntryCountAtCreation: number;
  sourceUncommittedChangesIncluded: false;
  integrationWorktreeRoot: string;
  integrationHeadSha?: string;
  startKey?: string;
  pauseKey?: string;
  resumeKey?: string;
  cancelKey?: string;
  cancelRequest?: GoalCancelRequest;
  scheduler?: GoalSchedulerAuthority;
  revision: number;
  work: GoalWorkItem[];
  blackboard: GoalBlackboardRecord[];
  events: GoalEvent[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  completion?: GoalCompletion;
  sourceApplication?: GoalSourceApplication;
  live?: GoalLiveState;
}

const LIFECYCLES = new Set<GoalLifecycle>(["proposed", "approved", "running", "paused", "canceling", "waiting_review", "completed", "failed", "canceled"]);
const WORK_STATUSES = new Set<GoalWorkStatus>(["planned", "ready", "launching", "running", "continuing", "waiting_review", "integrating", "integrated", "blocked", "failed", "canceled"]);
const TURN_STATUSES = new Set<GoalWorkTurnStatus>(["reserved", "running", "succeeded", "failed", "canceled"]);
const ATTEMPT_STATUSES = new Set<GoalWorkAttemptStatus>(["reserved", "backoff", "running", "succeeded", "failed", "canceled"]);
const BLACKBOARD_KINDS = new Set<GoalBlackboardKind>(["discovery", "contract", "file_ownership", "question", "answer", "blocker", "verification", "decision"]);
const EVENT_KINDS = new Set<GoalEventKind>(["proposed", "approved", "approval_rejected", "started", "paused", "resumed", "cancel_requested", "canceled", "scheduler_updated", "work_updated", "blackboard_published", "integration_updated", "projection_updated", "completed", "failed"]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;

function invalid(name: string): never {
  throw new Error(`Invalid Goal state: ${name}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, name: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) invalid(name);
  return value;
}

function timestamp(value: unknown, name: string, optional = false): string | undefined {
  const text = stringField(value, name, 64, optional);
  if (text !== undefined && !Number.isFinite(Date.parse(text))) invalid(name);
  return text;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(name);
  return value as number;
}

function stringArray(value: unknown, name: string, maxItems: number, maxLength: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(name);
  for (const [index, item] of value.entries()) stringField(item, `${name}[${index}]`, maxLength);
}

export function validateGoalId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!GOAL_ID_PATTERN.test(normalized)) throw new Error("Invalid Goal id; expected goal_ followed by 24 lowercase hexadecimal characters.");
  return normalized;
}

export function validateGoalWorkId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!GOAL_WORK_ID_PATTERN.test(normalized)) throw new Error("Invalid Goal work id; expected work_ followed by letters, numbers, underscore, or dash.");
  return normalized;
}

export function validateGoalContinuationIntentId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!GOAL_CONTINUATION_INTENT_ID_PATTERN.test(normalized)) throw new Error("Invalid Goal continuation intent id; expected 1-64 lowercase letters, numbers, underscore, or dash.");
  return normalized;
}

export function computeGoalContinuationIntentFingerprint(workId: string, turnIndex: number, intentId: string, prompt: string): string {
  return createHash("sha256").update(`codexpro-goal-continuation-intent-v1\0${validateGoalWorkId(workId)}\0${turnIndex}\0${validateGoalContinuationIntentId(intentId)}\0${prompt}`).digest("hex");
}

export function computeGoalInitialIntentFingerprint(workId: string, prompt: string): string {
  return createHash("sha256").update(`codexpro-goal-initial-intent-v1\0${validateGoalWorkId(workId)}\0${prompt}`).digest("hex");
}

export function computeGoalRetryPolicyFingerprint(maxRetries: number): string {
  return createHash("sha256").update(`codexpro-goal-retry-policy-v1\0${JSON.stringify({ maxRetries, algorithm: "infra-pre-turn-v1", backoffMs: [1000, 5000], retryableFailures: GOAL_RETRYABLE_FAILURES_V1 })}`).digest("hex");
}

export function isGoalRetryableFailureV1(failure: Pick<GoalWorkAttemptFailure, "code" | "category" | "phase" | "outcomeKnown" | "turnStarted">): boolean {
  return failure.outcomeKnown === true && failure.turnStarted === false && GOAL_RETRYABLE_FAILURES_V1.some((entry) => entry.code === failure.code && entry.category === failure.category && entry.phase === failure.phase);
}

export function assertGoalDag(work: Array<Pick<GoalWorkItem, "workId" | "dependsOn">>): void {
  const ids = new Set(work.map((item) => item.workId));
  if (ids.size !== work.length) throw new Error("Goal work ids must be unique.");
  for (const item of work) {
    for (const dependency of item.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Goal work ${item.workId} depends on unknown work ${dependency}.`);
      if (dependency === item.workId) throw new Error(`Goal work ${item.workId} cannot depend on itself.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(work.map((item) => [item.workId, item]));
  const visit = (workId: string): void => {
    if (visited.has(workId)) return;
    if (visiting.has(workId)) throw new Error(`Goal work dependency cycle includes ${workId}.`);
    visiting.add(workId);
    for (const dependency of byId.get(workId)?.dependsOn ?? []) visit(dependency);
    visiting.delete(workId);
    visited.add(workId);
  };
  for (const item of work) visit(item.workId);
}

export function assertGoalState(value: unknown, expectedGoalId?: string): asserts value is GoalState {
  if (!record(value) || value.version !== GOAL_STATE_VERSION) invalid("version");
  const goalId = validateGoalId(String(value.goalId ?? ""));
  if (expectedGoalId && goalId !== validateGoalId(expectedGoalId)) invalid("goalId mismatch");
  stringField(value.goalKey, "goalKey", 160);
  if (typeof value.createFingerprint !== "string" || !HASH.test(value.createFingerprint)) invalid("createFingerprint");
  if (typeof value.contractFingerprint !== "string" || !HASH.test(value.contractFingerprint)) invalid("contractFingerprint");
  stringField(value.title, "title", 500);
  stringField(value.goal, "goal", 20_000);
  stringArray(value.exclusions, "exclusions", 100, 2_000);
  stringArray(value.completionCriteria, "completionCriteria", 100, 2_000);
  stringArray(value.verification, "verification", 100, 2_000);
  if (value.executionPolicy !== "supervised" && value.executionPolicy !== "persistent") invalid("executionPolicy");
  if (value.workspacePolicy !== "live" && value.workspacePolicy !== "isolated") invalid("workspacePolicy");
  stringField(value.workerModel, "workerModel", 160);
  if (!["low", "medium", "high", "xhigh"].includes(String(value.workerEffort))) invalid("workerEffort");
  if (!record(value.limits)) invalid("limits");
  integer(value.limits.maxConcurrency, "limits.maxConcurrency", 1, 8);
  integer(value.limits.timeoutMs, "limits.timeoutMs", 1_000, 86_400_000);
  integer(value.limits.maxTurnsPerWorker, "limits.maxTurnsPerWorker", 1, 100);
  integer(value.limits.maxRetriesPerWorker, "limits.maxRetriesPerWorker", 0, 10);
  integer(value.limits.maxLogBytes, "limits.maxLogBytes", 65_536, 104_857_600);
  if (!record(value.permissions)) invalid("permissions");
  stringArray(value.permissions.fileGlobs, "permissions.fileGlobs", 200, 1_000);
  stringArray(value.permissions.commands, "permissions.commands", 100, 1_000);
  if (typeof value.permissions.network !== "boolean") invalid("permissions.network");
  if (!record(value.permissions.sourceEffects)) invalid("permissions.sourceEffects");
  for (const field of ["apply", "commit", "push", "draftPr"] as const) {
    if (typeof value.permissions.sourceEffects[field] !== "boolean") invalid(`permissions.sourceEffects.${field}`);
  }
  if (value.contentPolicy !== undefined) {
    if (!record(value.contentPolicy) || value.contentPolicy.version !== 1 || value.contentPolicy.algorithm !== "blocked-globs-ci-v1") invalid("contentPolicy");
    stringArray(value.contentPolicy.blockedGlobs, "contentPolicy.blockedGlobs", 500, 1_000);
    if (typeof value.contentPolicy.fingerprint !== "string" || !HASH.test(value.contentPolicy.fingerprint)) invalid("contentPolicy.fingerprint");
    const canonicalGlobs = [...new Set((value.contentPolicy.blockedGlobs as string[]).map((glob) => glob.trim()))].sort();
    if ((value.contentPolicy.blockedGlobs as string[]).some((glob) => glob !== glob.trim()) || JSON.stringify(canonicalGlobs) !== JSON.stringify(value.contentPolicy.blockedGlobs)) invalid("contentPolicy.blockedGlobs canonical order");
    const expectedPolicyFingerprint = createHash("sha256").update(`codexpro-goal-content-policy-ci-v1\0${JSON.stringify(canonicalGlobs)}`).digest("hex");
    if (value.contentPolicy.fingerprint !== expectedPolicyFingerprint) invalid("contentPolicy fingerprint binding");
  }
  if (value.retryPolicy !== undefined) {
    if (!record(value.retryPolicy) || value.retryPolicy.version !== 1 || value.retryPolicy.algorithm !== "infra-pre-turn-v1" || JSON.stringify(value.retryPolicy.backoffMs) !== "[1000,5000]" || JSON.stringify(value.retryPolicy.retryableFailures) !== JSON.stringify(GOAL_RETRYABLE_FAILURES_V1) || value.retryPolicy.fingerprint !== computeGoalRetryPolicyFingerprint(value.limits.maxRetriesPerWorker as number)) invalid("retryPolicy");
  }
  if (value.executionPolicy === "persistent") {
    if (value.workspacePolicy !== "isolated") invalid("persistent workspacePolicy");
    if (value.contentPolicy === undefined) invalid("persistent contentPolicy");
    if ((value.limits.maxTurnsPerWorker as number) > 4 || (value.limits.maxRetriesPerWorker as number) > 2 ||
        ((value.limits.maxRetriesPerWorker as number) > 0 && value.retryPolicy === undefined)) invalid("persistent limits");
    if (value.permissions.commands.length || value.permissions.network || Object.values(value.permissions.sourceEffects).some(Boolean)) invalid("persistent permissions");
  }
  if (value.executionPolicy === "supervised" && (value.limits.maxRetriesPerWorker !== 0 || value.retryPolicy !== undefined)) invalid("supervised retry policy");
  if (!LIFECYCLES.has(value.lifecycle as GoalLifecycle)) invalid("lifecycle");
  if (!record(value.approval)) invalid("approval");
  if (!["pending", "approved", "rejected"].includes(String(value.approval.status))) invalid("approval.status");
  if (typeof value.approval.contractFingerprint !== "string" || value.approval.contractFingerprint !== value.contractFingerprint) invalid("approval.contractFingerprint");
  stringField(value.approval.approvalKey, "approval.approvalKey", 160, true);
  timestamp(value.approval.approvedAt, "approval.approvedAt", true);
  timestamp(value.approval.rejectedAt, "approval.rejectedAt", true);
  stringField(value.approval.reason, "approval.reason", 2_000, true);
  stringField(value.sourceRoot, "sourceRoot", 4_096);
  stringField(value.sourceGitCommonDir, "sourceGitCommonDir", 4_096);
  if (typeof value.baseSha !== "string" || !FULL_SHA.test(value.baseSha)) invalid("baseSha");
  if (typeof value.sourceDirtyAtCreation !== "boolean") invalid("sourceDirtyAtCreation");
  integer(value.sourceStatusEntryCountAtCreation, "sourceStatusEntryCountAtCreation", 0, 1_000_000);
  if (value.sourceUncommittedChangesIncluded !== false) invalid("sourceUncommittedChangesIncluded");
  stringField(value.integrationWorktreeRoot, "integrationWorktreeRoot", 4_096);
  if (value.integrationHeadSha !== undefined && (typeof value.integrationHeadSha !== "string" || !FULL_SHA.test(value.integrationHeadSha))) invalid("integrationHeadSha");
  stringField(value.startKey, "startKey", 160, true);
  stringField(value.pauseKey, "pauseKey", 160, true);
  stringField(value.resumeKey, "resumeKey", 160, true);
  stringField(value.cancelKey, "cancelKey", 160, true);
  if (value.cancelRequest !== undefined) {
    if (!record(value.cancelRequest)) invalid("cancelRequest");
    stringField(value.cancelRequest.cancelKey, "cancelRequest.cancelKey", 160);
    stringField(value.cancelRequest.reason, "cancelRequest.reason", 2_000, true);
    timestamp(value.cancelRequest.requestedAt, "cancelRequest.requestedAt");
    if (value.cancelKey !== value.cancelRequest.cancelKey || !["canceling", "canceled"].includes(String(value.lifecycle))) invalid("cancelRequest authority");
  }
  if (value.scheduler !== undefined) {
    if (!record(value.scheduler)) invalid("scheduler");
    integer(value.scheduler.epoch, "scheduler.epoch", 1, Number.MAX_SAFE_INTEGER);
    stringField(value.scheduler.leaseId, "scheduler.leaseId", 160);
    stringField(value.scheduler.startKey, "scheduler.startKey", 160);
    if (typeof value.scheduler.definitionFingerprint !== "string" || !HASH.test(value.scheduler.definitionFingerprint)) invalid("scheduler.definitionFingerprint");
    if (!["queued", "running", "stopped", "failed"].includes(String(value.scheduler.status))) invalid("scheduler.status");
    timestamp(value.scheduler.requestedAt, "scheduler.requestedAt");
    timestamp(value.scheduler.acquiredAt, "scheduler.acquiredAt", true);
    timestamp(value.scheduler.stoppedAt, "scheduler.stoppedAt", true);
    if (value.scheduler.stopReason !== undefined && !["paused", "canceled", "failed", "semantic_review", "scheduler_failed"].includes(String(value.scheduler.stopReason))) invalid("scheduler.stopReason");
    stringField(value.scheduler.error, "scheduler.error", 20_000, true);
    if (value.executionPolicy !== "persistent") invalid("scheduler executionPolicy");
    if (value.startKey !== value.scheduler.startKey) invalid("scheduler startKey authority");
    if (value.scheduler.status === "queued" && (value.scheduler.acquiredAt !== undefined || value.scheduler.stoppedAt !== undefined || value.scheduler.stopReason !== undefined)) invalid("scheduler queued timestamps");
    if (value.scheduler.status === "running" && (value.scheduler.acquiredAt === undefined || value.scheduler.stoppedAt !== undefined || value.scheduler.stopReason !== undefined)) invalid("scheduler running timestamps");
    if (["stopped", "failed"].includes(String(value.scheduler.status)) && (value.scheduler.acquiredAt === undefined || value.scheduler.stoppedAt === undefined || value.scheduler.stopReason === undefined)) invalid("scheduler stopped authority");
    if (value.scheduler.status === "queued" && !["running", "canceling"].includes(String(value.lifecycle))) invalid("scheduler queued lifecycle");
    if (value.scheduler.status === "failed" && value.lifecycle !== "failed") invalid("scheduler failed lifecycle");
    if (value.scheduler.status === "stopped") {
      const expectedLifecycle = value.scheduler.stopReason === "paused" ? "paused" : value.scheduler.stopReason === "canceled" ? "canceled" : value.scheduler.stopReason === "semantic_review" ? "waiting_review" : "failed";
      if (value.lifecycle !== expectedLifecycle && !(value.lifecycle === "canceling" && value.cancelRequest !== undefined)) invalid("scheduler stopped lifecycle");
    }
  }
  integer(value.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(value.work) || value.work.length < 1 || value.work.length > 50) invalid("work");
  for (const [index, item] of value.work.entries()) {
    if (!record(item)) invalid(`work[${index}]`);
    validateGoalWorkId(String(item.workId ?? ""));
    stringField(item.title, `work[${index}].title`, 500);
    stringField(item.goal, `work[${index}].goal`, 20_000);
    stringArray(item.acceptanceCriteria, `work[${index}].acceptanceCriteria`, 50, 2_000);
    stringArray(item.verification, `work[${index}].verification`, 50, 2_000);
    stringArray(item.dependsOn, `work[${index}].dependsOn`, 50, 80);
    stringField(item.parallelGroup, `work[${index}].parallelGroup`, 100, true);
    stringArray(item.fileGlobs, `work[${index}].fileGlobs`, 100, 1_000);
    if (item.continuationIntents !== undefined) {
      if (!Array.isArray(item.continuationIntents) || item.continuationIntents.length > 3) invalid(`work[${index}].continuationIntents`);
      const intentIds = new Set<string>();
      for (const [intentIndex, intent] of item.continuationIntents.entries()) {
        if (!record(intent)) invalid(`work[${index}].continuationIntents[${intentIndex}]`);
        const intentId = validateGoalContinuationIntentId(String(intent.intentId ?? ""));
        if (intentIds.has(intentId)) invalid(`work[${index}].continuationIntents duplicate intentId`);
        intentIds.add(intentId);
        const prompt = stringField(intent.prompt, `work[${index}].continuationIntents[${intentIndex}].prompt`, 65_536)!;
        if (typeof intent.fingerprint !== "string" || intent.fingerprint !== computeGoalContinuationIntentFingerprint(String(item.workId), intentIndex + 2, intentId, prompt)) invalid(`work[${index}].continuationIntents[${intentIndex}].fingerprint`);
      }
    }
    if (value.executionPolicy === "persistent" && (item.continuationIntents?.length ?? 0) !== (value.limits.maxTurnsPerWorker as number) - 1) invalid(`work[${index}].continuationIntents count`);
    if (item.turns !== undefined) {
      if (!Array.isArray(item.turns) || item.turns.length > (value.limits.maxTurnsPerWorker as number)) invalid(`work[${index}].turns`);
      const turns = item.turns;
      const seenOperations = new Set<string>();
      for (const [turnOffset, turn] of turns.entries()) {
        if (!record(turn)) invalid(`work[${index}].turns[${turnOffset}]`);
        const turnIndex = integer(turn.turnIndex, `work[${index}].turns[${turnOffset}].turnIndex`, 1, value.limits.maxTurnsPerWorker as number);
        if (turnIndex !== turnOffset + 1) invalid(`work[${index}].turns order`);
        const expectedIntent = turnIndex === 1 ? undefined : item.continuationIntents?.[turnIndex - 2];
        const intentId = stringField(turn.intentId, `work[${index}].turns[${turnOffset}].intentId`, 64)!;
        if (intentId !== (expectedIntent?.intentId ?? "initial")) invalid(`work[${index}].turns[${turnOffset}].intent binding`);
        const approvedPrompt = turnIndex === 1 ? buildGoalWorkerPrompt(value as unknown as GoalState, item as unknown as GoalWorkItem) : String(expectedIntent?.prompt ?? "");
        const expectedIntentFingerprint = turnIndex === 1 ? computeGoalInitialIntentFingerprint(String(item.workId), approvedPrompt) : expectedIntent?.fingerprint;
        if (typeof turn.intentFingerprint !== "string" || turn.intentFingerprint !== expectedIntentFingerprint) invalid(`work[${index}].turns[${turnOffset}].intentFingerprint`);
        if (typeof turn.promptSha256 !== "string" || turn.promptSha256 !== createHash("sha256").update(approvedPrompt).digest("hex")) invalid(`work[${index}].turns[${turnOffset}].promptSha256`);
        const operationId = stringField(turn.operationId, `work[${index}].turns[${turnOffset}].operationId`, 160)!;
        stringField(turn.previousOperationId, `work[${index}].turns[${turnOffset}].previousOperationId`, 160, true);
        if ((turnIndex === 1) !== (turn.previousOperationId === undefined)) invalid(`work[${index}].turns[${turnOffset}].previousOperationId`);
        if (turnIndex > 1 && turn.previousOperationId !== (turns[turnOffset - 1] as Record<string, unknown> | undefined)?.operationId) invalid(`work[${index}].turns[${turnOffset}].previous operation binding`);
        if (typeof turn.taskId !== "string" || !/^task_[a-f0-9]{24}$/.test(turn.taskId)) invalid(`work[${index}].turns[${turnOffset}].taskId`);
        if (typeof turn.baseSha !== "string" || !FULL_SHA.test(turn.baseSha)) invalid(`work[${index}].turns[${turnOffset}].baseSha`);
        if (record(item.launch) && (turn.taskId !== item.launch.taskId || turn.baseSha !== item.launch.baseSha)) invalid(`work[${index}].turns[${turnOffset}] task/base binding`);
        if (turn.taskRevision !== undefined) integer(turn.taskRevision, `work[${index}].turns[${turnOffset}].taskRevision`, 1, Number.MAX_SAFE_INTEGER);
        if (turn.executorEpoch !== undefined) integer(turn.executorEpoch, `work[${index}].turns[${turnOffset}].executorEpoch`, 1, Number.MAX_SAFE_INTEGER);
        stringField(turn.executorLeaseId, `work[${index}].turns[${turnOffset}].executorLeaseId`, 160, true);
        if (!TURN_STATUSES.has(turn.status as GoalWorkTurnStatus)) invalid(`work[${index}].turns[${turnOffset}].status`);
        if (turn.runFingerprint !== undefined && (typeof turn.runFingerprint !== "string" || !HASH.test(turn.runFingerprint))) invalid(`work[${index}].turns[${turnOffset}].runFingerprint`);
        if (turn.runStatus !== undefined && !["queued", "running", "waiting_review", "completed", "failed", "canceled"].includes(String(turn.runStatus))) invalid(`work[${index}].turns[${turnOffset}].runStatus`);
        stringField(turn.threadId, `work[${index}].turns[${turnOffset}].threadId`, 200, true);
        stringField(turn.sessionId, `work[${index}].turns[${turnOffset}].sessionId`, 200, true);
        stringField(turn.turnId, `work[${index}].turns[${turnOffset}].turnId`, 200, true);
        stringField(turn.resultSummary, `work[${index}].turns[${turnOffset}].resultSummary`, 20_000, true);
        if (turn.resultSha256 !== undefined && (typeof turn.resultSha256 !== "string" || !HASH.test(turn.resultSha256))) invalid(`work[${index}].turns[${turnOffset}].resultSha256`);
        if (turn.stopReason !== undefined && !["terminal_success", "failed", "canceled"].includes(String(turn.stopReason))) invalid(`work[${index}].turns[${turnOffset}].stopReason`);
        if (turn.terminalObservation !== undefined) {
          if (!record(turn.terminalObservation)) invalid(`work[${index}].turns[${turnOffset}].terminalObservation`);
          timestamp(turn.terminalObservation.capturedAt, `work[${index}].turns[${turnOffset}].terminalObservation.capturedAt`);
          if (typeof turn.terminalObservation.headSha !== "string" || !FULL_SHA.test(turn.terminalObservation.headSha)) invalid(`work[${index}].turns[${turnOffset}].terminalObservation.headSha`);
          for (const field of ["status", "diffStat"] as const) if (typeof turn.terminalObservation[field] !== "string" || Buffer.byteLength(turn.terminalObservation[field] as string, "utf8") > 32_768 || turn.terminalObservation[field].includes("\0")) invalid(`work[${index}].turns[${turnOffset}].terminalObservation.${field}`);
          if (typeof turn.terminalObservation.diffSha256 !== "string" || !HASH.test(turn.terminalObservation.diffSha256) || typeof turn.terminalObservation.dirty !== "boolean") invalid(`work[${index}].turns[${turnOffset}].terminalObservation`);
          stringArray(turn.terminalObservation.changedPaths, `work[${index}].turns[${turnOffset}].terminalObservation.changedPaths`, 1_000, 1_000);
          for (const digest of ["statusSha256", "diffStatSha256", "changedPathsSha256"] as const) if (turn.terminalObservation[digest] !== undefined && (typeof turn.terminalObservation[digest] !== "string" || !HASH.test(turn.terminalObservation[digest]))) invalid(`work[${index}].turns[${turnOffset}].terminalObservation.${digest}`);
          if (turn.terminalObservation.changedPathCount !== undefined) integer(turn.terminalObservation.changedPathCount, `work[${index}].turns[${turnOffset}].terminalObservation.changedPathCount`, 0, 1_000);
          if (value.retryPolicy !== undefined && (turn.terminalObservation.status !== "" || turn.terminalObservation.diffStat !== "" || !Array.isArray(turn.terminalObservation.changedPaths) || turn.terminalObservation.changedPaths.length !== 0 || typeof turn.terminalObservation.statusSha256 !== "string" || typeof turn.terminalObservation.diffStatSha256 !== "string" || typeof turn.terminalObservation.changedPathsSha256 !== "string" || typeof turn.terminalObservation.changedPathCount !== "number")) invalid(`work[${index}].turns[${turnOffset}].terminalObservation compact authority`);
        }
        if (turn.attempts !== undefined) {
          if (!Array.isArray(turn.attempts) || turn.attempts.length < 1 || turn.attempts.length > (value.limits.maxRetriesPerWorker as number) + 1) invalid(`work[${index}].turns[${turnOffset}].attempts`);
          for (const [attemptOffset, attempt] of turn.attempts.entries()) {
            if (!record(attempt)) invalid(`work[${index}].turns[${turnOffset}].attempts[${attemptOffset}]`);
            const attemptIndex = integer(attempt.attemptIndex, `work[${index}].turns[${turnOffset}].attempts[${attemptOffset}].attemptIndex`, 0, 2);
            if (attemptIndex !== attemptOffset) invalid(`work[${index}].turns[${turnOffset}].attempts order`);
            const attemptOperation = stringField(attempt.operationId, `work[${index}].turns[${turnOffset}].attempts[${attemptOffset}].operationId`, 160)!;
            const expectedAttemptOperation = `goal:${goalId.slice(5)}:${item.workId}:turn:${turnIndex}:attempt:${attemptIndex}`;
            if (attemptOperation !== expectedAttemptOperation) invalid(`work[${index}].turns[${turnOffset}].attempt operation identity`);
            if (!ATTEMPT_STATUSES.has(attempt.status as GoalWorkAttemptStatus)) invalid(`work[${index}].turns[${turnOffset}].attempt status`);
            if (attempt.taskRevision !== undefined) integer(attempt.taskRevision, `work[${index}].turns[${turnOffset}].attempt taskRevision`, 1, Number.MAX_SAFE_INTEGER);
            if (attempt.executorEpoch !== undefined) integer(attempt.executorEpoch, `work[${index}].turns[${turnOffset}].attempt executorEpoch`, 1, Number.MAX_SAFE_INTEGER);
            stringField(attempt.executorLeaseId, `work[${index}].turns[${turnOffset}].attempt executorLeaseId`, 160, true);
            if (attempt.runFingerprint !== undefined && (typeof attempt.runFingerprint !== "string" || !HASH.test(attempt.runFingerprint))) invalid(`work[${index}].turns[${turnOffset}].attempt runFingerprint`);
            if (attempt.runStatus !== undefined && !["queued", "running", "waiting_review", "completed", "failed", "canceled"].includes(String(attempt.runStatus))) invalid(`work[${index}].turns[${turnOffset}].attempt runStatus`);
            stringField(attempt.threadId, `work[${index}].turns[${turnOffset}].attempt threadId`, 200, true);
            stringField(attempt.sessionId, `work[${index}].turns[${turnOffset}].attempt sessionId`, 200, true);
            stringField(attempt.turnId, `work[${index}].turns[${turnOffset}].attempt turnId`, 200, true);
            for (const field of ["startObservation", "terminalObservation"] as const) if (attempt[field] !== undefined) {
              if (!record(attempt[field])) invalid(`work[${index}].turns[${turnOffset}].attempt ${field}`);
              timestamp(attempt[field].capturedAt, `work[${index}].turns[${turnOffset}].attempt ${field}.capturedAt`);
              if (typeof attempt[field].headSha !== "string" || !FULL_SHA.test(attempt[field].headSha) || typeof attempt[field].diffSha256 !== "string" || !HASH.test(attempt[field].diffSha256) || typeof attempt[field].dirty !== "boolean") invalid(`work[${index}].turns[${turnOffset}].attempt ${field}`);
              for (const textName of ["status", "diffStat"] as const) if (typeof attempt[field][textName] !== "string" || Buffer.byteLength(attempt[field][textName] as string, "utf8") > 32_768 || attempt[field][textName].includes("\0")) invalid(`work[${index}].turns[${turnOffset}].attempt ${field}.${textName}`);
              stringArray(attempt[field].changedPaths, `work[${index}].turns[${turnOffset}].attempt ${field}.changedPaths`, 1_000, 1_000);
              for (const digest of ["statusSha256", "diffStatSha256", "changedPathsSha256"] as const) if (attempt[field][digest] !== undefined && (typeof attempt[field][digest] !== "string" || !HASH.test(attempt[field][digest]))) invalid(`work[${index}].turns[${turnOffset}].attempt ${field}.${digest}`);
              if (attempt[field].changedPathCount !== undefined) integer(attempt[field].changedPathCount, `work[${index}].turns[${turnOffset}].attempt ${field}.changedPathCount`, 0, 1_000);
              if (value.retryPolicy !== undefined && (attempt[field].status !== "" || attempt[field].diffStat !== "" || !Array.isArray(attempt[field].changedPaths) || attempt[field].changedPaths.length !== 0 || typeof attempt[field].statusSha256 !== "string" || typeof attempt[field].diffStatSha256 !== "string" || typeof attempt[field].changedPathsSha256 !== "string" || typeof attempt[field].changedPathCount !== "number")) invalid(`work[${index}].turns[${turnOffset}].attempt ${field} compact authority`);
            }
            if (attempt.failure !== undefined) {
              if (!record(attempt.failure)) invalid(`work[${index}].turns[${turnOffset}].attempt failure`);
              stringField(attempt.failure.code, `work[${index}].turns[${turnOffset}].attempt failure.code`, 100);
              if (!["infrastructure", "model_or_tool", "policy", "cancellation", "identity", "resource", "unknown"].includes(String(attempt.failure.category)) || !["runner_start", "app_server_initialize", "thread_establish", "turn_start", "turn_active", "terminal_writeback", "reconciliation", "unknown"].includes(String(attempt.failure.phase)) || typeof attempt.failure.retryable !== "boolean" || typeof attempt.failure.outcomeKnown !== "boolean" || typeof attempt.failure.turnStarted !== "boolean" || typeof attempt.failure.summarySha256 !== "string" || !HASH.test(attempt.failure.summarySha256)) invalid(`work[${index}].turns[${turnOffset}].attempt failure`);
              stringField(attempt.failure.summary, `work[${index}].turns[${turnOffset}].attempt failure.summary`, 2_000, true);
              timestamp(attempt.failure.occurredAt, `work[${index}].turns[${turnOffset}].attempt failure.occurredAt`);
              const retryableTuple = (attempt.failure.code === "app_server_startup" && attempt.failure.phase === "runner_start") ||
                (attempt.failure.code === "app_server_initialize_transport" && attempt.failure.phase === "app_server_initialize");
              const canonicalTuple = retryableTuple ||
                (["turn_failed", "turn_timeout"].includes(String(attempt.failure.code)) && attempt.failure.category === "model_or_tool" && attempt.failure.phase === "turn_active") ||
                (attempt.failure.code === "approval_or_input_declined" && attempt.failure.category === "policy" && ["turn_start", "turn_active"].includes(String(attempt.failure.phase))) ||
                (attempt.failure.code === "canceled" && attempt.failure.category === "cancellation" && ["runner_start", "turn_start", "turn_active"].includes(String(attempt.failure.phase))) ||
                (attempt.failure.code === "identity_mismatch" && attempt.failure.category === "identity" && ["runner_start", "app_server_initialize", "thread_establish", "turn_start", "turn_active"].includes(String(attempt.failure.phase))) ||
                (attempt.failure.code === "runner_lost" && attempt.failure.category === "infrastructure" && attempt.failure.phase === "reconciliation") ||
                (attempt.failure.code === "resource_or_output" && attempt.failure.category === "resource" && ["turn_start", "turn_active", "terminal_writeback"].includes(String(attempt.failure.phase))) ||
                (attempt.failure.code === "unknown" && attempt.failure.category === "unknown" && ["turn_start", "turn_active", "terminal_writeback", "unknown"].includes(String(attempt.failure.phase))) ||
                (attempt.failure.code === "goal_policy_or_provenance" && attempt.failure.category === "policy" && attempt.failure.phase === "reconciliation");
              if (!canonicalTuple) invalid(`work[${index}].turns[${turnOffset}].attempt failure tuple`);
              if (attempt.failure.retryable !== (retryableTuple && attempt.failure.category === "infrastructure" && attempt.failure.outcomeKnown === true && attempt.failure.turnStarted === false && attempt.threadId === undefined && attempt.sessionId === undefined && attempt.turnId === undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt retry classification`);
            }
            timestamp(attempt.scheduledAt, `work[${index}].turns[${turnOffset}].attempt scheduledAt`);
            timestamp(attempt.notBefore, `work[${index}].turns[${turnOffset}].attempt notBefore`);
            timestamp(attempt.startedAt, `work[${index}].turns[${turnOffset}].attempt startedAt`, true);
            timestamp(attempt.finishedAt, `work[${index}].turns[${turnOffset}].attempt finishedAt`, true);
            const bound = attempt.taskRevision !== undefined && attempt.executorEpoch !== undefined && attempt.executorLeaseId !== undefined;
            const terminalAttempt = ["succeeded", "failed", "canceled"].includes(String(attempt.status));
            if (["running", "succeeded", "failed"].includes(String(attempt.status)) && (!bound || attempt.runFingerprint === undefined || attempt.runStatus === undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt run authority`);
            if (attempt.status === "canceled" && (attempt.runStatus !== "canceled" || (!bound && (attempt.taskRevision !== undefined || attempt.executorEpoch !== undefined || attempt.executorLeaseId !== undefined || attempt.runFingerprint !== undefined)))) invalid(`work[${index}].turns[${turnOffset}].attempt cancellation authority`);
            if ((attempt.status === "reserved" || attempt.status === "backoff") && (attempt.runFingerprint !== undefined || attempt.runStatus !== undefined || attempt.startedAt !== undefined || attempt.finishedAt !== undefined || attempt.failure !== undefined || attempt.terminalObservation !== undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt reservation authority`);
            if (terminalAttempt !== (attempt.finishedAt !== undefined && attempt.terminalObservation !== undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt terminal authority`);
            if (attempt.status === "succeeded" && (attempt.runStatus !== "waiting_review" || !attempt.threadId || !attempt.sessionId || !attempt.turnId || attempt.failure !== undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt success authority`);
            if (attempt.status === "failed" && (!["failed", "waiting_review", "completed"].includes(String(attempt.runStatus)) || attempt.failure === undefined)) invalid(`work[${index}].turns[${turnOffset}].attempt failure authority`);
            if (attempt.status === "canceled" && attempt.runStatus !== "canceled") invalid(`work[${index}].turns[${turnOffset}].attempt cancellation authority`);
            if (attemptOffset === 0) {
              if (attempt.scheduledAt !== turn.reservedAt || attempt.notBefore !== turn.reservedAt) invalid(`work[${index}].turns[${turnOffset}].initial attempt timing`);
            } else {
              const prior = turn.attempts[attemptOffset - 1];
              if (!record(prior) || prior.status !== "failed" || !record(prior.failure) || prior.failure.retryable !== true || typeof prior.finishedAt !== "string" || !record(prior.startObservation) || !record(prior.terminalObservation)) invalid(`work[${index}].turns[${turnOffset}].attempt retry predecessor`);
              const retryOrdinal = turns.slice(0, turnOffset).reduce((sum: number, priorTurn: unknown) => sum + (record(priorTurn) && Array.isArray(priorTurn.attempts) ? Math.max(0, priorTurn.attempts.length - 1) : 0), 0) + attemptOffset;
              const expectedNotBefore = new Date(Date.parse(prior.finishedAt as string) + ([1000, 5000][retryOrdinal - 1] ?? -1)).toISOString();
              const start = prior.startObservation as Record<string, unknown>; const terminalObservation = prior.terminalObservation as Record<string, unknown>;
              const unchanged = ["headSha", "statusSha256", "diffStatSha256", "diffSha256", "dirty", "changedPathsSha256", "changedPathCount"].every((field) => JSON.stringify(start[field]) === JSON.stringify(terminalObservation[field]));
              if (attempt.scheduledAt !== prior.finishedAt || attempt.notBefore !== expectedNotBefore || !unchanged) invalid(`work[${index}].turns[${turnOffset}].attempt retry fence`);
              if (attempt.executorEpoch !== undefined && (attempt.executorEpoch !== prior.executorEpoch || attempt.executorLeaseId !== prior.executorLeaseId || typeof prior.taskRevision !== "number" || (attempt.taskRevision as number) <= prior.taskRevision)) invalid(`work[${index}].turns[${turnOffset}].attempt lease continuity`);
            }
            if (attemptOffset < turn.attempts.length - 1 && attempt.status !== "failed") invalid(`work[${index}].turns[${turnOffset}].attempt monotonicity`);
          }
          const tailAttempt = turn.attempts.at(-1);
          if (!record(tailAttempt) || operationId !== tailAttempt.operationId || turn.taskRevision !== tailAttempt.taskRevision || turn.executorEpoch !== tailAttempt.executorEpoch || turn.executorLeaseId !== tailAttempt.executorLeaseId || turn.runFingerprint !== tailAttempt.runFingerprint || turn.runStatus !== tailAttempt.runStatus) invalid(`work[${index}].turns[${turnOffset}].attempt tail binding`);
          const expectedTurnStatus = tailAttempt.status === "succeeded" ? "succeeded" : tailAttempt.status === "failed" ? "failed" : tailAttempt.status === "canceled" ? "canceled" : tailAttempt.status === "running" ? "running" : "reserved";
          if (turn.status !== expectedTurnStatus) invalid(`work[${index}].turns[${turnOffset}].attempt turn status`);
          const firstAttempt = turn.attempts[0] as Record<string, unknown>;
          if (record(firstAttempt.startObservation)) {
            const expectedStart = turnIndex === 1 ? undefined : (turns[turnOffset - 1] as Record<string, unknown> | undefined)?.terminalObservation;
            const start = firstAttempt.startObservation as Record<string, unknown>;
            if (record(expectedStart)) {
              if (!["headSha", "statusSha256", "diffStatSha256", "diffSha256", "dirty", "changedPathsSha256", "changedPathCount"].every((field) => JSON.stringify(start[field]) === JSON.stringify(expectedStart[field]))) invalid(`work[${index}].turns[${turnOffset}].attempt baseline`);
            } else if (turnIndex === 1 && (start.headSha !== turn.baseSha || start.status !== "" || start.diffStat !== "" || start.statusSha256 !== createHash("sha256").update("").digest("hex") || start.diffStatSha256 !== createHash("sha256").update("").digest("hex") || start.diffSha256 !== createHash("sha256").update("").digest("hex") || start.changedPathsSha256 !== createHash("sha256").update("[]").digest("hex") || start.changedPathCount !== 0 || start.dirty !== false || !Array.isArray(start.changedPaths) || start.changedPaths.length !== 0)) invalid(`work[${index}].turns[${turnOffset}].attempt baseline`);
          }
          if (["succeeded", "failed"].includes(String(turn.status)) && !record(firstAttempt.startObservation)) invalid(`work[${index}].turns[${turnOffset}].attempt baseline required`);
        } else if (operationId !== `goal:${goalId.slice(5)}:${item.workId}:run:${turnIndex}`) {
          invalid(`work[${index}].turns[${turnOffset}].operationId deterministic identity`);
        }
        if (value.retryPolicy !== undefined && turn.attempts === undefined) invalid(`work[${index}].turns[${turnOffset}].attempts required`);
        if (seenOperations.has(operationId)) invalid(`work[${index}].turns[${turnOffset}].operationId deterministic identity`);
        seenOperations.add(operationId);
        timestamp(turn.reservedAt, `work[${index}].turns[${turnOffset}].reservedAt`);
        timestamp(turn.startedAt, `work[${index}].turns[${turnOffset}].startedAt`, true);
        timestamp(turn.finishedAt, `work[${index}].turns[${turnOffset}].finishedAt`, true);
        const terminal = ["succeeded", "failed", "canceled"].includes(String(turn.status));
        const terminalAuthority = turn.finishedAt !== undefined && turn.stopReason !== undefined && (turn.runFingerprint !== undefined || turn.status === "canceled") && turn.runStatus !== undefined && turn.resultSha256 !== undefined && turn.terminalObservation !== undefined;
        if (terminal !== terminalAuthority || (turn.status === "succeeded" && (turn.threadId === undefined || turn.sessionId === undefined || turn.turnId === undefined))) invalid(`work[${index}].turns[${turnOffset}].terminal authority`);
        if (["running", "succeeded", "failed"].includes(String(turn.status)) && (turn.taskRevision === undefined || turn.executorEpoch === undefined || turn.executorLeaseId === undefined || turn.runFingerprint === undefined)) invalid(`work[${index}].turns[${turnOffset}].run authority`);
        if (turn.status === "canceled" && ((turn.taskRevision === undefined) !== (turn.executorEpoch === undefined) || (turn.executorEpoch === undefined) !== (turn.executorLeaseId === undefined) || (turn.taskRevision === undefined && turn.runFingerprint !== undefined))) invalid(`work[${index}].turns[${turnOffset}].cancellation authority`);
        if (turn.status === "succeeded" && (turn.runStatus !== "waiting_review" || turn.stopReason !== "terminal_success")) invalid(`work[${index}].turns[${turnOffset}].successful terminal status`);
        if (turn.status === "failed" && turn.stopReason !== "failed") invalid(`work[${index}].turns[${turnOffset}].failed terminal status`);
        if (turn.status === "canceled" && (turn.runStatus !== "canceled" || turn.stopReason !== "canceled")) invalid(`work[${index}].turns[${turnOffset}].canceled terminal status`);
        if (turnIndex > 1) {
          const prior = turns[turnOffset - 1] as Record<string, unknown>;
          if (turn.taskId !== prior.taskId || turn.baseSha !== prior.baseSha) invalid(`work[${index}].turns[${turnOffset}].task continuity`);
          if (turn.executorEpoch !== undefined && (turn.executorEpoch !== prior.executorEpoch || turn.executorLeaseId !== prior.executorLeaseId || (typeof prior.taskRevision === "number" && (turn.taskRevision as number) <= prior.taskRevision))) invalid(`work[${index}].turns[${turnOffset}].task lease continuity`);
          if (turn.status === "succeeded" && (turn.threadId !== prior.threadId || turn.sessionId !== prior.sessionId)) invalid(`work[${index}].turns[${turnOffset}].thread session continuity`);
          if (turn.status === "succeeded" && turns.slice(0, turnOffset).some((entry: unknown) => record(entry) && entry.turnId === turn.turnId)) invalid(`work[${index}].turns[${turnOffset}].turn identity continuity`);
        }
      }
      const retryCount = turns.reduce((sum: number, turn: unknown) => sum + (record(turn) && Array.isArray(turn.attempts) ? Math.max(0, turn.attempts.length - 1) : 0), 0);
      if (retryCount > (value.limits.maxRetriesPerWorker as number)) invalid(`work[${index}].retry budget`);
      if (turns.some((turn: unknown, turnIndex: number) => turnIndex < turns.length - 1 && record(turn) && turn.status !== "succeeded")) invalid(`work[${index}].turns monotonic success`);
      const tail = turns.at(-1) as Record<string, unknown> | undefined;
      if (tail && item.operationId !== tail.operationId) invalid(`work[${index}].operationId turn tail binding`);
      if (item.status === "continuing" && !((tail?.status === "succeeded" && turns.length < (value.limits.maxTurnsPerWorker as number)) || (tail?.status === "reserved" && turns.length > 1 && turns.length <= (value.limits.maxTurnsPerWorker as number)))) invalid(`work[${index}].continuing authority`);
      if (["waiting_review", "integrating", "integrated"].includes(String(item.status)) && (turns.length !== (value.limits.maxTurnsPerWorker as number) || tail?.status !== "succeeded")) invalid(`work[${index}].final turn authority`);
    }
    if (!WORK_STATUSES.has(item.status as GoalWorkStatus)) invalid(`work[${index}].status`);
    if (item.launch !== undefined) {
      if (!record(item.launch)) invalid(`work[${index}].launch`);
      stringField(item.launch.launchKey, `work[${index}].launch.launchKey`, 160);
      stringField(item.launch.taskKey, `work[${index}].launch.taskKey`, 160);
      if (typeof item.launch.taskId !== "string" || !/^task_[a-f0-9]{24}$/.test(item.launch.taskId)) invalid(`work[${index}].launch.taskId`);
      integer(item.launch.schedulerEpoch, `work[${index}].launch.schedulerEpoch`, 1, Number.MAX_SAFE_INTEGER);
      stringField(item.launch.schedulerLeaseId, `work[${index}].launch.schedulerLeaseId`, 160);
      stringField(item.launch.operationId, `work[${index}].launch.operationId`, 160);
      if (typeof item.launch.baseSha !== "string" || !FULL_SHA.test(item.launch.baseSha)) invalid(`work[${index}].launch.baseSha`);
      timestamp(item.launch.reservedAt, `work[${index}].launch.reservedAt`);
      if (value.executionPolicy !== "persistent") invalid(`work[${index}].launch executionPolicy`);
      if (!["launching", "running", "continuing", "waiting_review", "integrating", "integrated", "failed", "canceled"].includes(String(item.status))) invalid(`work[${index}].launch status`);
      if (item.operationId !== undefined && item.turns === undefined && item.operationId !== item.launch.operationId) invalid(`work[${index}].launch operation binding`);
      if (item.baseSha !== undefined && item.baseSha !== item.launch.baseSha) invalid(`work[${index}].launch base binding`);
      if (item.codingTaskId !== undefined && item.codingTaskId !== item.launch.taskId) invalid(`work[${index}].launch task binding`);
      const expectedTaskKey = `goal:${goalId}:${item.workId}`;
      const expectedTaskId = `task_${createHash("sha256").update(`${value.sourceGitCommonDir}\0${expectedTaskKey}`).digest("hex").slice(0, 24)}`;
      const expectedInitialOperation = Array.isArray(item.turns) && record(item.turns[0]) && Array.isArray(item.turns[0].attempts)
        ? `goal:${goalId.slice(5)}:${item.workId}:turn:1:attempt:0`
        : `goal:${goalId.slice(5)}:${item.workId}:run:1`;
      if (item.launch.launchKey !== `goal:${goalId}:${item.workId}:launch:1` || item.launch.taskKey !== expectedTaskKey || item.launch.taskId !== expectedTaskId || item.launch.operationId !== expectedInitialOperation) invalid(`work[${index}].launch deterministic identity`);
      if (record(value.scheduler) && (item.launch.schedulerEpoch as number) > (value.scheduler.epoch as number)) invalid(`work[${index}].launch future epoch`);
    }
    if (item.baseSha !== undefined && (typeof item.baseSha !== "string" || !FULL_SHA.test(item.baseSha))) invalid(`work[${index}].baseSha`);
    if (item.codingTaskId !== undefined && (typeof item.codingTaskId !== "string" || !/^task_[a-f0-9]{24}$/.test(item.codingTaskId))) invalid(`work[${index}].codingTaskId`);
    stringField(item.operationId, `work[${index}].operationId`, 160, true);
    if (item.reviewDiffSha256 !== undefined && (typeof item.reviewDiffSha256 !== "string" || !HASH.test(item.reviewDiffSha256))) invalid(`work[${index}].reviewDiffSha256`);
    stringField(item.integrationKey, `work[${index}].integrationKey`, 160, true);
    if (item.integratedCommitSha !== undefined && (typeof item.integratedCommitSha !== "string" || !FULL_SHA.test(item.integratedCommitSha))) invalid(`work[${index}].integratedCommitSha`);
    stringField(item.summary, `work[${index}].summary`, 20_000, true);
    stringField(item.error, `work[${index}].error`, 20_000, true);
    timestamp(item.startedAt, `work[${index}].startedAt`, true);
    timestamp(item.finishedAt, `work[${index}].finishedAt`, true);
    if (value.executionPolicy === "persistent" && ["launching", "running", "continuing", "waiting_review", "integrating", "integrated"].includes(String(item.status)) && item.launch === undefined) invalid(`work[${index}].launch required`);
    if (value.retryPolicy !== undefined && ["launching", "running", "continuing", "waiting_review", "integrating", "integrated"].includes(String(item.status)) && !Array.isArray(item.turns)) invalid(`work[${index}].turn ledger required`);
  }
  if (value.lifecycle === "canceling" && value.cancelRequest === undefined) invalid("canceling request");
  if (value.lifecycle === "canceled" && value.retryPolicy !== undefined && value.work.some((item: unknown) => record(item) && item.status !== "integrated" && Array.isArray(item.turns) && record(item.turns.at(-1)) && item.turns.at(-1).status !== "canceled")) invalid("canceled work turn authority");
  if (value.executionPolicy === "persistent" && value.startKey !== undefined && value.scheduler === undefined) invalid("persistent scheduler authority");
  assertGoalDag(value.work as GoalWorkItem[]);
  if (!Array.isArray(value.blackboard) || value.blackboard.length > 500) invalid("blackboard");
  for (const [index, item] of value.blackboard.entries()) {
    if (!record(item)) invalid(`blackboard[${index}]`);
    if (typeof item.recordId !== "string" || !/^bb_[a-f0-9]{24}$/.test(item.recordId)) invalid(`blackboard[${index}].recordId`);
    stringField(item.recordKey, `blackboard[${index}].recordKey`, 160);
    if (typeof item.fingerprint !== "string" || !HASH.test(item.fingerprint)) invalid(`blackboard[${index}].fingerprint`);
    if (!BLACKBOARD_KINDS.has(item.kind as GoalBlackboardKind)) invalid(`blackboard[${index}].kind`);
    const author = stringField(item.author, `blackboard[${index}].author`, 100)!;
    if (author !== "pro" && !author.startsWith("worker:")) invalid(`blackboard[${index}].author`);
    stringField(item.workId, `blackboard[${index}].workId`, 80, true);
    stringField(item.summary, `blackboard[${index}].summary`, 4_000);
    stringArray(item.evidence, `blackboard[${index}].evidence`, 50, 2_000);
    stringArray(item.paths, `blackboard[${index}].paths`, 100, 1_000);
    timestamp(item.createdAt, `blackboard[${index}].createdAt`);
  }
  if (!Array.isArray(value.events) || value.events.length > 500) invalid("events");
  for (const [index, event] of value.events.entries()) {
    if (!record(event)) invalid(`events[${index}]`);
    timestamp(event.at, `events[${index}].at`);
    if (!EVENT_KINDS.has(event.kind as GoalEventKind)) invalid(`events[${index}].kind`);
    stringField(event.message, `events[${index}].message`, 2_000, true);
    stringField(event.workId, `events[${index}].workId`, 80, true);
  }
  timestamp(value.createdAt, "createdAt");
  timestamp(value.updatedAt, "updatedAt");
  timestamp(value.startedAt, "startedAt", true);
  timestamp(value.finishedAt, "finishedAt", true);
  stringField(value.error, "error", 20_000, true);
  if (value.completion !== undefined) {
    if (!record(value.completion)) invalid("completion");
    stringField(value.completion.completionKey, "completion.completionKey", 160);
    stringField(value.completion.summary, "completion.summary", 20_000);
    for (const [name, results] of [["criteria", value.completion.criteria], ["verification", value.completion.verification]] as const) {
      if (!Array.isArray(results) || results.length > 100) invalid(`completion.${name}`);
      for (const [index, result] of results.entries()) {
        if (!record(result)) invalid(`completion.${name}[${index}]`);
        stringField(result.requirement, `completion.${name}[${index}].requirement`, 2_000);
        if (!["passed", "failed", "skipped"].includes(String(result.status))) invalid(`completion.${name}[${index}].status`);
        stringField(result.evidence, `completion.${name}[${index}].evidence`, 4_000);
      }
    }
    timestamp(value.completion.completedAt, "completion.completedAt");
    if (value.completion.reviewFingerprint !== undefined && (typeof value.completion.reviewFingerprint !== "string" || !HASH.test(value.completion.reviewFingerprint))) invalid("completion.reviewFingerprint");
  }
  if (value.sourceApplication !== undefined) {
    if (!record(value.sourceApplication)) invalid("sourceApplication");
    stringField(value.sourceApplication.applicationKey, "sourceApplication.applicationKey", 160);
    if (!["applying", "applied", "failed"].includes(String(value.sourceApplication.status))) invalid("sourceApplication.status");
    if (typeof value.sourceApplication.patchSha256 !== "string" || !HASH.test(value.sourceApplication.patchSha256)) invalid("sourceApplication.patchSha256");
    if (typeof value.sourceApplication.sourceHeadSha !== "string" || !FULL_SHA.test(value.sourceApplication.sourceHeadSha)) invalid("sourceApplication.sourceHeadSha");
    stringArray(value.sourceApplication.sourceDirtyPathsBefore, "sourceApplication.sourceDirtyPathsBefore", 5_000, 4_096);
    if (value.sourceApplication.sourceDirtyPathsAfter !== undefined) stringArray(value.sourceApplication.sourceDirtyPathsAfter, "sourceApplication.sourceDirtyPathsAfter", 5_000, 4_096);
    timestamp(value.sourceApplication.startedAt, "sourceApplication.startedAt");
    timestamp(value.sourceApplication.appliedAt, "sourceApplication.appliedAt", true);
    stringField(value.sourceApplication.error, "sourceApplication.error", 20_000, true);
    if (value.sourceApplication.zeroWrite !== undefined && typeof value.sourceApplication.zeroWrite !== "boolean") invalid("sourceApplication.zeroWrite");
    stringField(value.sourceApplication.adoptedProjectionId, "sourceApplication.adoptedProjectionId", 80, true);
    if (value.sourceApplication.reviewFingerprint !== undefined && (typeof value.sourceApplication.reviewFingerprint !== "string" || !HASH.test(value.sourceApplication.reviewFingerprint))) invalid("sourceApplication.reviewFingerprint");
  }
  if (value.live !== undefined) {
    if (!record(value.live)) invalid("live");
    if (typeof value.live.projectedIntegrationSha !== "string" || !FULL_SHA.test(value.live.projectedIntegrationSha)) invalid("live.projectedIntegrationSha");
    stringField(value.live.pendingProjectionId, "live.pendingProjectionId", 80, true);
    if (!Array.isArray(value.live.projections) || value.live.projections.length > 500) invalid("live.projections");
    const projectionIds = new Set<string>();
    for (const [index, projection] of value.live.projections.entries()) {
      if (!record(projection)) invalid(`live.projections[${index}]`);
      const id = stringField(projection.projectionId, `live.projections[${index}].projectionId`, 80)!;
      if (!/^proj_[a-f0-9]{24}$/.test(id) || projectionIds.has(id)) invalid(`live.projections[${index}].projectionId`);
      projectionIds.add(id);
      stringField(projection.projectionKey, `live.projections[${index}].projectionKey`, 160);
      for (const name of ["fingerprint", "reviewFingerprint", "deltaPatchSha256", "cumulativePatchSha256", "beforeManifestSha256", "afterManifestSha256"] as const) {
        if (typeof projection[name] !== "string" || !HASH.test(projection[name] as string)) invalid(`live.projections[${index}].${name}`);
      }
      for (const name of ["fromIntegrationSha", "toIntegrationSha", "sourceHeadSha"] as const) {
        if (typeof projection[name] !== "string" || !FULL_SHA.test(projection[name] as string)) invalid(`live.projections[${index}].${name}`);
      }
      if (!["prepared", "applying", "applied", "reverting", "reverted", "recovery_required", "adopted"].includes(String(projection.status))) invalid(`live.projections[${index}].status`);
      stringArray(projection.changedPaths, `live.projections[${index}].changedPaths`, 5_000, 4_096);
      stringField(projection.journalRelativePath, `live.projections[${index}].journalRelativePath`, 1_000);
      stringArray(projection.sourceDirtyPathsBefore, `live.projections[${index}].sourceDirtyPathsBefore`, 5_000, 4_096);
      if (projection.sourceDirtyPathsAfter !== undefined) stringArray(projection.sourceDirtyPathsAfter, `live.projections[${index}].sourceDirtyPathsAfter`, 5_000, 4_096);
      timestamp(projection.preparedAt, `live.projections[${index}].preparedAt`);
      timestamp(projection.appliedAt, `live.projections[${index}].appliedAt`, true);
      stringField(projection.revertKey, `live.projections[${index}].revertKey`, 160, true);
      timestamp(projection.revertedAt, `live.projections[${index}].revertedAt`, true);
      stringField(projection.error, `live.projections[${index}].error`, 20_000, true);
    }
    if (value.live.pendingProjectionId && !projectionIds.has(value.live.pendingProjectionId as string)) invalid("live.pendingProjectionId identity");
    timestamp(value.live.adoptedAt, "live.adoptedAt", true);
    stringField(value.live.adoptedProjectionId, "live.adoptedProjectionId", 80, true);
    if (value.live.adoptedReviewFingerprint !== undefined && (typeof value.live.adoptedReviewFingerprint !== "string" || !HASH.test(value.live.adoptedReviewFingerprint))) invalid("live.adoptedReviewFingerprint");
  }
}

export function parseGoalState(value: unknown, expectedGoalId?: string): GoalState {
  assertGoalState(value, expectedGoalId);
  return value;
}
