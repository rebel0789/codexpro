import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveGoal, completeGoal, pauseGoal, proposeGoal, resumeGoal } from '../dist/goalOps.js';
import { applyCompletedGoal, cancelGoal, integrateGoalWork, projectGoal, refreshGoal, reviewGoal, revertGoalProjection, startGoal } from '../dist/goalExecution.js';
import { getCodingTask } from '../dist/codingTaskOps.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-execution-')));
try {
  const sourceRoot = path.join(fixture, 'source');
  const dataRoot = path.join(fixture, 'state');
  const fakeCodex = path.join(fixture, 'fake-codex');
  const launches = path.join(fixture, 'launches.log');
  await fs.mkdir(sourceRoot);
  git(sourceRoot, ['init', '-q']);
  git(sourceRoot, ['config', 'user.name', 'Goal Execution Smoke']);
  git(sourceRoot, ['config', 'user.email', 'goal-execution@example.invalid']);
  await fs.mkdir(path.join(sourceRoot, 'src'));
  await fs.writeFile(path.join(sourceRoot, 'src', 'a.txt'), 'base a\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'src', 'b.txt'), 'base b\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'src', 'secure.txt'), 'base secure\n', 'utf8');
  git(sourceRoot, ['add', '--', 'src/a.txt', 'src/b.txt', 'src/secure.txt']);
  git(sourceRoot, ['commit', '-qm', 'base']);
  await fs.chmod(path.join(sourceRoot, 'src', 'secure.txt'), 0o600);
  const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  const sourceStatusBefore = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);

  const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const launches = ${JSON.stringify(launches)};
let slot = 'unknown';
let buffer = '';
const threadId = 'thread-' + process.pid;
const sessionId = 'session-' + process.pid;
const turnId = 'turn-' + process.pid;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function turn(status = 'inProgress') { return { id: turnId, status, error: null, items: status === 'completed' ? [{ type: 'agentMessage', id: 'final', text: 'worker ' + slot + ' complete', phase: 'final_answer' }] : [] }; }
function handle(message) {
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId || threadId, sessionId, ephemeral: false } } });
  if (message.method === 'turn/start') {
    const prompt = message.params.input?.map((item) => item.text || '').join('\\n') || '';
    slot = prompt.includes('work_a') ? 'a' : prompt.includes('work_b') ? 'b' : prompt.includes('work_live_a') ? 'live-a' : prompt.includes('work_live_b') ? 'live-b' : prompt.includes('work_cancel_project') ? 'cancel-project' : prompt.includes('work_oversized') ? 'oversized' : 'unknown';
    fs.appendFileSync(launches, 'start:' + slot + ':' + Date.now() + '\\n');
    fs.writeFileSync(path.join(process.cwd(), 'src', slot + '.txt'), 'worker ' + slot + ' integrated\\n');
    if (prompt.includes('Work item: work_live ')) fs.writeFileSync(path.join(process.cwd(), 'src', 'unknown2.txt'), 'worker unknown2 integrated\\n');
    if (prompt.includes('work_backslash')) { fs.unlinkSync(path.join(process.cwd(), 'src', slot + '.txt')); fs.writeFileSync(path.join(process.cwd(), 'src', 'foo\\\\bar'), 'literal backslash path\\n'); }
    if (prompt.includes('work_secure')) { fs.unlinkSync(path.join(process.cwd(), 'src', slot + '.txt')); fs.writeFileSync(path.join(process.cwd(), 'src', 'secure.txt'), 'modified secure\\n'); }
    send({ id: message.id, result: { turn: turn() } });
    setTimeout(() => {
      fs.appendFileSync(launches, 'finish:' + slot + ':' + Date.now() + '\\n');
      send({ method: 'turn/completed', params: { threadId, turn: turn('completed') } });
    }, 350);
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId, turn: turn('interrupted') } });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;
  await fs.writeFile(fakeCodex, fakeSource, { mode: 0o700 });
  await fs.chmod(fakeCodex, 0o700);

  const storeConfig = { dataRoot };
  const proposed = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'parallel-execution-v1',
    title: 'Parallel Goal execution smoke',
    goal: 'Run two disjoint workers concurrently and integrate them under Pro control.',
    completionCriteria: ['Both worker files are integrated'],
    verification: ['git diff --check'],
    executionPolicy: 'supervised',
    workspacePolicy: 'isolated',
    workerModel: 'gpt-5.6-sol',
    workerEffort: 'high',
    limits: { maxConcurrency: 2, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 },
    permissions: {
      fileGlobs: ['src/**'],
      commands: ['git diff --check'],
      network: false,
      sourceEffects: { apply: true, commit: false, push: false, draftPr: false }
    },
    baseSha,
    work: [
      { workId: 'work_a', title: 'Implement A', goal: 'Modify only src/a.txt.', acceptanceCriteria: ['A is complete'], verification: ['git diff --check'], fileGlobs: ['src/a.txt'] },
      { workId: 'work_b', title: 'Implement B', goal: 'Modify only src/b.txt.', acceptanceCriteria: ['B is complete'], verification: ['git diff --check'], fileGlobs: ['src/b.txt'] }
    ]
  });
  const approved = await approveGoal(storeConfig, proposed.goal.goalId, {
    expectedRevision: proposed.goal.revision,
    contractFingerprint: proposed.goal.contractFingerprint,
    approvalKey: 'approve-parallel-v1'
  });
  const executionConfig = { dataRoot, codexBinary: fakeCodex, codexDir: fixture, maxOutputBytes: 2 * 1024 * 1024 };
  const started = await startGoal(executionConfig, approved.goalId, { expectedRevision: approved.revision, startKey: 'start-parallel-v1' });
  assert.equal(started.runs.length, 2);
  assert.equal(started.goal.work.filter((item) => item.status === 'running').length, 2);
  assert.equal(new Set(started.goal.work.map((item) => item.codingTaskId)).size, 2);
  const paused = await pauseGoal(storeConfig, started.goal.goalId, { expectedRevision: started.goal.revision, requestKey: 'pause-v1' });
  assert.equal(paused.lifecycle, 'paused');
  const resumed = await resumeGoal(storeConfig, paused.goalId, { expectedRevision: paused.revision, requestKey: 'resume-v1' });
  assert.equal(resumed.lifecycle, 'running');
  const launchDeadline = Date.now() + 3_000;
  let startLines = [];
  while (Date.now() < launchDeadline) {
    startLines = await fs.readFile(launches, 'utf8').then((value) => value.trim().split('\n'), () => []);
    if (startLines.filter((line) => line.startsWith('start:')).length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(startLines.filter((line) => line.startsWith('start:')).length, 2);
  assert.equal(startLines.some((line) => line.startsWith('finish:')), false, 'both workers should launch before either finishes');
  for (const work of started.goal.work) {
    const task = await getCodingTask(storeConfig, work.codingTaskId);
    assert.equal(task.goalId, started.goal.goalId);
    assert.equal(task.goalWorkId, work.workId);
  }
  const startRetry = await startGoal(executionConfig, approved.goalId, { expectedRevision: approved.revision, startKey: 'start-parallel-v1' });
  assert.equal(startRetry.runs.length, 0);

  let refreshed = started.goal;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    refreshed = await refreshGoal(executionConfig, started.goal.goalId);
    if (refreshed.work.every((item) => item.status === 'waiting_review')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(refreshed.lifecycle, 'waiting_review');
  assert.equal(refreshed.work.every((item) => item.status === 'waiting_review'), true);

  let integratedA = await integrateGoalWork(executionConfig, refreshed.goalId, {
    expectedRevision: refreshed.revision,
    workId: 'work_a',
    integrationKey: 'integrate-a-v1',
    isPathContentAllowed: () => true
  });
  const goalAStatePath = path.join(dataRoot, 'goals', refreshed.goalId, 'state.json');
  await fs.writeFile(goalAStatePath, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o600 });
  git(integratedA.integrationWorktreeRoot, ['reset', '--soft', refreshed.integrationHeadSha]);
  integratedA = await integrateGoalWork(executionConfig, refreshed.goalId, {
    expectedRevision: refreshed.revision,
    workId: 'work_a',
    integrationKey: 'integrate-a-v1',
    isPathContentAllowed: () => true
  });
  await fs.writeFile(goalAStatePath, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o600 });
  integratedA = await integrateGoalWork(executionConfig, refreshed.goalId, {
    expectedRevision: refreshed.revision,
    workId: 'work_a',
    integrationKey: 'integrate-a-v1',
    isPathContentAllowed: () => true
  });
  const integratedARetry = await integrateGoalWork(executionConfig, refreshed.goalId, {
    expectedRevision: refreshed.revision,
    workId: 'work_a',
    integrationKey: 'integrate-a-v1',
    isPathContentAllowed: () => true
  });
  assert.equal(integratedARetry.work.find((item) => item.workId === 'work_a').integratedCommitSha, integratedA.work.find((item) => item.workId === 'work_a').integratedCommitSha);
  const integratedB = await integrateGoalWork(executionConfig, refreshed.goalId, {
    expectedRevision: integratedA.revision,
    workId: 'work_b',
    integrationKey: 'integrate-b-v1',
    isPathContentAllowed: () => true
  });
  assert.equal(integratedB.work.every((item) => item.status === 'integrated'), true);
  assert.equal(integratedB.lifecycle, 'waiting_review');
  assert.equal(git(integratedB.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '2');
  const reviewed = await reviewGoal(executionConfig, integratedB.goalId, () => true);
  assert.deepEqual(reviewed.review.changedPaths, ['src/a.txt', 'src/b.txt']);
  assert.match(reviewed.review.diff, /worker a integrated/);
  assert.match(reviewed.review.diff, /worker b integrated/);
  assert.deepEqual(reviewed.verification, {
    command: 'git diff --check',
    status: 'passed',
    baseSha,
    headSha: reviewed.review.headSha,
    output: ''
  });
  const completed = await completeGoal(storeConfig, integratedB.goalId, {
    expectedRevision: integratedB.revision,
    completionKey: 'complete-v1',
    summary: 'Both disjoint worker results were reviewed and integrated.',
    criteria: [{ requirement: 'Both worker files are integrated', status: 'passed', evidence: 'Goal review contains src/a.txt and src/b.txt.' }],
    verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'Integrated patch passed Git whitespace validation.' }]
  });
  assert.equal(completed.lifecycle, 'completed');
  await fs.writeFile(path.join(sourceRoot, 'user-note.txt'), 'preserve me\n', 'utf8');
  const applied = await applyCompletedGoal(executionConfig, completed.goalId, {
    expectedRevision: completed.revision,
    applicationKey: 'apply-v1',
    isPathContentAllowed: () => true
  });
  assert.equal(applied.sourceApplication.status, 'applied');
  assert.deepEqual(applied.sourceApplication.sourceDirtyPathsBefore, ['user-note.txt']);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'a.txt'), 'utf8'), 'worker a integrated\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'b.txt'), 'utf8'), 'worker b integrated\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'user-note.txt'), 'utf8'), 'preserve me\n');
  const applyRetry = await applyCompletedGoal(executionConfig, completed.goalId, {
    expectedRevision: completed.revision,
    applicationKey: 'apply-v1',
    isPathContentAllowed: () => true
  });
  assert.equal(applyRetry.revision, applied.revision);
  assert.equal(git(sourceRoot, ['rev-parse', 'HEAD']), baseSha);
  assert.match(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), /src\/a\.txt/);
  assert.match(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), /src\/b\.txt/);
  assert.match(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), /user-note\.txt/);
  assert.equal(sourceStatusBefore, '');

  const oversizedProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'oversized-integration-journal-v1', title: 'Bound integration journal', goal: 'Reject an integration journal beyond its durable metadata bound.', completionCriteria: ['Oversized journal is rejected'], verification: [], executionPolicy: 'supervised', workspacePolicy: 'isolated', workerModel: 'gpt-5.6-sol', workerEffort: 'high', limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 2_097_152 }, permissions: { fileGlobs: ['src/oversized*', 'src/oversized/**'], commands: [], network: false, sourceEffects: { apply: false, commit: false, push: false, draftPr: false } }, baseSha, work: [{ workId: 'work_oversized', title: 'Generate bounded-path fixture', goal: 'Create the approved oversized path set.', acceptanceCriteria: ['Fixture generated'], fileGlobs: ['src/oversized*', 'src/oversized/**'] }]
  });
  const oversizedApproved = await approveGoal(storeConfig, oversizedProposal.goal.goalId, { expectedRevision: oversizedProposal.goal.revision, contractFingerprint: oversizedProposal.goal.contractFingerprint, approvalKey: 'approve-oversized' });
  const oversizedStarted = await startGoal(executionConfig, oversizedApproved.goalId, { expectedRevision: oversizedApproved.revision, startKey: 'start-oversized' });
  let oversizedReady = oversizedStarted.goal;
  const oversizedDeadline = Date.now() + 10_000;
  while (Date.now() < oversizedDeadline) { oversizedReady = await refreshGoal(executionConfig, oversizedStarted.goal.goalId); if (oversizedReady.work[0].status === 'waiting_review') break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(oversizedReady.work[0].status, 'waiting_review');
  const oversizedTaskDeadline = Date.now() + 10_000;
  let oversizedTask = await getCodingTask(storeConfig, oversizedReady.work[0].codingTaskId);
  while (Date.now() < oversizedTaskDeadline && oversizedTask.activeOperation) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    oversizedTask = await getCodingTask(storeConfig, oversizedReady.work[0].codingTaskId);
  }
  assert.equal(oversizedTask.activeOperation, undefined, 'oversized fixture must have no active CodingTask lease before worktree mutation');
  assert.equal(oversizedTask.lifecycle, 'waiting_review', 'oversized fixture must be authoritatively terminal and reviewable');
  await fs.mkdir(path.join(oversizedTask.worktreeRoot, 'src', 'oversized'), { recursive: true });
  for (let index = 0; index < 300; index++) await fs.writeFile(path.join(oversizedTask.worktreeRoot, 'src', 'oversized', `${String(index).padStart(4, '0')}-${'x'.repeat(210)}.txt`), 'x\n');
  const oversizedStatePath = path.join(dataRoot, 'goals', oversizedReady.goalId, 'state.json');
  const oversizedJournalPath = path.join(dataRoot, 'goals', oversizedReady.goalId, 'integrations', 'work_oversized.json');
  const oversizedStateBefore = await fs.readFile(oversizedStatePath);
  const oversizedHeadBefore = git(oversizedReady.integrationWorktreeRoot, ['rev-parse', 'HEAD']);
  const oversizedSourceBefore = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  await assert.rejects(integrateGoalWork(executionConfig, oversizedReady.goalId, { expectedRevision: oversizedReady.revision, workId: 'work_oversized', integrationKey: 'integrate-oversized', isPathContentAllowed: () => true }), /journal exceeds/);
  assert.deepEqual(await fs.readFile(oversizedStatePath), oversizedStateBefore);
  assert.equal(git(oversizedReady.integrationWorktreeRoot, ['rev-parse', 'HEAD']), oversizedHeadBefore);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), oversizedSourceBefore);
  assert.equal(await fs.stat(oversizedJournalPath).then(() => true, () => false), false);

  const liveProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'supervised-live-v1',
    title: 'Supervised Live Goal smoke',
    goal: 'Project one reviewed private integration checkpoint into the dirty source without losing unrelated edits.',
    completionCriteria: ['The Live checkpoint is projected and sealed'],
    verification: ['git diff --check'],
    executionPolicy: 'supervised',
    workspacePolicy: 'live',
    workerModel: 'gpt-5.6-sol',
    workerEffort: 'high',
    limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 },
    permissions: { fileGlobs: ['src/unknown*.txt'], commands: ['git diff --check'], network: false, sourceEffects: { apply: true, commit: false, push: false, draftPr: false } },
    baseSha,
    work: [{ workId: 'work_live', title: 'Add Live files', goal: 'Add only src/unknown.txt and src/unknown2.txt.', acceptanceCriteria: ['Live files are added'], verification: ['git diff --check'], fileGlobs: ['src/unknown*.txt'] }]
  });
  assert.equal(liveProposal.goal.live.projectedIntegrationSha, baseSha);
  const liveApproved = await approveGoal(storeConfig, liveProposal.goal.goalId, { expectedRevision: liveProposal.goal.revision, contractFingerprint: liveProposal.goal.contractFingerprint, approvalKey: 'approve-live-v1' });
  const liveStarted = await startGoal(executionConfig, liveApproved.goalId, { expectedRevision: liveApproved.revision, startKey: 'start-live-v1' });
  let liveReady = liveStarted.goal;
  const liveDeadline = Date.now() + 10_000;
  while (Date.now() < liveDeadline) {
    liveReady = await refreshGoal(executionConfig, liveStarted.goal.goalId);
    if (liveReady.work[0].status === 'waiting_review') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const liveIntegrated = await integrateGoalWork(executionConfig, liveReady.goalId, { expectedRevision: liveReady.revision, workId: 'work_live', integrationKey: 'integrate-live-v1', isPathContentAllowed: () => true });
  const liveReview = await reviewGoal(executionConfig, liveIntegrated.goalId, () => true);
  assert.equal(liveReview.projectionEligible, true);
  const sourceBeforeProjection = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const projected = await projectGoal(executionConfig, liveIntegrated.goalId, {
    expectedRevision: liveIntegrated.revision,
    projectionKey: 'project-live-v1',
    integrationHeadSha: liveReview.integrationHeadSha,
    reviewFingerprint: liveReview.reviewFingerprint,
    isPathContentAllowed: () => true
  });
  assert.equal(projected.projection.status, 'applied');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'unknown.txt'), 'utf8'), 'worker unknown integrated\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'unknown2.txt'), 'utf8'), 'worker unknown2 integrated\n');
  const projectedRetry = await projectGoal(executionConfig, liveIntegrated.goalId, {
    expectedRevision: liveIntegrated.revision,
    projectionKey: 'project-live-v1',
    integrationHeadSha: liveReview.integrationHeadSha,
    reviewFingerprint: liveReview.reviewFingerprint,
    isPathContentAllowed: () => true
  });
  assert.equal(projectedRetry.reused, true);
  assert.equal(projectedRetry.goal.revision, projected.goal.revision);

  await fs.writeFile(path.join(sourceRoot, 'src', 'unknown.txt'), 'external same-path edit\n', 'utf8');
  const sourceBeforeDriftedRetry = await fs.readFile(path.join(sourceRoot, 'src', 'unknown.txt'));
  await assert.rejects(projectGoal(executionConfig, projected.goal.goalId, { expectedRevision: liveIntegrated.revision, projectionKey: 'project-live-v1', integrationHeadSha: liveReview.integrationHeadSha, reviewFingerprint: liveReview.reviewFingerprint, isPathContentAllowed: () => true }), /cumulative projected state/);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'src', 'unknown.txt')), sourceBeforeDriftedRetry);
  await assert.rejects(revertGoalProjection(executionConfig, projected.goal.goalId, {
    expectedRevision: projected.goal.revision,
    projectionId: projected.projection.projectionId,
    revertKey: 'revert-live-v1',
    isPathContentAllowed: () => true
  }), /source path drifted|external same-path edit/);
  await fs.writeFile(path.join(sourceRoot, 'src', 'unknown.txt'), 'worker unknown integrated\n', 'utf8');
  const recoveryStatePath = path.join(dataRoot, 'goals', projected.goal.goalId, 'state.json');
  const simulatedApplyCrash = JSON.parse(await fs.readFile(recoveryStatePath, 'utf8'));
  simulatedApplyCrash.revision += 1;
  simulatedApplyCrash.updatedAt = new Date().toISOString();
  simulatedApplyCrash.live.pendingProjectionId = projected.projection.projectionId;
  simulatedApplyCrash.live.projections = simulatedApplyCrash.live.projections.map((item) => item.projectionId === projected.projection.projectionId ? { ...item, status: 'recovery_required', error: 'simulated response loss after source write' } : item);
  await fs.writeFile(recoveryStatePath, `${JSON.stringify(simulatedApplyCrash, null, 2)}\n`, { mode: 0o600 });
  const recoveryState = (await reviewGoal(executionConfig, projected.goal.goalId, () => true)).goal;
  const reverted = await revertGoalProjection(executionConfig, projected.goal.goalId, {
    expectedRevision: recoveryState.revision,
    projectionId: projected.projection.projectionId,
    revertKey: 'revert-live-v1',
    isPathContentAllowed: () => true
  });
  assert.equal(reverted.projection.status, 'reverted');
  assert.equal(await fs.stat(path.join(sourceRoot, 'src', 'unknown.txt')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(sourceRoot, 'src', 'unknown2.txt')).then(() => true, () => false), false);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).includes('src/unknown.txt'), false);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']).includes('user-note.txt'), true);

  const projectedAgain = await projectGoal(executionConfig, reverted.goal.goalId, {
    expectedRevision: reverted.goal.revision,
    projectionKey: 'project-live-v2',
    integrationHeadSha: liveReview.integrationHeadSha,
    reviewFingerprint: liveReview.reviewFingerprint,
    isPathContentAllowed: () => true
  });
  await fs.unlink(path.join(sourceRoot, 'src', 'unknown2.txt'));
  const mixedState = JSON.parse(await fs.readFile(recoveryStatePath, 'utf8'));
  mixedState.revision += 1;
  mixedState.updatedAt = new Date().toISOString();
  mixedState.live.pendingProjectionId = projectedAgain.projection.projectionId;
  mixedState.live.projections = mixedState.live.projections.map((item) => item.projectionId === projectedAgain.projection.projectionId ? { ...item, status: 'recovery_required', error: 'simulated mixed before/after apply crash' } : item);
  await fs.writeFile(recoveryStatePath, `${JSON.stringify(mixedState, null, 2)}\n`, { mode: 0o600 });
  const mixedReverted = await revertGoalProjection(executionConfig, projectedAgain.goal.goalId, { expectedRevision: mixedState.revision, projectionId: projectedAgain.projection.projectionId, revertKey: 'revert-live-mixed', isPathContentAllowed: () => true });
  assert.equal(mixedReverted.projection.status, 'reverted');
  const finalProjection = await projectGoal(executionConfig, mixedReverted.goal.goalId, { expectedRevision: mixedReverted.goal.revision, projectionKey: 'project-live-v3', integrationHeadSha: liveReview.integrationHeadSha, reviewFingerprint: liveReview.reviewFingerprint, isPathContentAllowed: () => true });
  const liveCompletionInput = {
    expectedRevision: finalProjection.goal.revision,
    completionKey: 'complete-live-v1',
    summary: 'The exact reviewed Live checkpoint was projected.',
    reviewFingerprint: liveReview.reviewFingerprint,
    criteria: [{ requirement: 'The Live checkpoint is projected and sealed', status: 'passed', evidence: 'Projection readback matched the immutable after-manifest.' }],
    verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'Authoritative integration verification passed.' }]
  };
  const liveCompleted = await completeGoal(storeConfig, finalProjection.goal.goalId, liveCompletionInput);
  assert.equal((await completeGoal(storeConfig, finalProjection.goal.goalId, liveCompletionInput)).revision, liveCompleted.revision);
  await assert.rejects(completeGoal(storeConfig, finalProjection.goal.goalId, { ...liveCompletionInput, reviewFingerprint: '0'.repeat(64) }), /different evidence/);
  const bytesBeforeSeal = await fs.readFile(path.join(sourceRoot, 'src', 'unknown.txt'));
  const statusBeforeSeal = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const sealed = await applyCompletedGoal(executionConfig, liveCompleted.goalId, { expectedRevision: liveCompleted.revision, applicationKey: 'seal-live-v1', isPathContentAllowed: () => true });
  assert.equal(sealed.sourceApplication.zeroWrite, true);
  assert.equal(sealed.live.adoptedProjectionId, finalProjection.projection.projectionId);
  assert.equal(sealed.live.projections.at(-1).status, 'adopted');
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'src', 'unknown.txt')), bytesBeforeSeal);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), statusBeforeSeal);
  assert.equal(statusBeforeSeal.includes('src/a.txt'), true);
  assert.equal(statusBeforeSeal.includes('src/b.txt'), true);
  assert.equal(statusBeforeSeal.includes('user-note.txt'), true);
  assert.notEqual(sourceBeforeProjection, statusBeforeSeal);

  const secureProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'secure-mode-v1', title: 'Preserve private permissions', goal: 'Modify a 0600 source file without broadening it.', completionCriteria: ['Permissions remain private'], verification: [], executionPolicy: 'supervised', workspacePolicy: 'live', workerModel: 'gpt-5.6-sol', workerEffort: 'high', limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 }, permissions: { fileGlobs: ['src/secure.txt'], commands: [], network: false, sourceEffects: { apply: true, commit: false, push: false, draftPr: false } }, baseSha, work: [{ workId: 'work_secure', title: 'Modify secure', goal: 'Modify src/secure.txt.', acceptanceCriteria: ['modified'], fileGlobs: ['src/secure.txt'] }]
  });
  const secureApproved = await approveGoal(storeConfig, secureProposal.goal.goalId, { expectedRevision: secureProposal.goal.revision, contractFingerprint: secureProposal.goal.contractFingerprint, approvalKey: 'approve-secure' });
  const secureStarted = await startGoal(executionConfig, secureApproved.goalId, { expectedRevision: secureApproved.revision, startKey: 'start-secure' });
  let secureReady = secureStarted.goal;
  const secureDeadline = Date.now() + 10_000;
  while (Date.now() < secureDeadline) { secureReady = await refreshGoal(executionConfig, secureStarted.goal.goalId); if (secureReady.work[0].status === 'waiting_review') break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  const secureIntegrated = await integrateGoalWork(executionConfig, secureReady.goalId, { expectedRevision: secureReady.revision, workId: 'work_secure', integrationKey: 'integrate-secure', isPathContentAllowed: () => true });
  const secureReview = await reviewGoal(executionConfig, secureIntegrated.goalId, () => true);
  const secureProjected = await projectGoal(executionConfig, secureIntegrated.goalId, { expectedRevision: secureIntegrated.revision, projectionKey: 'project-secure', integrationHeadSha: secureReview.integrationHeadSha, reviewFingerprint: secureReview.reviewFingerprint, isPathContentAllowed: () => true });
  assert.equal((await fs.stat(path.join(sourceRoot, 'src', 'secure.txt'))).mode & 0o777, 0o600);
  const secureReverted = await revertGoalProjection(executionConfig, secureProjected.goal.goalId, { expectedRevision: secureProjected.goal.revision, projectionId: secureProjected.projection.projectionId, revertKey: 'revert-secure', isPathContentAllowed: () => true });
  assert.equal(secureReverted.projection.status, 'reverted');
  assert.equal((await fs.stat(path.join(sourceRoot, 'src', 'secure.txt'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'secure.txt'), 'utf8'), 'base secure\n');

  const cumulativeProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'cumulative-live-v1', title: 'Cumulative Live readback smoke', goal: 'Project two disjoint checkpoints and retain cumulative ownership authority.',
    completionCriteria: ['Both checkpoints remain authoritative'], verification: ['git diff --check'], executionPolicy: 'supervised', workspacePolicy: 'live',
    workerModel: 'gpt-5.6-sol', workerEffort: 'high', limits: { maxConcurrency: 2, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 },
    permissions: { fileGlobs: ['src/live-*.txt'], commands: ['git diff --check'], network: false, sourceEffects: { apply: true, commit: false, push: false, draftPr: false } }, baseSha,
    work: [
      { workId: 'work_live_a', title: 'Live A', goal: 'Add src/live-a.txt.', acceptanceCriteria: ['A'], fileGlobs: ['src/live-a.txt'] },
      { workId: 'work_live_b', title: 'Live B', goal: 'Add src/live-b.txt.', acceptanceCriteria: ['B'], fileGlobs: ['src/live-b.txt'] }
    ]
  });
  const cumulativeApproved = await approveGoal(storeConfig, cumulativeProposal.goal.goalId, { expectedRevision: cumulativeProposal.goal.revision, contractFingerprint: cumulativeProposal.goal.contractFingerprint, approvalKey: 'approve-cumulative-v1' });
  const cumulativeStarted = await startGoal(executionConfig, cumulativeApproved.goalId, { expectedRevision: cumulativeApproved.revision, startKey: 'start-cumulative-v1' });
  let cumulativeReady = cumulativeStarted.goal;
  const cumulativeDeadline = Date.now() + 10_000;
  while (Date.now() < cumulativeDeadline) {
    cumulativeReady = await refreshGoal(executionConfig, cumulativeStarted.goal.goalId);
    if (cumulativeReady.work.every((item) => item.status === 'waiting_review')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cumulativeA = await integrateGoalWork(executionConfig, cumulativeReady.goalId, { expectedRevision: cumulativeReady.revision, workId: 'work_live_a', integrationKey: 'integrate-live-a', isPathContentAllowed: () => true });
  const reviewA = await reviewGoal(executionConfig, cumulativeA.goalId, () => true);
  const projectionA = await projectGoal(executionConfig, cumulativeA.goalId, { expectedRevision: cumulativeA.revision, projectionKey: 'project-live-a', integrationHeadSha: reviewA.integrationHeadSha, reviewFingerprint: reviewA.reviewFingerprint, isPathContentAllowed: () => true });
  const cumulativeB = await integrateGoalWork(executionConfig, cumulativeReady.goalId, { expectedRevision: projectionA.goal.revision, workId: 'work_live_b', integrationKey: 'integrate-live-b', isPathContentAllowed: () => true });
  const reviewB = await reviewGoal(executionConfig, cumulativeB.goalId, () => true);
  const projectionB = await projectGoal(executionConfig, cumulativeB.goalId, { expectedRevision: cumulativeB.revision, projectionKey: 'project-live-b', integrationHeadSha: reviewB.integrationHeadSha, reviewFingerprint: reviewB.reviewFingerprint, isPathContentAllowed: () => true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'live-a.txt'), 'external edit to earlier projection\n', 'utf8');
  const stateBeforeCumulativeFailures = JSON.stringify(projectionB.goal);
  await assert.rejects(completeGoal(executionConfig, projectionB.goal.goalId, { expectedRevision: projectionB.goal.revision, completionKey: 'complete-cumulative', summary: 'must fail', reviewFingerprint: reviewB.reviewFingerprint, criteria: [{ requirement: 'Both checkpoints remain authoritative', status: 'passed', evidence: 'claimed' }], verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'passed' }], isPathContentAllowed: () => true }), /cumulative projected state/);
  await assert.rejects(applyCompletedGoal(executionConfig, projectionB.goal.goalId, { expectedRevision: projectionB.goal.revision, applicationKey: 'seal-cumulative', isPathContentAllowed: () => true }), /Only a Pro-completed Goal/);
  await assert.rejects(revertGoalProjection(executionConfig, projectionB.goal.goalId, { expectedRevision: projectionB.goal.revision, projectionId: projectionB.projection.projectionId, revertKey: 'revert-cumulative-b', isPathContentAllowed: () => true }), /cumulative projected state/);
  const stateAfterCumulativeFailures = (await reviewGoal(executionConfig, projectionB.goal.goalId, () => true)).goal;
  assert.equal(JSON.stringify(stateAfterCumulativeFailures), stateBeforeCumulativeFailures);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'live-a.txt'), 'utf8'), 'external edit to earlier projection\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'live-b.txt'), 'utf8'), 'worker live-b integrated\n');
  await fs.writeFile(path.join(sourceRoot, 'src', 'live-a.txt'), 'worker live-a integrated\n', 'utf8');
  const cumulativeCompleted = await completeGoal(executionConfig, projectionB.goal.goalId, { expectedRevision: projectionB.goal.revision, completionKey: 'complete-cumulative', summary: 'Both checkpoints were cumulatively verified.', reviewFingerprint: reviewB.reviewFingerprint, criteria: [{ requirement: 'Both checkpoints remain authoritative', status: 'passed', evidence: 'Cumulative manifest readback passed.' }], verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'passed' }], isPathContentAllowed: () => true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'live-a.txt'), 'external edit after completion\n', 'utf8');
  const completedStateBeforeApply = JSON.stringify(cumulativeCompleted);
  await assert.rejects(applyCompletedGoal(executionConfig, cumulativeCompleted.goalId, { expectedRevision: cumulativeCompleted.revision, applicationKey: 'seal-cumulative', isPathContentAllowed: () => true }), /cumulative projected state/);
  assert.equal(JSON.stringify((await reviewGoal(executionConfig, cumulativeCompleted.goalId, () => true)).goal), completedStateBeforeApply);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'live-a.txt'), 'utf8'), 'external edit after completion\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'live-b.txt'), 'utf8'), 'worker live-b integrated\n');

  const canceledProjectionProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'cancel-before-project-v1', title: 'Cancel before project', goal: 'Prove cancel linearizes before source projection.', completionCriteria: ['No source projection'], verification: [], executionPolicy: 'supervised', workspacePolicy: 'live', workerModel: 'gpt-5.6-sol', workerEffort: 'high', limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 }, permissions: { fileGlobs: ['src/cancel-project.txt'], commands: [], network: false, sourceEffects: { apply: true, commit: false, push: false, draftPr: false } }, baseSha, work: [{ workId: 'work_cancel_project', title: 'Candidate projection', goal: 'Add src/cancel-project.txt.', acceptanceCriteria: ['candidate'], fileGlobs: ['src/cancel-project.txt'] }]
  });
  const canceledProjectionApproved = await approveGoal(storeConfig, canceledProjectionProposal.goal.goalId, { expectedRevision: canceledProjectionProposal.goal.revision, contractFingerprint: canceledProjectionProposal.goal.contractFingerprint, approvalKey: 'approve-cancel-project' });
  const canceledProjectionStarted = await startGoal(executionConfig, canceledProjectionApproved.goalId, { expectedRevision: canceledProjectionApproved.revision, startKey: 'start-cancel-project' });
  let canceledProjectionReady = canceledProjectionStarted.goal;
  const canceledProjectionDeadline = Date.now() + 10_000;
  while (Date.now() < canceledProjectionDeadline) {
    canceledProjectionReady = await refreshGoal(executionConfig, canceledProjectionStarted.goal.goalId);
    if (canceledProjectionReady.work[0].status === 'waiting_review') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const canceledProjectionIntegrated = await integrateGoalWork(executionConfig, canceledProjectionReady.goalId, { expectedRevision: canceledProjectionReady.revision, workId: 'work_cancel_project', integrationKey: 'integrate-cancel-project', isPathContentAllowed: () => true });
  const canceledProjectionReview = await reviewGoal(executionConfig, canceledProjectionIntegrated.goalId, () => true);
  const canceledProjectionGoal = await cancelGoal(storeConfig, canceledProjectionIntegrated.goalId, { expectedRevision: canceledProjectionIntegrated.revision, cancelKey: 'cancel-before-project' });
  const canceledStateBytes = await fs.readFile(path.join(dataRoot, 'goals', canceledProjectionGoal.goalId, 'state.json'));
  const sourceStatusBeforeCanceledProject = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  await assert.rejects(projectGoal(executionConfig, canceledProjectionGoal.goalId, { expectedRevision: canceledProjectionIntegrated.revision, projectionKey: 'must-not-project', integrationHeadSha: canceledProjectionReview.integrationHeadSha, reviewFingerprint: canceledProjectionReview.reviewFingerprint, isPathContentAllowed: () => true }), /nonterminal running/);
  assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', canceledProjectionGoal.goalId, 'state.json')), canceledStateBytes);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatusBeforeCanceledProject);
  assert.equal(await fs.stat(path.join(sourceRoot, 'src', 'cancel-project.txt')).then(() => true, () => false), false);

  const backslashProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'literal-backslash-v1', title: 'Reject noncanonical path', goal: 'Exercise a literal backslash filename.', completionCriteria: ['Unsafe path is rejected'], verification: [], executionPolicy: 'supervised', workspacePolicy: 'live', workerModel: 'gpt-5.6-sol', workerEffort: 'high', limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 }, permissions: { fileGlobs: ['**'], commands: [], network: false, sourceEffects: { apply: true, commit: false, push: false, draftPr: false } }, baseSha, work: [{ workId: 'work_backslash', title: 'Literal backslash', goal: 'Create the approved test filename.', acceptanceCriteria: ['created'], fileGlobs: [] }]
  });
  const backslashApproved = await approveGoal(storeConfig, backslashProposal.goal.goalId, { expectedRevision: backslashProposal.goal.revision, contractFingerprint: backslashProposal.goal.contractFingerprint, approvalKey: 'approve-backslash' });
  const backslashStarted = await startGoal(executionConfig, backslashApproved.goalId, { expectedRevision: backslashApproved.revision, startKey: 'start-backslash' });
  let backslashReady = backslashStarted.goal;
  const backslashDeadline = Date.now() + 10_000;
  while (Date.now() < backslashDeadline) {
    backslashReady = await refreshGoal(executionConfig, backslashStarted.goal.goalId);
    if (backslashReady.work[0].status === 'waiting_review') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const backslashIntegrated = await integrateGoalWork(executionConfig, backslashReady.goalId, { expectedRevision: backslashReady.revision, workId: 'work_backslash', integrationKey: 'integrate-backslash', isPathContentAllowed: () => true });
  const backslashReview = await reviewGoal(executionConfig, backslashIntegrated.goalId, () => true);
  const backslashStatePath = path.join(dataRoot, 'goals', backslashIntegrated.goalId, 'state.json');
  const backslashStateBefore = await fs.readFile(backslashStatePath);
  await assert.rejects(projectGoal(executionConfig, backslashIntegrated.goalId, { expectedRevision: backslashIntegrated.revision, projectionKey: 'project-backslash', integrationHeadSha: backslashReview.integrationHeadSha, reviewFingerprint: backslashReview.reviewFingerprint, isPathContentAllowed: () => true }), /non-canonical POSIX path/);
  assert.deepEqual(await fs.readFile(backslashStatePath), backslashStateBefore);
  assert.equal(await fs.stat(path.join(sourceRoot, 'src', 'foo\\bar')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(dataRoot, 'goals', backslashIntegrated.goalId, 'projections')).then(() => true, () => false), false);

  const cancelProposal = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, {
    goalKey: 'cancel-running-v1',
    title: 'Cancel active Goal smoke',
    goal: 'Prove active Goal cancellation reaches the worker before terminal state.',
    completionCriteria: ['Worker is canceled'],
    verification: [],
    executionPolicy: 'supervised',
    workspacePolicy: 'isolated',
    workerModel: 'gpt-5.6-sol',
    workerEffort: 'high',
    limits: { maxConcurrency: 1, timeoutMs: 30_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 },
    permissions: { fileGlobs: ['src/**'], commands: [], network: false, sourceEffects: { apply: false, commit: false, push: false, draftPr: false } },
    baseSha,
    work: [{ workId: 'work_cancel', title: 'Cancelable work', goal: 'Wait for cancellation.', acceptanceCriteria: ['Cancellation is observed'], fileGlobs: ['src/**'] }]
  });
  const cancelApproved = await approveGoal(storeConfig, cancelProposal.goal.goalId, {
    expectedRevision: cancelProposal.goal.revision,
    contractFingerprint: cancelProposal.goal.contractFingerprint,
    approvalKey: 'approve-cancel-v1'
  });
  const cancelStarted = await startGoal(executionConfig, cancelApproved.goalId, { expectedRevision: cancelApproved.revision, startKey: 'start-cancel-v1' });
  const canceled = await cancelGoal(storeConfig, cancelStarted.goal.goalId, {
    expectedRevision: cancelStarted.goal.revision,
    cancelKey: 'cancel-v1',
    reason: 'Smoke verifies durable interruption.'
  });
  assert.equal(canceled.lifecycle, 'canceled');
  assert.equal(canceled.work[0].status, 'canceled');
  const canceledTask = await getCodingTask(storeConfig, canceled.work[0].codingTaskId);
  assert.equal(canceledTask.activeOperation, undefined);
  assert.equal(canceledTask.lifecycle, 'canceled');
  const cancelRetry = await cancelGoal(storeConfig, cancelStarted.goal.goalId, {
    expectedRevision: cancelStarted.goal.revision,
    cancelKey: 'cancel-v1',
    reason: 'Smoke verifies durable interruption.'
  });
  assert.equal(cancelRetry.revision, canceled.revision);

  console.log('goal execution smoke: ok');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
