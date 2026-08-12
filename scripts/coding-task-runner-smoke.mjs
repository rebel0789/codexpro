import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task-runner-'));
let dataRoot = path.join(temp, 'data');
let worktree = path.join(dataRoot, 'worktrees', 'task_0123456789abcdef01234567');
const fakeCodex = path.join(temp, 'fake-codex');
const fakeLaunchCount = path.join(temp, 'fake-launch-count');

const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';
const launchCountPath = ${JSON.stringify(fakeLaunchCount)};
let launchCount = 0;
try { launchCount = Number.parseInt(fs.readFileSync(launchCountPath, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(launchCountPath, String(launchCount + 1));
let buffer = '';
const threadId = 'thread-smoke';
const sessionId = 'session-smoke';
const turnId = 'turn-smoke';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function turn(status = 'inProgress') { return { id: turnId, status, error: null, items: status === 'completed' ? [{ type: 'agentMessage', id: 'final', text: 'finished sk-1234567890SECRET', phase: 'final_answer' }] : [] }; }
function handle(message) {
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId || threadId, sessionId, ephemeral: false } } });
  if (message.method === 'turn/start') return send({ id: message.id, result: { turn: turn() } });
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: turn('completed') } }), 10);
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

try {
  await fs.mkdir(dataRoot, { recursive: true });
  dataRoot = await fs.realpath(dataRoot);
  worktree = path.join(dataRoot, 'worktrees', 'task_0123456789abcdef01234567');
  let source = path.join(temp, 'source');
  await fs.mkdir(source, { recursive: true });
  source = await fs.realpath(source);
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['config', 'user.email', 'runner@example.test'], { cwd: source });
  execFileSync('git', ['config', 'user.name', 'Runner Smoke'], { cwd: source });
  await fs.writeFile(path.join(source, 'README.md'), 'runner smoke\n');
  execFileSync('git', ['add', 'README.md'], { cwd: source });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: source });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '--detach', worktree, baseSha], { cwd: source, stdio: 'ignore' });
  const commonDir = await fs.realpath(path.join(source, '.git'));
  await fs.writeFile(fakeCodex, fakeSource, { mode: 0o755 });
  const { CodingTaskStore } = await import(pathToFileURL(path.join(root, 'dist', 'codingTaskStore.js')).href);
  const { beginCodingTaskOperation, requestCodingTaskCancellation } = await import(pathToFileURL(path.join(root, 'dist', 'codingTaskOps.js')).href);
  const { launchCodingTaskRun, waitForCodingTaskRun, submitCodingTaskFollowup, getCodingTaskSteer, reconcileCodingTaskRun, cancelQueuedCodingTaskRun } = await import(
    pathToFileURL(path.join(root, 'dist', 'codingTaskRunner.js')).href
  );
  const taskId = 'task_0123456789abcdef01234567';
  const now = new Date().toISOString();
  const store = new CodingTaskStore({ dataRoot });
  await store.initialize();
  await store.withTaskLock(taskId, () => store.writeLocked({
    version: 1,
    taskId,
    taskKey: 'runner-smoke',
    createFingerprint: 'a'.repeat(64),
    title: 'Runner smoke',
    goal: 'Exercise detached runner and durable steer',
    executor: 'codex',
    lifecycle: 'ready',
    baseSha,
    sourceRoot: source,
    sourceGitCommonDir: commonDir,
    sourceUncommittedChangesIncluded: false,
    sourceDirtyAtCreation: false,
    sourceStatusEntryCountAtCreation: 0,
    worktreeRoot: worktree,
    workspaceId: 'taskws_0123456789abcdef01234567',
    revision: 1,
    executorLease: { owner: 'codex', epoch: 1, leaseId: 'lease-smoke', acquiredAt: now },
    codexTurnActive: false,
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, kind: 'created', executor: 'codex', epoch: 1 }],
    logs: []
  }));

  const launchInput = {
    operationId: 'run-one',
    prompt: 'Implement and verify the task',
    expectedRevision: 1,
    executorEpoch: 1,
    leaseId: 'lease-smoke',
    model: 'gpt-5.6-sol',
    effort: 'high',
    timeoutMs: 5_000
  };
  const launched = await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, launchInput);
  assert.notEqual(launched.status, 'queued');
  await waitFor(async () => (await store.get(taskId)).codexTurnActive === true);
  const task = await store.get(taskId);
  assert.equal(task.codexThreadId, 'thread-smoke');
  assert.equal(task.codexSessionId, 'session-smoke');
  assert.equal(task.codexTurnId, 'turn-smoke');

  const followup = await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'follow-one', prompt: 'Also report verification.', model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  });
  assert.equal(followup.mode, 'steer');
  assert.equal(followup.steer.status, 'queued');
  await waitFor(async () => (await getCodingTaskSteer({ dataRoot }, taskId, 'run-one', 'follow-one')).status === 'delivered');
  const finished = await waitForCodingTaskRun({ dataRoot }, taskId, 'run-one', { timeoutMs: 5_000 });
  assert.equal(finished.status, 'waiting_review', JSON.stringify(finished, null, 2));
  await waitFor(async () => (await waitForCodingTaskRun({ dataRoot }, taskId, 'run-one', { timeoutMs: 0 })).runnerAlive === false);
  assert.equal(finished.finalText, 'finished [REDACTED_SECRET]');
  const completedTask = await store.get(taskId);
  assert.equal(completedTask.lifecycle, 'waiting_review');
  assert.equal(completedTask.activeOperation, undefined);
  assert.equal(completedTask.codexThreadId, 'thread-smoke');
  const responseLossRetry = await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'follow-one', prompt: 'Also report verification.', model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  });
  assert.equal(responseLossRetry.mode, 'steer');
  assert.equal(responseLossRetry.steer.status, 'delivered');
  assert.equal(responseLossRetry.reused, true);

  const reused = await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, launchInput);
  assert.equal(reused.reused, true);
  await assert.rejects(
    launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, { ...launchInput, prompt: 'different contract', expectedRevision: completedTask.revision }),
    /different Codex run contract/
  );

  const beforeBoundary = await store.get(taskId);
  const boundaryOperationId = `a${'x'.repeat(159)}`;
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    ...launchInput,
    operationId: boundaryOperationId,
    prompt: 'Exercise the maximum operation id boundary',
    expectedRevision: beforeBoundary.revision,
    threadId: beforeBoundary.codexThreadId
  });
  await waitFor(async () => (await store.get(taskId)).activeOperation?.operationId === boundaryOperationId && (await store.get(taskId)).codexTurnActive);
  const boundaryFollowup = await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'boundary-finish', prompt: 'Finish the boundary run.', model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  });
  assert.equal(boundaryFollowup.mode, 'steer');
  const boundaryFinished = await waitForCodingTaskRun({ dataRoot }, taskId, boundaryOperationId, { timeoutMs: 5_000 });
  assert.equal(boundaryFinished.status, 'waiting_review');
  const boundaryTask = await store.get(taskId);
  const boundaryLog = boundaryTask.logs.find((entry) => entry.relativePath.includes(boundaryFinished.operationId) || entry.name.startsWith('codex-run-'));
  assert(boundaryLog);
  assert(boundaryLog.name.length <= 100);
  const taskDir = store.paths(taskId).taskDir;
  for (const directory of [
    path.join(taskDir, 'runs'),
    path.join(taskDir, 'followups')
  ]) {
    const stat = await fs.lstat(directory);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o077, 0, `${directory} must be private`);
  }
  const runDirectories = await fs.readdir(path.join(taskDir, 'runs'), { withFileTypes: true });
  for (const entry of runDirectories.filter((item) => item.isDirectory())) {
    const stat = await fs.lstat(path.join(taskDir, 'runs', entry.name));
    assert.equal(stat.mode & 0o077, 0, `${entry.name} must be private`);
  }

  const beforeOrphan = await store.get(taskId);
  const orphanOperation = 'orphan-divergence';
  const activeOrphan = await beginCodingTaskOperation({ dataRoot }, taskId, {
    expectedRevision: beforeOrphan.revision, executor: 'codex', executorEpoch: beforeOrphan.executorLease.epoch,
    leaseId: beforeOrphan.executorLease.leaseId, operationId: orphanOperation, codexRunnerPid: 999999
  });
  const orphanToken = `run_${createHash('sha256').update(orphanOperation).digest('hex').slice(0, 32)}`;
  const orphanDir = path.join(taskDir, 'runs', orphanToken);
  await fs.mkdir(orphanDir, { recursive: true, mode: 0o700 });
  const orphanCreatedAt = new Date(Date.now() - 60_000).toISOString();
  const orphanFingerprint = 'c'.repeat(64);
  await fs.writeFile(path.join(orphanDir, 'definition.json'), JSON.stringify({
    version: 1, taskId, operationId: orphanOperation, fingerprint: orphanFingerprint,
    prompt: 'orphan', expectedRevision: beforeOrphan.revision, executorEpoch: activeOrphan.executorLease.epoch,
    leaseId: 'lease-deliberately-diverged', worktreeRoot: worktree, codexBinary: fakeCodex,
    model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000, maxLogBytes: 64 * 1024, createdAt: orphanCreatedAt
  }), { mode: 0o600 });
  await fs.writeFile(path.join(orphanDir, 'state.json'), JSON.stringify({
    version: 1, taskId, operationId: orphanOperation, fingerprint: orphanFingerprint, status: 'running',
    createdAt: orphanCreatedAt, updatedAt: orphanCreatedAt, heartbeatAt: orphanCreatedAt, runnerPid: 999999, events: []
  }), { mode: 0o600 });
  await assert.rejects(
    reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, orphanOperation, { staleMs: 0 }),
    /diverged from the authoritative CodingTask lease/
  );
  const strandedGuard = JSON.parse(await fs.readFile(path.join(orphanDir, 'state.json'), 'utf8'));
  assert.equal(strandedGuard.status, 'running', 'run must remain recoverable when authoritative task finish cannot be fenced');
  assert.equal((await store.get(taskId)).activeOperation?.operationId, orphanOperation);
  const launchesBeforeDeadCancel = await readLaunchCount();
  const matchingOrphanDefinition = JSON.parse(await fs.readFile(path.join(orphanDir, 'definition.json'), 'utf8'));
  matchingOrphanDefinition.leaseId = activeOrphan.executorLease.leaseId;
  await fs.writeFile(path.join(orphanDir, 'definition.json'), JSON.stringify(matchingOrphanDefinition), { mode: 0o600 });
  const cancellableOrphan = await store.get(taskId);
  await requestCodingTaskCancellation({ dataRoot }, taskId, {
    expectedRevision: cancellableOrphan.revision, executor: 'codex', executorEpoch: cancellableOrphan.executorLease.epoch,
    leaseId: cancellableOrphan.executorLease.leaseId, operationId: orphanOperation, reason: 'cancel dead runner'
  });
  const deadCanceled = await reconcileCodingTaskRun({ dataRoot }, taskId, orphanOperation, { staleMs: 0, relaunchQueued: false });
  assert.equal(deadCanceled.status, 'canceled');
  assert.equal((await store.get(taskId)).lifecycle, 'canceled');
  assert.equal((await store.get(taskId)).activeOperation, undefined);
  assert.equal(await readLaunchCount(), launchesBeforeDeadCancel, 'dead-run cancellation reconciliation must not launch Codex');

  const passiveTaskId = 'task_fedcba9876543210fedcba98';
  const passiveWorktree = path.join(dataRoot, 'worktrees', passiveTaskId);
  execFileSync('git', ['worktree', 'add', '--detach', passiveWorktree, baseSha], { cwd: source, stdio: 'ignore' });
  const passiveNow = new Date().toISOString();
  await store.withTaskLock(passiveTaskId, () => store.writeLocked({
    version: 1, taskId: passiveTaskId, taskKey: 'passive-reconcile', createFingerprint: 'd'.repeat(64),
    title: 'Passive reconcile', goal: 'Prove passive reconciliation never launches', executor: 'codex', lifecycle: 'ready',
    baseSha, sourceRoot: source, sourceGitCommonDir: commonDir, sourceUncommittedChangesIncluded: false,
    sourceDirtyAtCreation: false, sourceStatusEntryCountAtCreation: 0, worktreeRoot: passiveWorktree,
    workspaceId: 'taskws_fedcba9876543210fedcba98', revision: 1,
    executorLease: { owner: 'codex', epoch: 1, leaseId: 'lease-passive', acquiredAt: passiveNow },
    codexTurnActive: false, createdAt: passiveNow, updatedAt: passiveNow,
    events: [{ at: passiveNow, kind: 'created', executor: 'codex', epoch: 1 }], logs: []
  }));
  const passiveOperation = 'queued-orphan';
  const passiveToken = `run_${createHash('sha256').update(passiveOperation).digest('hex').slice(0, 32)}`;
  const passiveRunDir = path.join(store.paths(passiveTaskId).taskDir, 'runs', passiveToken);
  await fs.mkdir(passiveRunDir, { recursive: true, mode: 0o700 });
  const passiveFingerprint = 'e'.repeat(64);
  const passiveDefinition = {
    version: 1, taskId: passiveTaskId, operationId: passiveOperation, fingerprint: passiveFingerprint,
    prompt: 'queued orphan', expectedRevision: 1, executorEpoch: 1, leaseId: 'lease-passive',
    worktreeRoot: passiveWorktree, codexBinary: fakeCodex, model: 'gpt-5.6-sol', effort: 'high',
    timeoutMs: 5_000, maxLogBytes: 64 * 1024, createdAt: passiveNow
  };
  await fs.writeFile(path.join(passiveRunDir, 'definition.json'), JSON.stringify(passiveDefinition), { mode: 0o600 });
  await fs.writeFile(path.join(passiveRunDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: passiveOperation, fingerprint: passiveFingerprint,
    status: 'queued', createdAt: passiveNow, updatedAt: passiveNow, events: []
  }), { mode: 0o600 });
  const passive = await reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, passiveOperation);
  assert.equal(passive.status, 'queued');
  assert.equal(passive.runnerAlive, false);
  assert.equal((await store.get(passiveTaskId)).activeOperation, undefined);
  const launchesBeforeQueuedCancel = await readLaunchCount();
  const queuedCanceled = await cancelQueuedCodingTaskRun(
    { dataRoot }, passiveTaskId, passiveOperation, 'user canceled queued recovery'
  );
  assert.equal(queuedCanceled.status, 'canceled');
  assert.equal(await readLaunchCount(), launchesBeforeQueuedCancel, 'queued cancellation must not spawn App Server');
  const queuedCancelRetry = await cancelQueuedCodingTaskRun(
    { dataRoot }, passiveTaskId, passiveOperation, 'same retry may use any display reason'
  );
  assert.equal(queuedCancelRetry.status, 'canceled');
  assert.equal(queuedCancelRetry.reused, true);
  assert.equal((await store.get(passiveTaskId)).activeOperation, undefined);

  const recoveryOperation = 'queued-execution-recovery';
  const recoveryToken = `run_${createHash('sha256').update(recoveryOperation).digest('hex').slice(0, 32)}`;
  const recoveryDir = path.join(store.paths(passiveTaskId).taskDir, 'runs', recoveryToken);
  await fs.mkdir(recoveryDir, { recursive: true, mode: 0o700 });
  const recoveryFingerprint = 'f'.repeat(64);
  await fs.writeFile(path.join(recoveryDir, 'definition.json'), JSON.stringify({
    ...passiveDefinition, operationId: recoveryOperation, fingerprint: recoveryFingerprint
  }), { mode: 0o600 });
  await fs.writeFile(path.join(recoveryDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: recoveryOperation, fingerprint: recoveryFingerprint,
    status: 'queued', createdAt: passiveNow, updatedAt: passiveNow, events: []
  }), { mode: 0o600 });
  const executionRecovery = await reconcileCodingTaskRun(
    { dataRoot, codexBinary: fakeCodex }, passiveTaskId, recoveryOperation, { relaunchQueued: true }
  );
  assert.notEqual(executionRecovery.status, 'queued');
  assert.equal((await store.get(passiveTaskId)).activeOperation?.operationId, recoveryOperation);

  console.log('coding task runner smoke: ok');
} finally {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(temp, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY'].includes(error?.code) || attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitFor(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for runner state');
}

async function readLaunchCount() {
  try { return Number.parseInt(await fs.readFile(fakeLaunchCount, 'utf8'), 10) || 0; }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
}
