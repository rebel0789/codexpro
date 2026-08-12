import { createHash } from "node:crypto";
import path from "node:path";
import { inspectCodingTaskSource, type CodingTaskSourceWorkspace, type CodingTaskWorkspaceGuard } from "./codingTaskWorktree.js";
import { GoalStore, type GoalStoreConfig } from "./goalStore.js";
import { verifyGoalLiveProjection } from "./goalProjection.js";
import { assertGoalContentPolicySnapshot } from "./goalPolicy.js";
import { assertGoalPromptContractBudget, assertGoalWorkerPromptBudget, buildGoalWorkerPrompt } from "./goalPrompt.js";
import {
  GOAL_STATE_VERSION,
  assertGoalDag,
  computeGoalContinuationIntentFingerprint,
  parseGoalState,
  validateGoalId,
  validateGoalContinuationIntentId,
  validateGoalWorkId,
  type GoalBlackboardKind,
  type GoalBlackboardRecord,
  type GoalContentPolicySnapshot,
  type GoalExecutionPolicy,
  type GoalEvidenceResult,
  type GoalPermissions,
  type GoalResourceLimits,
  type GoalState,
  type GoalWorkItem,
  type GoalWorkspacePolicy
} from "./goalState.js";

export interface ProposeGoalWorkInput {
  workId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  verification?: string[];
  dependsOn?: string[];
  parallelGroup?: string;
  fileGlobs?: string[];
  continuationIntents?: Array<{ intentId: string; prompt: string }>;
}

export interface ProposeGoalInput {
  goalKey: string;
  title: string;
  goal: string;
  exclusions?: string[];
  completionCriteria: string[];
  verification?: string[];
  executionPolicy: GoalExecutionPolicy;
  workspacePolicy: GoalWorkspacePolicy;
  workerModel: string;
  workerEffort: "low" | "medium" | "high" | "xhigh";
  limits: GoalResourceLimits;
  permissions: GoalPermissions;
  contentPolicy?: GoalContentPolicySnapshot;
  baseSha: string;
  work: ProposeGoalWorkInput[];
}

export interface ApproveGoalInput {
  expectedRevision: number;
  contractFingerprint: string;
  approvalKey: string;
}

export interface PublishGoalBlackboardInput {
  expectedRevision: number;
  recordKey: string;
  kind: GoalBlackboardKind;
  author: "pro" | `worker:${string}`;
  workId?: string;
  summary: string;
  evidence?: string[];
  paths?: string[];
}

export interface GoalCasKeyInput {
  expectedRevision: number;
  requestKey: string;
}

export interface CompleteGoalInput {
  expectedRevision: number;
  completionKey: string;
  summary: string;
  criteria: GoalEvidenceResult[];
  verification: GoalEvidenceResult[];
  reviewFingerprint?: string;
  isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) throw new Error(`${name} must be 1-${max} characters.`);
  return normalized;
}

function texts(values: string[] | undefined, name: string, maxItems: number, maxLength: number): string[] {
  const normalized = (values ?? []).map((value, index) => text(value, `${name}[${index}]`, maxLength));
  if (normalized.length > maxItems) throw new Error(`${name} supports at most ${maxItems} entries.`);
  return normalized;
}

function normalizeWork(items: ProposeGoalWorkInput[]): GoalWorkItem[] {
  if (items.length < 1 || items.length > 50) throw new Error("A Goal requires 1-50 work items.");
  const work = items.map((item): GoalWorkItem => {
    const workId = validateGoalWorkId(item.workId);
    const continuationIntents = (item.continuationIntents ?? []).map((intent, index) => {
      const intentId = validateGoalContinuationIntentId(intent.intentId);
      const prompt = text(intent.prompt, `Goal work ${item.workId} continuation intent ${intentId}`, 65_536);
      return { intentId, prompt, fingerprint: computeGoalContinuationIntentFingerprint(workId, index + 2, intentId, prompt) };
    });
    if (new Set(continuationIntents.map((intent) => intent.intentId)).size !== continuationIntents.length) throw new Error(`Goal work ${workId} continuation intent ids must be unique.`);
    return {
      workId,
      title: text(item.title, `Goal work ${item.workId} title`, 500),
      goal: text(item.goal, `Goal work ${item.workId} goal`, 20_000),
      acceptanceCriteria: texts(item.acceptanceCriteria, `Goal work ${item.workId} acceptance criteria`, 50, 2_000),
      verification: texts(item.verification, `Goal work ${item.workId} verification`, 50, 2_000),
      dependsOn: (item.dependsOn ?? []).map(validateGoalWorkId),
      ...(item.parallelGroup ? { parallelGroup: text(item.parallelGroup, `Goal work ${item.workId} parallel group`, 100) } : {}),
      fileGlobs: texts(item.fileGlobs, `Goal work ${item.workId} file globs`, 100, 1_000),
      ...(continuationIntents.length ? { continuationIntents } : {}),
      status: "planned"
    };
  });
  assertGoalDag(work);
  return work;
}

function normalizeLimits(limits: GoalResourceLimits): GoalResourceLimits {
  const integer = (value: number, name: string, min: number, max: number): number => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const normalized = {
    maxConcurrency: integer(limits.maxConcurrency, "maxConcurrency", 1, 8),
    timeoutMs: integer(limits.timeoutMs, "timeoutMs", 1_000, 86_400_000),
    maxTurnsPerWorker: integer(limits.maxTurnsPerWorker, "maxTurnsPerWorker", 1, 100),
    maxRetriesPerWorker: integer(limits.maxRetriesPerWorker, "maxRetriesPerWorker", 0, 10),
    maxLogBytes: integer(limits.maxLogBytes, "maxLogBytes", 65_536, 104_857_600)
  };
  if (normalized.maxRetriesPerWorker !== 0) throw new Error("Goal execution does not support automatic retries.");
  return normalized;
}

function normalizePermissions(permissions: GoalPermissions): GoalPermissions {
  const sourceEffects = permissions.sourceEffects;
  if (!sourceEffects || [sourceEffects.apply, sourceEffects.commit, sourceEffects.push, sourceEffects.draftPr].some((value) => typeof value !== "boolean")) {
    throw new Error("Goal source effects must explicitly set apply, commit, push, and draftPr.");
  }
  if (permissions.network) throw new Error("Goal worker network access is not supported by this local MVP; set network=false.");
  if (sourceEffects.commit || sourceEffects.push || sourceEffects.draftPr) {
    throw new Error("Goal commit, push, and draft-PR effects are not implemented; keep those permissions false.");
  }
  return {
    fileGlobs: texts(permissions.fileGlobs, "Goal file globs", 200, 1_000),
    commands: texts(permissions.commands, "Goal commands", 100, 1_000),
    network: false,
    sourceEffects: { ...sourceEffects }
  };
}

function contractShape(state: Pick<GoalState, "version" | "goalId" | "goalKey" | "title" | "goal" | "exclusions" | "completionCriteria" | "verification" | "executionPolicy" | "workspacePolicy" | "workerModel" | "workerEffort" | "limits" | "permissions" | "sourceRoot" | "sourceGitCommonDir" | "baseSha" | "sourceDirtyAtCreation" | "sourceStatusEntryCountAtCreation" | "sourceUncommittedChangesIncluded" | "integrationWorktreeRoot" | "work"> & Partial<Pick<GoalState, "contentPolicy" | "live">>) {
  return {
    version: state.version, goalId: state.goalId, goalKey: state.goalKey, title: state.title, goal: state.goal,
    exclusions: state.exclusions, completionCriteria: state.completionCriteria, verification: state.verification,
    executionPolicy: state.executionPolicy, workspacePolicy: state.workspacePolicy, workerModel: state.workerModel,
    workerEffort: state.workerEffort, limits: state.limits, permissions: state.permissions,
    ...(state.contentPolicy ? { contentPolicy: state.contentPolicy } : {}),
    sourceRoot: state.sourceRoot, sourceGitCommonDir: state.sourceGitCommonDir, baseSha: state.baseSha,
    sourceDirtyAtCreation: state.sourceDirtyAtCreation, sourceStatusEntryCountAtCreation: state.sourceStatusEntryCountAtCreation,
    sourceUncommittedChangesIncluded: state.sourceUncommittedChangesIncluded,
    integrationWorktreeRoot: state.integrationWorktreeRoot,
    work: state.work.map((item) => ({
      workId: item.workId, title: item.title, goal: item.goal, acceptanceCriteria: item.acceptanceCriteria,
      verification: item.verification, dependsOn: item.dependsOn,
      ...(item.parallelGroup ? { parallelGroup: item.parallelGroup } : {}), fileGlobs: item.fileGlobs,
      ...(item.continuationIntents ? { continuationIntents: item.continuationIntents } : {}), status: "planned" as const
    })),
    ...(state.workspacePolicy === "live" ? { live: { projectedIntegrationSha: state.baseSha, projections: [] } } : {})
  };
}

export function computeGoalContractFingerprint(state: Parameters<typeof contractShape>[0]): string {
  const prefix = state.executionPolicy === "persistent" ? "codexpro-goal-persistent-contract-v1" : "codexpro-goal-contract-v1";
  return sha256(`${prefix}\0${JSON.stringify(contractShape(state))}`);
}

export function assertGoalContractIntegrity(state: GoalState): void {
  const computed = computeGoalContractFingerprint(state);
  if (computed !== state.contractFingerprint || state.approval.contractFingerprint !== computed) throw new Error("Goal persisted contract fingerprint no longer matches its immutable approved fields.");
  if (state.approval.status !== "approved") throw new Error("Goal scheduler requires an approved persisted contract.");
}

export async function proposeGoal(
  config: GoalStoreConfig,
  workspace: CodingTaskSourceWorkspace,
  guard: CodingTaskWorkspaceGuard | undefined,
  input: ProposeGoalInput
): Promise<{ goal: GoalState; reused: boolean }> {
  if (process.platform === "win32") throw new Error("Goal orchestration requires POSIX advisory locking and is not supported on Windows by this release.");
  if (input.executionPolicy === "persistent") {
    if (input.workspacePolicy !== "isolated") throw new Error("Persistent Goal execution requires an isolated integration worktree.");
  } else if (!["isolated", "live"].includes(input.workspacePolicy)) throw new Error("Goal execution requires an isolated or Live integration worktree.");
  const store = new GoalStore(config);
  await store.initialize();
  const goalKey = text(input.goalKey, "Goal key", 160);
  const title = text(input.title, "Goal title", 500);
  const goalText = text(input.goal, "Goal", 20_000);
  const identity = await inspectCodingTaskSource(workspace, input.baseSha, guard);
  const goalId = `goal_${sha256(`${identity.commonDir}\0${goalKey}`).slice(0, 24)}`;
  const work = normalizeWork(input.work);
  const limits = normalizeLimits(input.limits);
  const permissions = normalizePermissions(input.permissions);
  const contentPolicy = input.contentPolicy ? assertGoalContentPolicySnapshot(input.contentPolicy) : undefined;
  if (input.executionPolicy === "persistent") {
    if (!contentPolicy) throw new Error("Persistent Goal approval requires a fingerprinted blocked-glob content-policy snapshot.");
    if (permissions.commands.length || Object.values(permissions.sourceEffects).some(Boolean)) {
      throw new Error("Persistent Goal execution requires empty commands and all sourceEffects=false.");
    }
    if (limits.maxTurnsPerWorker > 4 || work.some((item) => (item.continuationIntents?.length ?? 0) !== limits.maxTurnsPerWorker - 1)) {
      throw new Error("Persistent Goal maxTurnsPerWorker must be 1-4 and equal one initial turn plus every work item's approved continuation intents.");
    }
  } else if (limits.maxTurnsPerWorker !== 1 || work.some((item) => item.continuationIntents?.length)) {
    throw new Error("Supervised Goal execution remains a one-turn contract without persistent continuation intents.");
  }
  if (input.workspacePolicy === "live" && !permissions.sourceEffects.apply) {
    throw new Error("A supervised Live Goal requires the existing sourceEffects.apply permission.");
  }
  const immutable = {
    version: GOAL_STATE_VERSION,
    goalId,
    goalKey,
    title,
    goal: goalText,
    exclusions: texts(input.exclusions, "Goal exclusions", 100, 2_000),
    completionCriteria: texts(input.completionCriteria, "Goal completion criteria", 100, 2_000),
    verification: texts(input.verification, "Goal verification", 100, 2_000),
    executionPolicy: input.executionPolicy,
    workspacePolicy: input.workspacePolicy,
    workerModel: text(input.workerModel, "Goal worker model", 160),
    workerEffort: input.workerEffort,
    limits,
    permissions,
    ...(contentPolicy ? { contentPolicy } : {}),
    sourceRoot: identity.sourceRoot,
    sourceGitCommonDir: identity.commonDir,
    baseSha: identity.baseSha,
    sourceDirtyAtCreation: identity.sourceDirty,
    sourceStatusEntryCountAtCreation: identity.sourceStatusEntryCount,
    sourceUncommittedChangesIncluded: false as const,
    integrationWorktreeRoot: store.paths(goalId).integrationWorktreeRoot,
    work,
    ...(input.workspacePolicy === "live" ? { live: { projectedIntegrationSha: identity.baseSha, projections: [] } } : {})
  };
  const promptContract = immutable.work.map((item) => ({ initialPrompt: buildGoalWorkerPrompt(immutable as GoalState, item), continuationIntents: item.continuationIntents ?? [] }));
  for (const entry of promptContract) assertGoalWorkerPromptBudget(entry.initialPrompt, entry.continuationIntents);
  assertGoalPromptContractBudget(promptContract);
  if (!path.isAbsolute(immutable.integrationWorktreeRoot)) throw new Error("Goal integration worktree path must be absolute.");
  const contractFingerprint = computeGoalContractFingerprint(immutable);
  const createFingerprint = sha256(`codexpro-goal-create-v1\0${goalKey}\0${contractFingerprint}`);
  return store.withGoalLock(goalId, async () => {
    const existing = await store.getIfExists(goalId);
    if (existing) {
      if (existing.createFingerprint !== createFingerprint) throw new Error(`Goal key is already bound to a different contract: ${goalKey}`);
      return { goal: existing, reused: true };
    }
    const now = new Date().toISOString();
    const state: GoalState = {
      ...immutable,
      createFingerprint,
      contractFingerprint,
      lifecycle: "proposed",
      approval: { status: "pending", contractFingerprint },
      revision: 1,
      blackboard: [],
      events: [{ at: now, kind: "proposed", message: "Goal contract proposed; no execution has started." }],
      createdAt: now,
      updatedAt: now
    };
    parseGoalState(state, goalId);
    await store.writeLocked(state);
    return { goal: state, reused: false };
  });
}

export async function getGoal(config: GoalStoreConfig, goalId: string): Promise<GoalState> {
  return new GoalStore(config).get(validateGoalId(goalId));
}

export async function listGoals(config: GoalStoreConfig, options: { sourceRoot?: string; limit?: number } = {}): Promise<GoalState[]> {
  return new GoalStore(config).list(options);
}

export async function approveGoal(config: GoalStoreConfig, goalIdInput: string, input: ApproveGoalInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const approvalKey = text(input.approvalKey, "Goal approval key", 160);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.approval.approvalKey === approvalKey) {
      if (state.approval.contractFingerprint !== input.contractFingerprint || state.approval.status !== "approved") {
        throw new Error("Goal approval key is already bound to a different approval decision.");
      }
      return state;
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (state.lifecycle !== "proposed" || state.approval.status !== "pending") throw new Error("Only a pending proposed Goal can be approved.");
    if (input.contractFingerprint !== state.contractFingerprint) throw new Error("Goal contract fingerprint changed; inspect the authoritative Goal before approval.");
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      lifecycle: "approved",
      approval: { status: "approved", contractFingerprint: state.contractFingerprint, approvalKey, approvedAt: now },
      revision: state.revision + 1,
      updatedAt: now,
      events: [...state.events, { at: now, kind: "approved" as const, message: "The exact persisted Goal contract was approved." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

export async function publishGoalBlackboard(
  config: GoalStoreConfig,
  goalIdInput: string,
  input: PublishGoalBlackboardInput
): Promise<{ goal: GoalState; record: GoalBlackboardRecord; reused: boolean }> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const recordKey = text(input.recordKey, "Blackboard record key", 160);
  const summary = text(input.summary, "Blackboard summary", 4_000);
  const evidence = texts(input.evidence, "Blackboard evidence", 50, 2_000);
  const paths = texts(input.paths, "Blackboard paths", 100, 1_000);
  const workId = input.workId ? validateGoalWorkId(input.workId) : undefined;
  const fingerprint = sha256(JSON.stringify({ goalId, recordKey, kind: input.kind, author: input.author, workId, summary, evidence, paths }));
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    const existing = state.blackboard.find((record) => record.recordKey === recordKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Blackboard record key is already bound to different content.");
      return { goal: state, record: existing, reused: true };
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (["completed", "failed", "canceled"].includes(state.lifecycle)) throw new Error("Terminal Goals do not accept new Blackboard records.");
    const workItem = workId ? state.work.find((item) => item.workId === workId) : undefined;
    if (workId && !workItem) throw new Error(`Unknown Goal work item: ${workId}`);
    if (input.author !== "pro") {
      const authorWorkId = validateGoalWorkId(input.author.slice("worker:".length));
      if (!workItem || authorWorkId !== workId) throw new Error("Worker Blackboard records must be scoped to the same assigned work item.");
      if (input.kind === "decision") throw new Error("Only Pro may publish Goal decisions.");
    }
    const now = new Date().toISOString();
    const record: GoalBlackboardRecord = {
      recordId: `bb_${sha256(`${goalId}\0${recordKey}`).slice(0, 24)}`,
      recordKey,
      fingerprint,
      kind: input.kind,
      author: input.author,
      ...(workId ? { workId } : {}),
      summary,
      evidence,
      paths,
      createdAt: now
    };
    const next: GoalState = {
      ...state,
      revision: state.revision + 1,
      updatedAt: now,
      blackboard: [...state.blackboard, record].slice(-500),
      events: [...state.events, { at: now, kind: "blackboard_published" as const, workId, message: `${input.kind} published by ${input.author}.` }].slice(-500)
    };
    await store.writeLocked(next);
    return { goal: next, record, reused: false };
  });
}

function normalizeEvidence(results: GoalEvidenceResult[], name: string): GoalEvidenceResult[] {
  if (!Array.isArray(results) || results.length > 100) throw new Error(`${name} supports at most 100 results.`);
  return results.map((result, index) => {
    if (!result || !["passed", "failed", "skipped"].includes(result.status)) throw new Error(`${name}[${index}] has an invalid status.`);
    return {
      requirement: text(result.requirement, `${name}[${index}].requirement`, 2_000),
      status: result.status,
      evidence: text(result.evidence, `${name}[${index}].evidence`, 4_000)
    };
  });
}

export async function pauseGoal(config: GoalStoreConfig, goalIdInput: string, input: GoalCasKeyInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const requestKey = text(input.requestKey, "Goal pause key", 160);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.pauseKey === requestKey && state.lifecycle === "paused") return state;
    if (state.executionPolicy === "persistent" && state.lifecycle === "waiting_review") throw new Error("Persistent Goal scheduling has already stopped for Pro semantic review and cannot be paused.");
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (!["running", "waiting_review"].includes(state.lifecycle)) throw new Error("Only a running or review-waiting Goal can pause scheduling.");
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      lifecycle: "paused",
      pauseKey: requestKey,
      revision: state.revision + 1,
      updatedAt: now,
      events: [...state.events, { at: now, kind: "paused" as const, message: "Goal scheduling paused; already-running workers continue under their approved leases." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

export async function resumeGoal(config: GoalStoreConfig, goalIdInput: string, input: GoalCasKeyInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const requestKey = text(input.requestKey, "Goal resume key", 160);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.executionPolicy === "persistent") throw new Error("Persistent Goals resume only through resumePersistentGoal, which explicitly wakes the detached scheduler.");
    if (state.resumeKey === requestKey && state.lifecycle !== "paused") return state;
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (state.lifecycle !== "paused") throw new Error("Only a paused Goal can resume scheduling.");
    const now = new Date().toISOString();
    const waitingOnly = !state.work.some((item) => ["ready", "running", "integrating"].includes(item.status)) && state.work.some((item) => item.status === "waiting_review");
    const next: GoalState = {
      ...state,
      lifecycle: waitingOnly ? "waiting_review" : "running",
      resumeKey: requestKey,
      revision: state.revision + 1,
      updatedAt: now,
      events: [...state.events, { at: now, kind: "resumed" as const, message: "Goal scheduling resumed within the approved contract." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

export async function markGoalCanceled(config: GoalStoreConfig, goalIdInput: string, input: GoalCasKeyInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const requestKey = text(input.requestKey, "Goal cancel key", 160);
  return store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    if (state.executionPolicy === "persistent") throw new Error("Persistent Goals require durable canceling and authoritative child drain before terminal cancellation.");
    if (state.cancelKey === requestKey && state.lifecycle === "canceled") return state;
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (["completed", "failed", "canceled"].includes(state.lifecycle)) throw new Error("Goal is already terminal.");
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      lifecycle: "canceled",
      cancelKey: requestKey,
      revision: state.revision + 1,
      updatedAt: now,
      finishedAt: now,
      work: state.work.map((item) => item.status === "integrated" ? item : { ...item, status: "canceled", finishedAt: item.finishedAt ?? now }),
      events: [...state.events, { at: now, kind: "canceled" as const, message: "Goal cancellation was durably requested for all active workers." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
}

export async function completeGoal(config: GoalStoreConfig & { maxOutputBytes?: number }, goalIdInput: string, input: CompleteGoalInput): Promise<GoalState> {
  const store = new GoalStore(config);
  const goalId = validateGoalId(goalIdInput);
  const completionKey = text(input.completionKey, "Goal completion key", 160);
  const summary = text(input.summary, "Goal completion summary", 20_000);
  const criteria = normalizeEvidence(input.criteria, "Goal criteria evidence");
  const verification = normalizeEvidence(input.verification, "Goal verification evidence");
  const completeLocked = async (): Promise<GoalState> => store.withGoalLock(goalId, async () => {
    const state = await store.get(goalId);
    const requestedReviewFingerprint = state.workspacePolicy === "live" ? input.reviewFingerprint?.trim().toLowerCase() : undefined;
    if (state.completion?.completionKey === completionKey) {
      if (state.completion.summary !== summary || JSON.stringify(state.completion.criteria) !== JSON.stringify(criteria) || JSON.stringify(state.completion.verification) !== JSON.stringify(verification) || state.completion.reviewFingerprint !== requestedReviewFingerprint) {
        throw new Error("Goal completion key is already bound to different evidence.");
      }
      return state;
    }
    if (state.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${state.revision}.`);
    if (state.lifecycle !== "waiting_review" || !state.work.every((item) => item.status === "integrated")) {
      throw new Error("Goal completion requires every approved work item to be integrated and waiting for final review.");
    }
    if (state.workspacePolicy === "live") {
      if (!state.live || !state.integrationHeadSha || state.live.projectedIntegrationSha !== state.integrationHeadSha || state.live.pendingProjectionId ||
          state.live.projections.some((projection) => ["prepared", "applying", "reverting", "recovery_required"].includes(projection.status))) {
        throw new Error("Live Goal completion requires the exact integration HEAD to be projected with no pending or recovery-required journal.");
      }
      const reviewFingerprint = requestedReviewFingerprint;
      if (!reviewFingerprint || !/^[a-f0-9]{64}$/.test(reviewFingerprint)) throw new Error("Live Goal completion requires the exact authoritative review fingerprint.");
      const verified = await verifyGoalLiveProjection({ ...config, maxOutputBytes: config.maxOutputBytes ?? 4 * 1024 * 1024 }, state, input.isPathContentAllowed);
      if (verified.review.reviewFingerprint !== reviewFingerprint) throw new Error("Live Goal completion review fingerprint no longer matches authoritative projected source readback.");
    }
    if (criteria.length !== state.completionCriteria.length || criteria.some((result, index) => result.requirement !== state.completionCriteria[index])) {
      throw new Error("Goal completion evidence must cover the persisted completion criteria in contract order.");
    }
    if (verification.length !== state.verification.length || verification.some((result, index) => result.requirement !== state.verification[index])) {
      throw new Error("Goal completion evidence must cover the persisted verification requirements in contract order.");
    }
    if (criteria.some((result) => result.status !== "passed") || verification.some((result) => result.status === "failed")) {
      throw new Error("Goal cannot be completed while a criterion failed or a verification requirement failed.");
    }
    const now = new Date().toISOString();
    const next: GoalState = {
      ...state,
      lifecycle: "completed",
      completion: { completionKey, summary, criteria, verification, completedAt: now, ...(requestedReviewFingerprint ? { reviewFingerprint: requestedReviewFingerprint } : {}) },
      revision: state.revision + 1,
      updatedAt: now,
      finishedAt: now,
      events: [...state.events, { at: now, kind: "completed" as const, message: "Pro accepted the integrated result against the persisted criteria." }].slice(-500)
    };
    await store.writeLocked(next);
    return next;
  });
  const initial = await store.get(goalId);
  return initial.workspacePolicy === "live"
    ? store.withSourceLock(initial.sourceRoot, initial.sourceGitCommonDir, completeLocked)
    : completeLocked();
}
