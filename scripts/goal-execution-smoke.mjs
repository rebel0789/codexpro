import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveGoal, completeGoal, pauseGoal, proposeGoal, resumeGoal } from '../dist/goalOps.js';
import { applyCompletedGoal, cancelGoal, integrateGoalWork, refreshGoal, reviewGoal, startGoal } from '../dist/goalExecution.js';
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
  git(sourceRoot, ['add', '--', 'src/a.txt', 'src/b.txt']);
  git(sourceRoot, ['commit', '-qm', 'base']);
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
    slot = prompt.includes('work_a') ? 'a' : prompt.includes('work_b') ? 'b' : 'unknown';
    fs.appendFileSync(launches, 'start:' + slot + ':' + Date.now() + '\\n');
    fs.writeFileSync(path.join(process.cwd(), 'src', slot + '.txt'), 'worker ' + slot + ' integrated\\n');
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

  const integratedA = await integrateGoalWork(executionConfig, refreshed.goalId, {
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
