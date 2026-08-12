export const GOAL_STATE_VERSION = 1 as const;
export const GOAL_ID_PATTERN = /^goal_[a-f0-9]{24}$/;
export const GOAL_WORK_ID_PATTERN = /^work_[a-z0-9][a-z0-9_-]{0,63}$/;

export type GoalLifecycle = "proposed" | "approved" | "running" | "paused" | "waiting_review" | "completed" | "failed" | "canceled";
export type GoalExecutionPolicy = "supervised" | "persistent";
export type GoalWorkspacePolicy = "live" | "isolated";
export type GoalApprovalStatus = "pending" | "approved" | "rejected";
export type GoalWorkStatus = "planned" | "ready" | "running" | "waiting_review" | "integrating" | "integrated" | "blocked" | "failed" | "canceled";
export type GoalBlackboardKind = "discovery" | "contract" | "file_ownership" | "question" | "answer" | "blocker" | "verification" | "decision";
export type GoalEventKind = "proposed" | "approved" | "approval_rejected" | "started" | "paused" | "resumed" | "canceled" | "work_updated" | "blackboard_published" | "integration_updated" | "projection_updated" | "completed" | "failed";

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
  status: GoalWorkStatus;
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

const LIFECYCLES = new Set<GoalLifecycle>(["proposed", "approved", "running", "paused", "waiting_review", "completed", "failed", "canceled"]);
const WORK_STATUSES = new Set<GoalWorkStatus>(["planned", "ready", "running", "waiting_review", "integrating", "integrated", "blocked", "failed", "canceled"]);
const BLACKBOARD_KINDS = new Set<GoalBlackboardKind>(["discovery", "contract", "file_ownership", "question", "answer", "blocker", "verification", "decision"]);
const EVENT_KINDS = new Set<GoalEventKind>(["proposed", "approved", "approval_rejected", "started", "paused", "resumed", "canceled", "work_updated", "blackboard_published", "integration_updated", "projection_updated", "completed", "failed"]);
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
    if (!WORK_STATUSES.has(item.status as GoalWorkStatus)) invalid(`work[${index}].status`);
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
  }
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
