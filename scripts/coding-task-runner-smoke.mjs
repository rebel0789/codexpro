import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task-runner-'));
let dataRoot = path.join(temp, 'data');
let worktree = path.join(dataRoot, 'worktrees', 'task_0123456789abcdef01234567');
const fakeCodex = path.join(temp, 'fake-codex');
const fakeCodexInitFail = path.join(temp, 'fake-codex-init-fail');
const fakeLaunchCount = path.join(temp, 'fake-launch-count');

const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';
const launchCountPath = ${JSON.stringify(fakeLaunchCount)};
fs.appendFileSync(launchCountPath, String(process.pid) + '\\n');
let buffer = '';
const threadId = 'thread-smoke';
const sessionId = 'session-smoke';
let turnId = 'turn-smoke';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function turn(status = 'inProgress') { return { id: turnId, status, error: null, items: status === 'completed' ? [{ type: 'agentMessage', id: 'final', text: 'finished ' + turnId + ' sk-1234567890SECRET', phase: 'final_answer' }] : [] }; }
function handle(message) {
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId || threadId, sessionId, ephemeral: false } } });
  if (message.method === 'turn/start') {
    turnId = message.params.clientUserMessageId === 'run-two' ? 'turn-two' :
      message.params.clientUserMessageId === 'continuation-retry-success' ? 'turn-retry' :
      message.params.clientUserMessageId === 'continuation-duplicate-turn' ? 'turn-retry' :
      message.params.clientUserMessageId === 'failure-after-turn' ? 'turn-failed' :
      message.params.clientUserMessageId === 'failure-timeout' ? 'turn-timeout' : 'turn-smoke';
    if (message.params.clientUserMessageId === 'failure-unknown') process.exit(87);
    send({ id: message.id, result: { turn: turn() } });
    if (turnId === 'turn-two' || turnId === 'turn-retry') setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: turn('completed') } }), 10);
    if (turnId === 'turn-failed') setTimeout(() => send({ method: 'turn/completed', params: { threadId, turn: turn('failed') } }), 10);
    return;
  }
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
const fakeInitFailSource = `#!/usr/bin/env node
process.stdin.once('data', () => process.exit(86));
process.stdin.resume();
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
  await fs.writeFile(fakeCodexInitFail, fakeInitFailSource, { mode: 0o755 });
  const { CodingTaskStore } = await import(pathToFileURL(path.join(root, 'dist', 'codingTaskStore.js')).href);
  const { beginCodingTaskOperation, requestCodingTaskCancellation } = await import(pathToFileURL(path.join(root, 'dist', 'codingTaskOps.js')).href);
  const { launchCodingTaskRun, waitForCodingTaskRun, submitCodingTaskFollowup, submitCodingTaskContinuation, getCodingTaskContinuation, getCodingTaskSteer, getCodingTaskRun, reconcileCodingTaskRun, cancelQueuedCodingTaskRun, holdCodingTaskRunLockForTest } = await import(
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
  assert.equal((await getCodingTaskRun({ dataRoot }, taskId, 'run-one')).runnerAlive, true,
    'live runner metadata must report the exact held lock generation');
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
  assert.equal(finished.finalText, 'finished turn-smoke [REDACTED_SECRET]');
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

  const continuationInput = {
    requestKey: 'turn-two-request', operationId: 'run-two', turnOrdinal: 2,
    previousOperationId: 'run-one', prompt: 'Perform the bounded second turn.',
    expectedRevision: completedTask.revision, executorEpoch: completedTask.executorLease.epoch,
    leaseId: completedTask.executorLease.leaseId, expectedThreadId: completedTask.codexThreadId,
    expectedSessionId: completedTask.codexSessionId, expectedPreviousTurnId: completedTask.codexTurnId,
    model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  };
  const rejectedContinuationKey = 'turn-two-authority-rejected';
  const rejectedContinuationPath = path.join(taskDirFor(taskId, dataRoot), 'continuations',
    `request_${createHash('sha256').update(rejectedContinuationKey).digest('hex').slice(0, 32)}`);
  const taskBeforeRejectedContinuation = await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json'));
  const launchesBeforeRejectedContinuation = await readLaunchCount();
  await assert.rejects(
    submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
      { ...continuationInput, requestKey: rejectedContinuationKey, expectedSessionId: 'session-wrong' }),
    /thread, session, or previous turn identity changed/
  );
  assert.equal(await fs.stat(rejectedContinuationPath).catch(() => undefined), undefined,
    'failed continuation authority must not create its decision directory');
  assert.deepEqual(await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json')),
    taskBeforeRejectedContinuation, 'failed continuation authority must not mutate the task');
  assert.equal(await readLaunchCount(), launchesBeforeRejectedContinuation,
    'failed continuation authority must not launch App Server');
  const missingSessionInput = { ...continuationInput, requestKey: `${rejectedContinuationKey}-missing` };
  delete missingSessionInput.expectedSessionId;
  const missingSessionPath = path.join(taskDirFor(taskId, dataRoot), 'continuations',
    `request_${createHash('sha256').update(missingSessionInput.requestKey).digest('hex').slice(0, 32)}`);
  await assert.rejects(
    submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, missingSessionInput),
    /expectedSessionId is required/
  );
  assert.equal(await fs.stat(missingSessionPath).catch(() => undefined), undefined,
    'missing session authority must fail before decision storage');
  const continuation = await submitCodingTaskContinuation(
    { dataRoot, codexBinary: fakeCodex }, taskId, continuationInput
  );
  assert.equal(continuation.reused, false);
  assert.equal(continuation.decision.turnOrdinal, 2);
  assert.equal(continuation.decision.previousOperationId, 'run-one');
  assert.equal(continuation.decision.expectedThreadId, 'thread-smoke');
  assert.equal(continuation.decision.expectedSessionId, 'session-smoke');
  assert.equal(continuation.decision.expectedPreviousTurnId, 'turn-smoke');
  const turnTwo = await waitForCodingTaskRun({ dataRoot }, taskId, 'run-two', { timeoutMs: 5_000 });
  assert.equal(turnTwo.status, 'waiting_review');
  assert.equal(turnTwo.threadId, 'thread-smoke');
  assert.equal(turnTwo.sessionId, 'session-smoke');
  assert.equal(turnTwo.turnId, 'turn-two');
  assert.equal(turnTwo.finalText, 'finished turn-two [REDACTED_SECRET]');
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);
  const continuationView = await getCodingTaskContinuation({ dataRoot }, taskId, 'turn-two-request');
  assert.equal(continuationView.decision.fingerprint, continuation.decision.fingerprint);
  assert.equal(continuationView.run.operationId, 'run-two');
  const continuationRetry = await submitCodingTaskContinuation(
    { dataRoot, codexBinary: fakeCodex }, taskId, continuationInput
  );
  assert.equal(continuationRetry.reused, true);
  assert.equal(continuationRetry.decision.fingerprint, continuation.decision.fingerprint);
  assert.equal(continuationRetry.run.turnId, 'turn-two');
  await assert.rejects(
    submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
      { ...continuationInput, prompt: 'tampered continuation prompt' }),
    /continuation decision identity|different continuation contract/
  );
  assert.equal(await readLaunchCount(), 2, 'response-loss retry and conflicting continuation must not start a fresh App Server');
  const continuationDecisionPath = path.join(taskDirFor(taskId, dataRoot), 'continuations',
    `request_${createHash('sha256').update('turn-two-request').digest('hex').slice(0, 32)}`, 'decision.json');
  const pristineDecision = await fs.readFile(continuationDecisionPath, 'utf8');
  const decisionTamperCases = [
    (value) => { value.version = 2; },
    (value) => { value.taskId = 'task_999999999999999999999999'; },
    (value) => { value.requestKey = 'turn-two-request-tampered'; },
    (value) => { value.fingerprint = 'f'.repeat(64); },
    (value) => { value.prompt = 'tampered persisted prompt'; },
    (value) => { value.expectedThreadId = 'thread-tampered'; },
    (value) => { value.expectedPreviousTurnId = 'turn-tampered'; },
    (value) => { value.turnOrdinal = 3; },
    (value) => { value.operationId = 'run-three'; },
    (value) => { value.previousOperationId = 'run-zero'; },
    (value) => { value.expectedRevision += 1; },
    (value) => { value.executorEpoch += 1; },
    (value) => { value.leaseId = 'lease-tampered'; },
    (value) => { value.expectedSessionId = 'session-tampered'; },
    (value) => { value.model = 'gpt-tampered'; },
    (value) => { value.effort = 'low'; },
    (value) => { value.timeoutMs += 1_000; },
    (value) => { value.createdAt = new Date(Date.parse(value.createdAt) + 1_000).toISOString(); }
  ];
  for (const tamper of decisionTamperCases) {
    const changed = JSON.parse(pristineDecision); tamper(changed);
    await fs.writeFile(continuationDecisionPath, JSON.stringify(changed), { mode: 0o600 });
    const launchesBeforeTamper = await readLaunchCount();
    const taskBytesBeforeTamper = await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json'));
    await assert.rejects(
      submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, continuationInput),
      /continuation decision identity or fingerprint mismatch/
    );
    assert.equal(await readLaunchCount(), launchesBeforeTamper);
    assert.deepEqual(await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json')), taskBytesBeforeTamper);
    await fs.writeFile(continuationDecisionPath, pristineDecision, { mode: 0o600 });
  }
  const runTwoToken = `run_${createHash('sha256').update('run-two').digest('hex').slice(0, 32)}`;
  const runTwoDefinitionPath = path.join(taskDirFor(taskId, dataRoot), 'runs', runTwoToken, 'definition.json');
  const pristineRunTwoDefinition = await fs.readFile(runTwoDefinitionPath, 'utf8');
  const definitionTamperCases = [
    (value) => { value.version = 2; },
    (value) => { value.taskId = 'task_999999999999999999999999'; },
    (value) => { value.operationId = 'run-three'; },
    (value) => { value.fingerprint = 'f'.repeat(64); },
    (value) => { value.prompt = 'tampered definition prompt'; },
    (value) => { value.threadId = 'thread-tampered'; },
    (value) => { value.expectedSessionId = 'session-tampered'; },
    (value) => { value.continuationFingerprint = 'a'.repeat(64); },
    (value) => { value.expectedPreviousTurnId = 'turn-tampered'; },
    (value) => { value.expectedRevision += 1; },
    (value) => { value.executorEpoch += 1; },
    (value) => { value.leaseId = 'lease-tampered'; },
    (value) => { value.model = 'gpt-tampered'; },
    (value) => { value.effort = 'low'; },
    (value) => { value.timeoutMs += 1_000; },
    (value) => { value.worktreeRoot = `${value.worktreeRoot}-tampered`; },
    (value) => { value.codexBinary = `${value.codexBinary}-tampered`; },
    (value) => { value.maxLogBytes += 1; },
    (value) => { value.createdAt = new Date(Date.parse(value.createdAt) + 1_000).toISOString(); }
  ];
  for (const tamper of definitionTamperCases) {
    const tamperedRunDefinition = JSON.parse(pristineRunTwoDefinition); tamper(tamperedRunDefinition);
    await fs.writeFile(runTwoDefinitionPath, JSON.stringify(tamperedRunDefinition), { mode: 0o600 });
    const launchesBeforeDefinitionTamper = await readLaunchCount();
    const taskBytesBeforeDefinitionTamper = await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json'));
    await assert.rejects(getCodingTaskRun({ dataRoot }, taskId, 'run-two'),
      /run definition identity mismatch|tampered run fingerprint/);
    assert.equal(await readLaunchCount(), launchesBeforeDefinitionTamper);
    assert.deepEqual(await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json')),
      taskBytesBeforeDefinitionTamper);
    await fs.writeFile(runTwoDefinitionPath, pristineRunTwoDefinition, { mode: 0o600 });
  }

  // Crash-safe publication: an empty run directory and a definition-only run are both recoverable,
  // while the task lock plus launch marker permits exactly one detached App Server launch.
  const emptyPublicationTask = await store.get(taskId);
  const emptyPublicationOperation = 'publication-empty-dir';
  const emptyPublicationInput = {
    operationId: emptyPublicationOperation, prompt: 'Recover an empty publication directory.',
    expectedRevision: emptyPublicationTask.revision, executorEpoch: emptyPublicationTask.executorLease.epoch,
    leaseId: emptyPublicationTask.executorLease.leaseId, threadId: emptyPublicationTask.codexThreadId,
    expectedSessionId: emptyPublicationTask.codexSessionId, timeoutMs: 5_000
  };
  const emptyPublicationDir = path.join(taskDirFor(taskId, dataRoot), 'runs',
    `run_${createHash('sha256').update(emptyPublicationOperation).digest('hex').slice(0, 32)}`);
  await fs.mkdir(emptyPublicationDir, { recursive: true, mode: 0o700 });
  const staleDefinitionTemp = path.join(emptyPublicationDir,
    `definition.json.999999.01234567-89ab-cdef-0123-456789abcdef.tmp`);
  await fs.writeFile(staleDefinitionTemp, '{"partial":', { mode: 0o600 });
  const launchesBeforeEmptyPublication = await readLaunchCount();
  const emptyPublicationResults = await Promise.all(Array.from({ length: 12 }, () =>
    launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, emptyPublicationInput)));
  assert(emptyPublicationResults.every((result) => result.operationId === emptyPublicationOperation));
  await waitFor(async () => (await readLaunchCount()) >= launchesBeforeEmptyPublication + 1);
  await waitFor(async () => {
    const view = await getCodingTaskRun({ dataRoot }, taskId, emptyPublicationOperation);
    return view.status !== 'queued';
  });
  const emptyPublicationStarted = await getCodingTaskRun({ dataRoot }, taskId, emptyPublicationOperation);
  assert.equal(emptyPublicationStarted.status, 'running', JSON.stringify(emptyPublicationStarted, null, 2));
  await waitFor(async () => (await store.get(taskId)).activeOperation?.operationId === emptyPublicationOperation &&
    (await store.get(taskId)).codexTurnActive);
  assert.equal(await readLaunchCount(), launchesBeforeEmptyPublication + 1,
    'concurrent empty-directory recovery must launch one App Server');
  assert.equal(await fs.stat(staleDefinitionTemp).catch(() => undefined), undefined,
    'stale atomic definition temp must be reclaimed under publication authority');
  await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'finish-publication-empty', prompt: 'Finish empty publication recovery.', timeoutMs: 5_000
  });
  await waitForCodingTaskRun({ dataRoot }, taskId, emptyPublicationOperation, { timeoutMs: 5_000 });
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  const definitionOnlyTask = await store.get(taskId);
  const definitionOnlyOperation = 'publication-definition-only';
  const definitionOnlyInput = {
    operationId: definitionOnlyOperation, prompt: 'Recover a definition-only publication.',
    expectedRevision: definitionOnlyTask.revision, executorEpoch: definitionOnlyTask.executorLease.epoch,
    leaseId: definitionOnlyTask.executorLease.leaseId, threadId: definitionOnlyTask.codexThreadId,
    expectedSessionId: definitionOnlyTask.codexSessionId, timeoutMs: 5_000
  };
  const definitionOnlyDir = path.join(taskDirFor(taskId, dataRoot), 'runs',
    `run_${createHash('sha256').update(definitionOnlyOperation).digest('hex').slice(0, 32)}`);
  const definitionOnlyCreatedAt = new Date().toISOString();
  const definitionOnlyDefinition = withRunFingerprint({
    version: 1, taskId, operationId: definitionOnlyOperation, prompt: definitionOnlyInput.prompt,
    expectedRevision: definitionOnlyInput.expectedRevision, executorEpoch: definitionOnlyInput.executorEpoch,
    leaseId: definitionOnlyInput.leaseId, worktreeRoot: definitionOnlyTask.worktreeRoot,
    codexBinary: fakeCodex, threadId: definitionOnlyInput.threadId,
    expectedSessionId: definitionOnlyInput.expectedSessionId, model: 'gpt-5.6-sol', effort: 'high',
    timeoutMs: 5_000, maxLogBytes: 2 * 1024 * 1024, createdAt: definitionOnlyCreatedAt
  });
  await fs.mkdir(definitionOnlyDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(definitionOnlyDir, 'definition.json'), JSON.stringify(definitionOnlyDefinition), { mode: 0o600 });
  const staleStateTemp = path.join(definitionOnlyDir,
    `state.json.999999.01234567-89ab-cdef-0123-456789abcdef.tmp`);
  await fs.writeFile(staleStateTemp, '{"partial":', { mode: 0o600 });
  const launchesBeforeDefinitionOnly = await readLaunchCount();
  process.env.CODEXPRO_RUNNER_SMOKE = '1';
  process.env.CODEXPRO_RUNNER_HANDOFF_DELAY_MS = '500';
  const definitionOnlyLaunch = launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, definitionOnlyInput);
  await waitFor(async () => {
    const state = await fs.readFile(path.join(definitionOnlyDir, 'state.json'), 'utf8').catch(() => undefined);
    return state ? JSON.parse(state).runnerNonce?.startsWith('launch:') : false;
  });
  const handoffBarrier = holdCodingTaskRunLockForTest({ dataRoot }, taskId, definitionOnlyOperation, 750);
  const definitionOnlyResults = await Promise.all([
    definitionOnlyLaunch, handoffBarrier.then(() => getCodingTaskRun({ dataRoot }, taskId, definitionOnlyOperation))
  ]);
  delete process.env.CODEXPRO_RUNNER_SMOKE;
  delete process.env.CODEXPRO_RUNNER_HANDOFF_DELAY_MS;
  assert(definitionOnlyResults.every((result) => result.operationId === definitionOnlyOperation));
  await waitFor(async () => (await readLaunchCount()) >= launchesBeforeDefinitionOnly + 1, 12_000);
  await waitFor(async () => (await store.get(taskId)).activeOperation?.operationId === definitionOnlyOperation &&
    (await store.get(taskId)).codexTurnActive, 12_000);
  assert.equal(await readLaunchCount(), launchesBeforeDefinitionOnly + 1,
    'concurrent definition-only recovery must launch one App Server');
  assert.equal(await fs.stat(staleStateTemp).catch(() => undefined), undefined,
    'stale atomic state temp must be reclaimed under publication authority');
  await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'finish-publication-definition', prompt: 'Finish definition publication recovery.', timeoutMs: 5_000
  });
  await waitForCodingTaskRun({ dataRoot }, taskId, definitionOnlyOperation, { timeoutMs: 5_000 });
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  // A child that exhausts the launch-lock handoff must exit without writing. Cancellation written
  // under exact task authority while the lock is held remains byte-for-byte authoritative.
  const timeoutCancelTask = await store.get(taskId);
  const timeoutCancelOperation = 'handoff-timeout-cancel';
  const timeoutCancelInput = {
    operationId: timeoutCancelOperation, prompt: 'Lose the handoff lock without mutating cancellation.',
    expectedRevision: timeoutCancelTask.revision, executorEpoch: timeoutCancelTask.executorLease.epoch,
    leaseId: timeoutCancelTask.executorLease.leaseId, threadId: timeoutCancelTask.codexThreadId,
    expectedSessionId: timeoutCancelTask.codexSessionId, timeoutMs: 5_000
  };
  const timeoutCancelDir = path.join(taskDirFor(taskId, dataRoot), 'runs',
    `run_${createHash('sha256').update(timeoutCancelOperation).digest('hex').slice(0, 32)}`);
  const timeoutCancelCreatedAt = new Date().toISOString();
  const timeoutCancelDefinition = withRunFingerprint({
    version: 1, taskId, operationId: timeoutCancelOperation, prompt: timeoutCancelInput.prompt,
    expectedRevision: timeoutCancelInput.expectedRevision, executorEpoch: timeoutCancelInput.executorEpoch,
    leaseId: timeoutCancelInput.leaseId, worktreeRoot: timeoutCancelTask.worktreeRoot,
    codexBinary: fakeCodex, threadId: timeoutCancelInput.threadId,
    expectedSessionId: timeoutCancelInput.expectedSessionId, model: 'gpt-5.6-sol', effort: 'high',
    timeoutMs: 5_000, maxLogBytes: 2 * 1024 * 1024, createdAt: timeoutCancelCreatedAt
  });
  await fs.mkdir(timeoutCancelDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(timeoutCancelDir, 'definition.json'), JSON.stringify(timeoutCancelDefinition), { mode: 0o600 });
  process.env.CODEXPRO_RUNNER_SMOKE = '1';
  process.env.CODEXPRO_RUNNER_HANDOFF_DELAY_MS = '300';
  process.env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS = '200';
  const timeoutLaunch = launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, timeoutCancelInput);
  await waitFor(async () => {
    const state = await fs.readFile(path.join(timeoutCancelDir, 'state.json'), 'utf8').catch(() => undefined);
    return state ? JSON.parse(state).runnerNonce?.startsWith('launch:') : false;
  });
  const timeoutBarrier = holdCodingTaskRunLockForTest({ dataRoot }, taskId, timeoutCancelOperation, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const canceledTimeoutRun = await cancelQueuedCodingTaskRun({ dataRoot }, taskId, timeoutCancelOperation,
    'cancel wins after child handoff timeout');
  assert.equal(canceledTimeoutRun.status, 'canceled');
  assert.equal(canceledTimeoutRun.failure.code, 'canceled');
  assert.equal(canceledTimeoutRun.failure.retryable, false);
  assert.equal(canceledTimeoutRun.failure.outcomeKnown, true);
  const canceledRunBytes = await fs.readFile(path.join(timeoutCancelDir, 'state.json'));
  const canceledTaskBytes = await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json'));
  await timeoutBarrier;
  assert.equal((await timeoutLaunch).status, 'canceled');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await fs.readFile(path.join(timeoutCancelDir, 'state.json')), canceledRunBytes,
    'losing child must not revert terminal canceled run bytes');
  assert.deepEqual(await fs.readFile(path.join(taskDirFor(taskId, dataRoot), 'state.json')), canceledTaskBytes,
    'losing child must not mutate the authoritative task after cancellation');
  delete process.env.CODEXPRO_RUNNER_SMOKE;
  delete process.env.CODEXPRO_RUNNER_HANDOFF_DELAY_MS;
  delete process.env.CODEXPRO_RUNNER_HANDOFF_TIMEOUT_MS;

  const ambiguousTask = await store.get(taskId);
  const ambiguousOperation = 'publication-ambiguous-empty';
  const ambiguousDir = path.join(taskDirFor(taskId, dataRoot), 'runs',
    `run_${createHash('sha256').update(ambiguousOperation).digest('hex').slice(0, 32)}`);
  await fs.mkdir(ambiguousDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(ambiguousDir, 'unknown-artifact'), 'preserve me', { mode: 0o600 });
  const launchesBeforeAmbiguous = await readLaunchCount();
  await assert.rejects(launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: ambiguousOperation, prompt: 'Must not overwrite ambiguous publication state.',
    expectedRevision: ambiguousTask.revision, executorEpoch: ambiguousTask.executorLease.epoch,
    leaseId: ambiguousTask.executorLease.leaseId, threadId: ambiguousTask.codexThreadId,
    expectedSessionId: ambiguousTask.codexSessionId, timeoutMs: 5_000
  }), /contains ambiguous artifacts/);
  assert.equal(await fs.readFile(path.join(ambiguousDir, 'unknown-artifact'), 'utf8'), 'preserve me');
  assert.equal(await readLaunchCount(), launchesBeforeAmbiguous);

  // Structured retry authority: only a runner-proven failure before initialize/thread/turn request
  // publication is retryable. The attempt-start Git observation is persisted by the runner.
  const retryableTask = await store.get(taskId);
  const retryableOperation = 'failure-before-initialize';
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodexInitFail }, taskId, {
    operationId: retryableOperation, prompt: 'Fail before initialize request publication.',
    expectedRevision: retryableTask.revision, executorEpoch: retryableTask.executorLease.epoch,
    leaseId: retryableTask.executorLease.leaseId, threadId: retryableTask.codexThreadId,
    expectedSessionId: retryableTask.codexSessionId, timeoutMs: 5_000
  });
  const retryableFailureRun = await waitForCodingTaskRun({ dataRoot }, taskId, retryableOperation, { timeoutMs: 5_000 });
  assert.equal(retryableFailureRun.status, 'failed');
  assert.equal(retryableFailureRun.failure.code, 'app_server_initialize_transport');
  assert.equal(retryableFailureRun.failure.category, 'infrastructure');
  assert.equal(retryableFailureRun.failure.retryable, true);
  assert.equal(retryableFailureRun.failure.outcomeKnown, true);
  assert.equal(retryableFailureRun.failure.turnStarted, false);
  assert.equal(retryableFailureRun.failure.summarySha256,
    createHash('sha256').update(retryableFailureRun.failure.summary).digest('hex'));
  assert.equal(retryableFailureRun.threadEstablishRequestedAt, undefined);
  assert.equal(retryableFailureRun.turnStartRequestedAt, undefined);
  assert(retryableFailureRun.attemptStartGitObservation?.headSha);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);
  assert.equal((await store.get(taskId)).lastGitObservation.diffSha256,
    retryableFailureRun.attemptStartGitObservation.diffSha256,
    'retryable pre-turn infrastructure failure must leave the attempt Git observation unchanged');
  const retryableRunDir = path.join(taskDirFor(taskId, dataRoot), 'runs',
    `run_${createHash('sha256').update(retryableOperation).digest('hex').slice(0, 32)}`);
  const retryableStatePath = path.join(retryableRunDir, 'state.json');
  const pristineFailureState = await fs.readFile(retryableStatePath, 'utf8');
  const tamperedFailureState = JSON.parse(pristineFailureState);
  tamperedFailureState.failure.retryable = false;
  await fs.writeFile(retryableStatePath, JSON.stringify(tamperedFailureState), { mode: 0o600 });
  await assert.rejects(getCodingTaskRun({ dataRoot }, taskId, retryableOperation), /failure classification is invalid or tampered/);
  tamperedFailureState.failure.retryable = true;
  tamperedFailureState.failure.category = 'model_or_tool';
  await fs.writeFile(retryableStatePath, JSON.stringify(tamperedFailureState), { mode: 0o600 });
  await assert.rejects(getCodingTaskRun({ dataRoot }, taskId, retryableOperation), /failure classification is invalid or tampered/);
  tamperedFailureState.failure.category = 'infrastructure';
  tamperedFailureState.failure.phase = 'turn_active';
  await fs.writeFile(retryableStatePath, JSON.stringify(tamperedFailureState), { mode: 0o600 });
  await assert.rejects(getCodingTaskRun({ dataRoot }, taskId, retryableOperation), /failure classification is invalid or tampered/);
  await fs.writeFile(retryableStatePath, pristineFailureState, { mode: 0o600 });
  const retryTask = await store.get(taskId);
  const launchesBeforeRetryMismatch = await readLaunchCount();
  await assert.rejects(launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: 'failure-before-initialize-retry-wrong-thread', prompt: 'Fail before initialize request publication.',
    expectedRevision: retryTask.revision, executorEpoch: retryTask.executorLease.epoch,
    leaseId: retryTask.executorLease.leaseId, threadId: 'thread-wrong',
    expectedSessionId: retryTask.codexSessionId, model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  }), /thread does not match/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryMismatch, 'retry authority mismatch must launch nothing');
  const priorAttemptBytes = await fs.readFile(retryableStatePath);
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: 'failure-before-initialize-retry', prompt: 'Fail before initialize request publication.',
    expectedRevision: retryTask.revision, executorEpoch: retryTask.executorLease.epoch,
    leaseId: retryTask.executorLease.leaseId, threadId: retryTask.codexThreadId,
    expectedSessionId: retryTask.codexSessionId, model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  });
  await waitFor(async () => (await store.get(taskId)).activeOperation?.operationId === 'failure-before-initialize-retry' &&
    (await store.get(taskId)).codexTurnActive);
  await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, taskId, {
    requestKey: 'finish-fresh-retry', prompt: 'Finish the distinct retry operation.', timeoutMs: 5_000
  });
  const freshRetryRun = await waitForCodingTaskRun({ dataRoot }, taskId, 'failure-before-initialize-retry', { timeoutMs: 5_000 });
  assert.equal(freshRetryRun.status, 'waiting_review');
  assert.equal(freshRetryRun.threadId, retryTask.codexThreadId);
  assert.equal(freshRetryRun.sessionId, retryTask.codexSessionId);
  assert.deepEqual(await fs.readFile(retryableStatePath), priorAttemptBytes,
    'fresh retry must preserve the prior failed attempt artifact');
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  // Continuation attempt retry preserves the semantic predecessor while binding the immediate
  // failed attempt and its immutable continuation decision.
  const semanticTask = await store.get(taskId);
  const failedContinuationInput = {
    requestKey: 'continuation-retry-attempt-zero', operationId: 'continuation-retry-failed', turnOrdinal: 3,
    previousOperationId: 'failure-before-initialize-retry', prompt: 'Retry this exact semantic continuation.',
    expectedRevision: semanticTask.revision, executorEpoch: semanticTask.executorLease.epoch,
    leaseId: semanticTask.executorLease.leaseId, expectedThreadId: semanticTask.codexThreadId,
    expectedSessionId: semanticTask.codexSessionId, expectedPreviousTurnId: semanticTask.codexTurnId,
    model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  };
  await submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodexInitFail }, taskId, failedContinuationInput);
  const failedContinuation = await waitForCodingTaskRun({ dataRoot }, taskId, 'continuation-retry-failed', { timeoutMs: 5_000 });
  assert.equal(failedContinuation.failure.retryable, true);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);
  const retryContinuationTask = await store.get(taskId);
  const retryContinuationInput = {
    ...failedContinuationInput, requestKey: 'continuation-retry-attempt-one',
    operationId: 'continuation-retry-success', expectedRevision: retryContinuationTask.revision,
    retryPreviousAttemptOperationId: 'continuation-retry-failed'
  };
  const launchesBeforeRetryAuthority = await readLaunchCount();
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
    { ...retryContinuationInput, requestKey: 'continuation-retry-wrong', retryPreviousAttemptOperationId: 'failure-unknown' }),
  /retry predecessor identity changed|unchanged canonical pre-turn/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority);
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
    { ...retryContinuationInput, requestKey: 'continuation-retry-missing', retryPreviousAttemptOperationId: undefined }),
  /previous operation identity changed/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority);

  const failedContinuationToken = `run_${createHash('sha256').update('continuation-retry-failed').digest('hex').slice(0, 32)}`;
  const failedContinuationStatePath = path.join(taskDirFor(taskId, dataRoot), 'runs', failedContinuationToken, 'state.json');
  const pristineFailedContinuationState = await fs.readFile(failedContinuationStatePath, 'utf8');
  const nonretryableFailedContinuation = JSON.parse(pristineFailedContinuationState);
  Object.assign(nonretryableFailedContinuation.failure, {
    code: 'unknown', category: 'unknown', phase: 'unknown', retryable: false
  });
  await fs.writeFile(failedContinuationStatePath, JSON.stringify(nonretryableFailedContinuation), { mode: 0o600 });
  const nonretryableRequest = { ...retryContinuationInput, requestKey: 'continuation-retry-nonretryable' };
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, nonretryableRequest),
    /unchanged canonical pre-turn infrastructure failure/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority,
    'a canonical nonretryable predecessor must launch nothing');
  assert.equal(await fs.stat(continuationLedgerPath(taskId, dataRoot, nonretryableRequest.requestKey)).catch(() => undefined),
    undefined, 'nonretryable predecessor must fail before decision publication');

  const dirtyFailedContinuation = JSON.parse(pristineFailedContinuationState);
  dirtyFailedContinuation.attemptStartGitObservation.diffSha256 =
    dirtyFailedContinuation.attemptStartGitObservation.diffSha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  await fs.writeFile(failedContinuationStatePath, JSON.stringify(dirtyFailedContinuation), { mode: 0o600 });
  const dirtyRequest = { ...retryContinuationInput, requestKey: 'continuation-retry-dirty' };
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, dirtyRequest),
    /unchanged canonical pre-turn infrastructure failure/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority,
    'a predecessor with changed Git authority must launch nothing');
  assert.equal(await fs.stat(continuationLedgerPath(taskId, dataRoot, dirtyRequest.requestKey)).catch(() => undefined),
    undefined, 'dirty predecessor must fail before decision publication');
  await fs.writeFile(failedContinuationStatePath, pristineFailedContinuationState, { mode: 0o600 });

  const taskStatePath = path.join(taskDirFor(taskId, dataRoot), 'state.json');
  const pristineRetryTaskState = await fs.readFile(taskStatePath, 'utf8');
  const activeRetryTaskState = JSON.parse(pristineRetryTaskState);
  const activeAt = new Date().toISOString();
  activeRetryTaskState.activeOperation = {
    operationId: 'continuation-retry-active-blocker', executor: 'codex', kind: 'codex_run',
    startedAt: activeAt, heartbeatAt: activeAt, pid: process.pid, requestFingerprint: 'a'.repeat(64)
  };
  await fs.writeFile(taskStatePath, JSON.stringify(activeRetryTaskState), { mode: 0o600 });
  const activeRequest = { ...retryContinuationInput, requestKey: 'continuation-retry-active' };
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, activeRequest),
    /requires an idle task/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority,
    'an active predecessor task must launch nothing');
  assert.equal(await fs.stat(continuationLedgerPath(taskId, dataRoot, activeRequest.requestKey)).catch(() => undefined),
    undefined, 'active predecessor must fail before decision publication');
  await fs.writeFile(taskStatePath, pristineRetryTaskState, { mode: 0o600 });

  const continuationAttemptRetry = await submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
    retryContinuationInput);
  assert.equal(continuationAttemptRetry.decision.retryPreviousAttemptOperationId, 'continuation-retry-failed');
  const continuationRetryRun = await waitForCodingTaskRun({ dataRoot }, taskId, 'continuation-retry-success', { timeoutMs: 5_000 });
  assert.equal(continuationRetryRun.status, 'waiting_review');
  assert.equal(continuationRetryRun.threadId, retryContinuationInput.expectedThreadId);
  assert.equal(continuationRetryRun.sessionId, retryContinuationInput.expectedSessionId);
  const retryDecisionPath = path.join(continuationLedgerPath(taskId, dataRoot, retryContinuationInput.requestKey), 'decision.json');
  const pristineRetryDecision = await fs.readFile(retryDecisionPath, 'utf8');
  const tamperedRetryDecision = JSON.parse(pristineRetryDecision);
  tamperedRetryDecision.retryPreviousAttemptOperationId = 'continuation-retry-tampered';
  await fs.writeFile(retryDecisionPath, JSON.stringify(tamperedRetryDecision), { mode: 0o600 });
  const launchesBeforeRetryDecisionTamper = await readLaunchCount();
  await assert.rejects(submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
    retryContinuationInput), /continuation decision identity or fingerprint mismatch/);
  assert.equal(await readLaunchCount(), launchesBeforeRetryDecisionTamper,
    'a tampered retry decision must launch nothing');
  await fs.writeFile(retryDecisionPath, pristineRetryDecision, { mode: 0o600 });
  const continuationRetryReplay = await submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId,
    retryContinuationInput);
  assert.equal(continuationRetryReplay.reused, true);
  assert.equal(continuationRetryReplay.decision.fingerprint, continuationAttemptRetry.decision.fingerprint);
  assert.equal(await readLaunchCount(), launchesBeforeRetryAuthority + 1);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  const duplicateTurnTask = await store.get(taskId);
  const duplicateTurnInput = {
    requestKey: 'continuation-duplicate-turn-request', operationId: 'continuation-duplicate-turn', turnOrdinal: 4,
    previousOperationId: 'continuation-retry-success', prompt: 'Return a distinct continuation turn identity.',
    expectedRevision: duplicateTurnTask.revision, executorEpoch: duplicateTurnTask.executorLease.epoch,
    leaseId: duplicateTurnTask.executorLease.leaseId, expectedThreadId: duplicateTurnTask.codexThreadId,
    expectedSessionId: duplicateTurnTask.codexSessionId, expectedPreviousTurnId: duplicateTurnTask.codexTurnId,
    model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000
  };
  assert.equal(duplicateTurnInput.expectedPreviousTurnId, 'turn-retry');
  const duplicateTurnLaunches = await readLaunchCount();
  await submitCodingTaskContinuation({ dataRoot, codexBinary: fakeCodex }, taskId, duplicateTurnInput);
  const duplicateTurnRun = await waitForCodingTaskRun({ dataRoot }, taskId, 'continuation-duplicate-turn', { timeoutMs: 5_000 });
  assert.equal(duplicateTurnRun.status, 'failed', 'a replayed prior turn ID must not become semantic success');
  assert.equal(duplicateTurnRun.failure.code, 'identity_mismatch');
  assert.equal(duplicateTurnRun.failure.category, 'identity');
  assert.equal(duplicateTurnRun.failure.retryable, false);
  assert.equal(duplicateTurnRun.failure.turnStarted, true);
  assert.equal(duplicateTurnRun.turnId, duplicateTurnInput.expectedPreviousTurnId);
  assert.equal(await readLaunchCount(), duplicateTurnLaunches + 1);
  await waitFor(async () => {
    const state = await store.get(taskId);
    return state.activeOperation === undefined && state.lifecycle === 'failed' &&
      state.lastCompletedOperation?.operationId === 'continuation-duplicate-turn';
  });

  const afterTurnTask = await store.get(taskId);
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: 'failure-after-turn', prompt: 'Return an authoritative failed turn.',
    expectedRevision: afterTurnTask.revision, executorEpoch: afterTurnTask.executorLease.epoch,
    leaseId: afterTurnTask.executorLease.leaseId, threadId: afterTurnTask.codexThreadId,
    expectedSessionId: afterTurnTask.codexSessionId, timeoutMs: 5_000
  });
  const afterTurnFailure = await waitForCodingTaskRun({ dataRoot }, taskId, 'failure-after-turn', { timeoutMs: 5_000 });
  assert.equal(afterTurnFailure.status, 'failed');
  assert.equal(afterTurnFailure.failure.code, 'turn_failed');
  assert.equal(afterTurnFailure.failure.retryable, false);
  assert.equal(afterTurnFailure.failure.outcomeKnown, true);
  assert.equal(afterTurnFailure.failure.turnStarted, true);
  assert(afterTurnFailure.turnStartRequestedAt);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  const timeoutTask = await store.get(taskId);
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: 'failure-timeout', prompt: 'Time out after an authoritative turn start.',
    expectedRevision: timeoutTask.revision, executorEpoch: timeoutTask.executorLease.epoch,
    leaseId: timeoutTask.executorLease.leaseId, threadId: timeoutTask.codexThreadId,
    expectedSessionId: timeoutTask.codexSessionId, timeoutMs: 1_000
  });
  const timeoutFailure = await waitForCodingTaskRun({ dataRoot }, taskId, 'failure-timeout', { timeoutMs: 5_000 });
  assert.equal(timeoutFailure.status, 'failed');
  assert.equal(timeoutFailure.failure.code, 'turn_timeout');
  assert.equal(timeoutFailure.failure.retryable, false);
  assert.equal(timeoutFailure.failure.outcomeKnown, false);
  assert.equal(timeoutFailure.failure.turnStarted, true);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  const unknownTask = await store.get(taskId);
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, taskId, {
    operationId: 'failure-unknown', prompt: 'Lose transport after turn request publication.',
    expectedRevision: unknownTask.revision, executorEpoch: unknownTask.executorLease.epoch,
    leaseId: unknownTask.executorLease.leaseId, threadId: unknownTask.codexThreadId,
    expectedSessionId: unknownTask.codexSessionId, timeoutMs: 5_000
  });
  const unknownFailure = await waitForCodingTaskRun({ dataRoot }, taskId, 'failure-unknown', { timeoutMs: 5_000 });
  assert.equal(unknownFailure.status, 'failed');
  assert.equal(unknownFailure.failure.code, 'unknown');
  assert.equal(unknownFailure.failure.retryable, false);
  assert.equal(unknownFailure.failure.outcomeKnown, false);
  assert.equal(unknownFailure.failure.turnStarted, false);
  assert(unknownFailure.turnStartRequestedAt);
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);

  const persistedFirstRun = await getCodingTaskRun({ dataRoot }, taskId, 'run-one');
  assert.equal(persistedFirstRun.status, 'waiting_review');
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
  await waitFor(async () => (await store.get(taskId)).activeOperation === undefined);
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
  const orphanDefinition = withRunFingerprint({
    version: 1, taskId, operationId: orphanOperation,
    prompt: 'orphan', expectedRevision: beforeOrphan.revision, executorEpoch: activeOrphan.executorLease.epoch,
    leaseId: 'lease-deliberately-diverged', worktreeRoot: worktree, codexBinary: fakeCodex,
    model: 'gpt-5.6-sol', effort: 'high', timeoutMs: 5_000, maxLogBytes: 64 * 1024, createdAt: orphanCreatedAt
  });
  const orphanFingerprint = orphanDefinition.fingerprint;
  await fs.writeFile(path.join(orphanDir, 'definition.json'), JSON.stringify(orphanDefinition), { mode: 0o600 });
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
  matchingOrphanDefinition.fingerprint = withRunFingerprint(matchingOrphanDefinition).fingerprint;
  await fs.writeFile(path.join(orphanDir, 'definition.json'), JSON.stringify(matchingOrphanDefinition), { mode: 0o600 });
  const matchingOrphanState = JSON.parse(await fs.readFile(path.join(orphanDir, 'state.json'), 'utf8'));
  matchingOrphanState.fingerprint = matchingOrphanDefinition.fingerprint;
  await fs.writeFile(path.join(orphanDir, 'state.json'), JSON.stringify(matchingOrphanState), { mode: 0o600 });
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
  const passiveDefinition = withRunFingerprint({
    version: 1, taskId: passiveTaskId, operationId: passiveOperation,
    prompt: 'queued orphan', expectedRevision: 1, executorEpoch: 1, leaseId: 'lease-passive',
    worktreeRoot: passiveWorktree, codexBinary: fakeCodex, model: 'gpt-5.6-sol', effort: 'high',
    timeoutMs: 5_000, maxLogBytes: 64 * 1024, createdAt: passiveNow
  });
  const passiveFingerprint = passiveDefinition.fingerprint;
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
  const recoveryDefinition = withRunFingerprint({ ...passiveDefinition, operationId: recoveryOperation });
  const recoveryFingerprint = recoveryDefinition.fingerprint;
  await fs.writeFile(path.join(recoveryDir, 'definition.json'), JSON.stringify(recoveryDefinition), { mode: 0o600 });
  await fs.writeFile(path.join(recoveryDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: recoveryOperation, fingerprint: recoveryFingerprint,
    status: 'queued', createdAt: passiveNow, updatedAt: passiveNow, events: []
  }), { mode: 0o600 });
  const executionRecovery = await reconcileCodingTaskRun(
    { dataRoot, codexBinary: fakeCodex }, passiveTaskId, recoveryOperation, { relaunchQueued: true }
  );
  assert.notEqual(executionRecovery.status, 'queued');
  assert.equal((await store.get(passiveTaskId)).activeOperation?.operationId, recoveryOperation);
  await waitFor(async () => {
    const state = await store.get(passiveTaskId);
    return state.activeOperation?.operationId === recoveryOperation && state.codexTurnActive;
  });
  const recoveryFollowup = await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, {
    requestKey: 'finish-execution-recovery', prompt: 'Finish recovered execution.', timeoutMs: 5_000
  });
  assert.equal(recoveryFollowup.mode, 'steer');
  await waitForCodingTaskRun({ dataRoot }, passiveTaskId, recoveryOperation, { timeoutMs: 5_000 });
  await waitFor(async () => (await store.get(passiveTaskId)).activeOperation === undefined);

  // Crash after begin but before the queued run-state transition: exact active identity may relaunch once.
  const beforeQueuedActive = await store.get(passiveTaskId);
  const queuedActiveOperation = 'queued-active-crash-window';
  const queuedActiveDefinition = withRunFingerprint({
    ...passiveDefinition, operationId: queuedActiveOperation,
    prompt: 'recover queued active crash', expectedRevision: beforeQueuedActive.revision,
    leaseId: beforeQueuedActive.executorLease.leaseId, createdAt: new Date().toISOString()
  });
  await beginCodingTaskOperation({ dataRoot }, passiveTaskId, {
    expectedRevision: beforeQueuedActive.revision, executor: 'codex', executorEpoch: beforeQueuedActive.executorLease.epoch,
    leaseId: beforeQueuedActive.executorLease.leaseId, operationId: queuedActiveOperation, codexRunnerPid: 999998
  });
  const queuedActiveDir = path.join(store.paths(passiveTaskId).taskDir, 'runs', `run_${createHash('sha256').update(queuedActiveOperation).digest('hex').slice(0, 32)}`);
  await fs.mkdir(queuedActiveDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(queuedActiveDir, 'definition.json'), JSON.stringify(queuedActiveDefinition), { mode: 0o600 });
  await fs.writeFile(path.join(queuedActiveDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: queuedActiveOperation, fingerprint: queuedActiveDefinition.fingerprint,
    status: 'queued', createdAt: queuedActiveDefinition.createdAt, updatedAt: queuedActiveDefinition.createdAt, events: []
  }), { mode: 0o600 });
  await fs.writeFile(path.join(queuedActiveDir, 'runner.lock'), JSON.stringify({
    version: 1, role: 'runner', taskId: passiveTaskId, operationId: queuedActiveOperation,
    fingerprint: queuedActiveDefinition.fingerprint, pid: 999996,
    nonce: 'deadbeef-dead-beef-dead-beefdeadbeef', processStartedAt: terminalCreatedFallback(),
    acquiredAt: terminalCreatedFallback(), heartbeatAt: terminalCreatedFallback()
  }), { mode: 0o600 });
  const beforeConcurrentRecoveryLaunches = await readLaunchCount();
  await Promise.all([
    reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, queuedActiveOperation, { relaunchQueued: true }),
    reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, queuedActiveOperation, { relaunchQueued: true }),
    reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, queuedActiveOperation, { relaunchQueued: true })
  ]);
  await waitFor(async () => (await getCodingTaskRun({ dataRoot }, passiveTaskId, queuedActiveOperation)).status === 'running');
  await waitFor(async () => (await readLaunchCount()) >= beforeConcurrentRecoveryLaunches + 1);
  await waitFor(async () => {
    const task = await store.get(passiveTaskId);
    return task.activeOperation?.operationId === queuedActiveOperation && task.codexTurnActive;
  });
  assert.equal(await readLaunchCount(), beforeConcurrentRecoveryLaunches + 1, 'exclusive run lock must prevent duplicate App Server launch');
  if (process.platform === 'win32') {
    await assert.rejects(fs.access(path.join(queuedActiveDir, 'runner.lock.recovery')), /ENOENT/,
      'Windows kernel lock recovery must not depend on a recursively stale recovery sentinel');
  }
  await submitCodingTaskFollowup({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, {
    requestKey: 'finish-queued-active-recovery', prompt: 'Finish queued active recovery.', timeoutMs: 5_000
  });
  await waitForCodingTaskRun({ dataRoot }, passiveTaskId, queuedActiveOperation, { timeoutMs: 5_000 });
  await waitFor(async () => (await store.get(passiveTaskId)).activeOperation === undefined);

  // Crash after terminal run persistence but before task finish: reconcile run outcome back to the task idempotently.
  const beforeTerminalRecovery = await store.get(passiveTaskId);
  const terminalOperation = 'terminal-task-writeback-crash';
  const terminalCreatedAt = new Date(Date.now() - 10_000).toISOString();
  const terminalDefinition = withRunFingerprint({
    ...passiveDefinition, operationId: terminalOperation,
    prompt: 'recover terminal writeback', expectedRevision: beforeTerminalRecovery.revision,
    leaseId: beforeTerminalRecovery.executorLease.leaseId, createdAt: terminalCreatedAt
  });
  await beginCodingTaskOperation({ dataRoot }, passiveTaskId, {
    expectedRevision: beforeTerminalRecovery.revision, executor: 'codex', executorEpoch: beforeTerminalRecovery.executorLease.epoch,
    leaseId: beforeTerminalRecovery.executorLease.leaseId, operationId: terminalOperation, codexRunnerPid: 999997
  });
  const terminalDir = path.join(store.paths(passiveTaskId).taskDir, 'runs', `run_${createHash('sha256').update(terminalOperation).digest('hex').slice(0, 32)}`);
  await fs.mkdir(terminalDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(terminalDir, 'definition.json'), JSON.stringify(terminalDefinition), { mode: 0o600 });
  await fs.writeFile(path.join(terminalDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: terminalOperation, fingerprint: terminalDefinition.fingerprint,
    status: 'waiting_review', createdAt: terminalCreatedAt, updatedAt: terminalCreatedAt,
    finishedAt: terminalCreatedAt, finalText: 'persisted terminal outcome', events: []
  }), { mode: 0o600 });
  const terminalRecovered = await reconcileCodingTaskRun({ dataRoot }, passiveTaskId, terminalOperation);
  assert.equal(terminalRecovered.status, 'waiting_review');
  assert.equal((await store.get(passiveTaskId)).activeOperation, undefined);
  assert.equal((await store.get(passiveTaskId)).lifecycle, 'waiting_review');
  const terminalRetry = await reconcileCodingTaskRun({ dataRoot }, passiveTaskId, terminalOperation);
  assert.equal(terminalRetry.status, 'waiting_review');

  // The ordinary fake-App-Server flow above also runs on Windows and covers its generation-fenced wx fallback.
  // POSIX additionally proves that a stale informational heartbeat cannot steal a live advisory lock.
  if (process.platform !== 'win32') {
  const lockOperation = 'live-advisory-owner';
  const lockDir = path.join(store.paths(passiveTaskId).taskDir, 'runs', `run_${createHash('sha256').update(lockOperation).digest('hex').slice(0, 32)}`);
  const lockCreatedAt = new Date().toISOString();
  const lockDefinition = withRunFingerprint({ ...passiveDefinition, operationId: lockOperation,
    prompt: 'live advisory owner', expectedRevision: (await store.get(passiveTaskId)).revision, createdAt: lockCreatedAt });
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(lockDir, 'definition.json'), JSON.stringify(lockDefinition), { mode: 0o600 });
  const lockPath = path.join(lockDir, 'runner.lock');
  const lockGuardPath = path.join(lockDir, 'runner.lock.guard');
  await fs.writeFile(lockGuardPath, '', { mode: 0o600 });
  const lockHelper = spawn(process.platform === 'darwin' ? '/usr/bin/lockf' : '/usr/bin/flock', process.platform === 'darwin'
    ? ['-t', '0', lockGuardPath, process.execPath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()"]
    : ['-n', lockGuardPath, process.execPath, '-e', "process.stdout.write('LOCKED\\n');process.stdin.resume()"],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  await waitForOutput(lockHelper.stdout, 'LOCKED\n');
  const lockNonce = '12345678-1234-1234-1234-123456789abc';
  const staleHeartbeat = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(lockPath, JSON.stringify({ version: 1, role: 'runner', taskId: passiveTaskId,
    operationId: lockOperation, fingerprint: lockDefinition.fingerprint, pid: lockHelper.pid, nonce: lockNonce,
    processStartedAt: lockCreatedAt, acquiredAt: lockCreatedAt, heartbeatAt: staleHeartbeat }), { mode: 0o600 });
  await fs.writeFile(path.join(lockDir, 'state.json'), JSON.stringify({
    version: 1, taskId: passiveTaskId, operationId: lockOperation, fingerprint: lockDefinition.fingerprint,
    status: 'queued', createdAt: lockCreatedAt, updatedAt: staleHeartbeat, heartbeatAt: staleHeartbeat,
    runnerPid: lockHelper.pid, runnerNonce: lockNonce, runnerStartedAt: lockCreatedAt, events: []
  }), { mode: 0o600 });
  assert.equal((await getCodingTaskRun({ dataRoot }, passiveTaskId, lockOperation)).runnerAlive, false,
    'stale heartbeat is only an informational passive observation');
  const launchesBeforeLiveOwner = await readLaunchCount();
  const liveOwner = await reconcileCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, passiveTaskId, lockOperation, { relaunchQueued: true });
  assert.equal(liveOwner.runnerAlive, true, 'advisory lock is authoritative during active reconciliation');
  assert.equal(await readLaunchCount(), launchesBeforeLiveOwner);
  lockHelper.stdin.end();
  await new Promise((resolve) => lockHelper.once('exit', resolve));
  const reusedPidState = JSON.parse(await fs.readFile(path.join(lockDir, 'state.json'), 'utf8'));
  reusedPidState.runnerPid = process.pid;
  reusedPidState.runnerNonce = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  reusedPidState.heartbeatAt = new Date().toISOString();
  await fs.writeFile(path.join(lockDir, 'state.json'), JSON.stringify(reusedPidState), { mode: 0o600 });
  assert.equal((await getCodingTaskRun({ dataRoot }, passiveTaskId, lockOperation)).runnerAlive, false,
    'a live reused PID without the exact lock generation is not accepted');
  }

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
  try { return (await fs.readFile(fakeLaunchCount, 'utf8')).trim().split(/\n+/).filter(Boolean).length; }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
}

async function waitForOutput(stream, expected, timeoutMs = 2_000) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), timeoutMs);
    stream.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.includes(expected)) { clearTimeout(timer); resolve(); }
    });
  });
}

function terminalCreatedFallback() {
  return new Date(Date.now() - 60_000).toISOString();
}

function taskDirFor(taskId, dataRoot) {
  return path.join(dataRoot, 'tasks', taskId);
}

function continuationLedgerPath(taskId, dataRoot, requestKey) {
  return path.join(taskDirFor(taskId, dataRoot), 'continuations',
    `request_${createHash('sha256').update(requestKey).digest('hex').slice(0, 32)}`);
}

function withRunFingerprint(definition) {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    schema: 'codexpro-coding-task-run-v1', taskId: definition.taskId,
    operationId: definition.operationId, prompt: definition.prompt,
    revision: definition.expectedRevision, epoch: definition.executorEpoch,
    leaseId: definition.leaseId, threadId: definition.threadId ?? null,
    expectedSessionId: definition.expectedSessionId ?? null,
    continuationFingerprint: definition.continuationFingerprint ?? null,
    ...(definition.expectedPreviousTurnId ? { expectedPreviousTurnId: definition.expectedPreviousTurnId } : {}),
    model: definition.model, effort: definition.effort, timeoutMs: definition.timeoutMs,
    worktreeRoot: definition.worktreeRoot, codexBinary: definition.codexBinary,
    maxLogBytes: definition.maxLogBytes, createdAt: definition.createdAt
  })).digest('hex');
  return { ...definition, fingerprint };
}
