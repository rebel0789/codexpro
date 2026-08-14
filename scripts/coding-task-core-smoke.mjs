import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertDirectOwner,
  beginCodingTaskOperation,
  beginDirectOperation,
  createCodingTask,
  endCodingTaskOperation,
  finishCodingTaskOperationFenced,
  endDirectOperation,
  getCodingTask,
  heartbeatCodingTaskOperation,
  heartbeatCodingTaskOperationFenced,
  listCodingTasks,
  requestCodingTaskCancellation,
  recoverInterruptedCodingTaskOperation,
  readCodingTaskCancellation,
  resolveCodingTaskWorkspace,
  reviewCodingTask,
  transitionCodingTaskExecutor
} from '../dist/codingTaskOps.js';
import { parseCodingTaskState } from '../dist/codingTaskState.js';
import { CodingTaskStore } from '../dist/codingTaskStore.js';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function expectReject(operation, pattern) {
  await assert.rejects(operation, pattern);
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-coding-task-core-')));
const sourceRoot = path.join(fixture, 'source');
const dataRoot = path.join(fixture, 'task-data');
const config = { dataRoot, lockTimeoutMs: 2_000, staleLockMs: 5_000 };

try {
  await fs.mkdir(sourceRoot);
  await fs.mkdir(dataRoot, { mode: 0o755 });
  if (process.platform !== 'win32') await fs.chmod(dataRoot, 0o755);
  git(sourceRoot, ['init']);
  git(sourceRoot, ['config', 'user.email', 'smoke@example.test']);
  git(sourceRoot, ['config', 'user.name', 'Coding Task Smoke']);
  await fs.writeFile(path.join(sourceRoot, 'app.txt'), 'committed base\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, '.env'), 'TRACKED_SECRET=base-secret\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, ':(glob)**'), 'literal pathspec filename base\n', 'utf8');
  git(sourceRoot, ['add', '--', 'app.txt', '.env', ':(literal):(glob)**']);
  git(sourceRoot, ['commit', '-m', 'base']);
  const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']);

  // Dirty source state is observed but deliberately excluded from the detached task worktree.
  await fs.writeFile(path.join(sourceRoot, 'app.txt'), 'dirty source only\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'source-untracked.txt'), 'source dirt\n', 'utf8');
  const sourceStatusBefore = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);

  const createInput = {
    taskKey: 'smoke-core',
    title: 'Coding task core smoke',
    goal: 'Prove durable isolated task state and ownership transitions.',
    executor: 'direct',
    baseSha
  };
  const guard = {
    assertSourceWorkspace(root) {
      assert.equal(root, sourceRoot);
    }
  };
  const created = await createCodingTask(config, { root: sourceRoot }, guard, createInput);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dataRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'tasks'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'worktrees'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'tasks', created.task.taskId))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(created.task.worktreeRoot)).mode & 0o777, 0o700);
  }
  assert.equal(created.reused, false);
  assert.equal(created.task.workspaceId, `taskws_${created.task.taskId.slice(5)}`);
  assert.equal(created.task.sourceDirtyAtCreation, true);
  assert.equal(created.task.sourceStatusEntryCountAtCreation, 2);
  assert.equal(created.task.sourceUncommittedChangesIncluded, false);
  assert.equal(await fs.readFile(path.join(created.task.worktreeRoot, 'app.txt'), 'utf8'), 'committed base\n');
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatusBefore);
  const cleanReview = await reviewCodingTask(config, created.task.taskId);
  assert.equal(cleanReview.status, '');
  assert.equal(cleanReview.diffStat, '');
  assert.equal(cleanReview.diff, '');
  assert.deepEqual(cleanReview.changedPaths, []);
  assert.equal(cleanReview.changedFileCount, 0);
  assert.equal(cleanReview.additions, 0);
  assert.equal(cleanReview.deletions, 0);
  parseCodingTaskState({ ...created.task, lastGitObservation: cleanReview }, created.task.taskId);

  const reused = await createCodingTask(config, { root: sourceRoot }, guard, createInput);
  assert.equal(reused.reused, true);
  assert.equal(reused.task.revision, created.task.revision);
  await expectReject(
    createCodingTask(config, { root: sourceRoot }, guard, { ...createInput, goal: 'different binding' }),
    /different creation contract/
  );

  // Recover a crash after Git registered a --no-checkout worktree but before task state existed.
  const commonDir = await fs.realpath(path.resolve(sourceRoot, git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])));
  const recoveryKey = 'worktree-create-recovery';
  const recoveryTaskId = `task_${createHash('sha256').update(`${commonDir}\0${recoveryKey}`).digest('hex').slice(0, 24)}`;
  const recoveryWorktree = path.join(dataRoot, 'worktrees', recoveryTaskId);
  git(sourceRoot, ['worktree', 'add', '--detach', '--no-checkout', recoveryWorktree, baseSha]);
  await assert.rejects(fs.readFile(path.join(recoveryWorktree, 'app.txt'), 'utf8'));
  const recoveredCreate = await createCodingTask(config, { root: sourceRoot }, guard, {
    ...createInput,
    taskKey: recoveryKey,
    title: 'Recover incomplete worktree creation'
  });
  assert.equal(await fs.readFile(path.join(recoveredCreate.task.worktreeRoot, 'app.txt'), 'utf8'), 'committed base\n');

  const restarted = await getCodingTask({ dataRoot }, created.task.taskId);
  assert.equal(restarted.taskId, created.task.taskId);
  assert.deepEqual(new Set((await listCodingTasks({ dataRoot })).map((task) => task.taskId)), new Set([
    created.task.taskId,
    recoveredCreate.task.taskId
  ]));
  const hiddenSourceRoot = path.join(fixture, 'not-allowed-source');
  const store = new CodingTaskStore(config);
  for (let index = 0; index < 25; index += 1) {
    const hiddenTaskId = `task_${(0xcde000 + index).toString(16).padStart(24, '0')}`;
    await store.withTaskLock(hiddenTaskId, async () => {
      await store.writeLocked({
        ...created.task,
        taskId: hiddenTaskId,
        taskKey: `newer-hidden-task-${index}`,
        workspaceId: `taskws_${hiddenTaskId.slice(5)}`,
        title: `Newer hidden CodingTask ${index}`,
        sourceRoot: hiddenSourceRoot,
        worktreeRoot: store.paths(hiddenTaskId).worktreeRoot,
        updatedAt: new Date(Date.now() + index + 1).toISOString()
      });
    });
  }
  const allowedOnly = await listCodingTasks(config, { allowedSourceRoots: [sourceRoot], limit: 1 });
  assert.equal(allowedOnly.length, 1, 'newer disallowed CodingTasks must not consume the requested list limit');
  assert.equal(allowedOnly[0].sourceRoot, sourceRoot);
  const workspace = await resolveCodingTaskWorkspace({ dataRoot }, created.task.workspaceId, guard);
  assert.equal(workspace.provenanceVerified, true);
  assert.equal(workspace.worktreeRoot, created.task.worktreeRoot);
  await expectReject(
    resolveCodingTaskWorkspace({ dataRoot }, created.task.workspaceId, { assertSourceWorkspace() { throw new Error('not allowed'); } }),
    /not allowed/
  );

  // A committed task checkpoint has a clean HEAD-relative status, while the
  // review remains a base..HEAD change. Its file count must follow the same
  // policy-filtered changed path set returned to the caller.
  const committedReviewTask = await createCodingTask(config, { root: sourceRoot }, guard, {
    ...createInput,
    taskKey: 'committed-review-count',
    title: 'Committed review count regression'
  });
  await fs.writeFile(path.join(committedReviewTask.task.worktreeRoot, 'app.txt'), 'committed task edit\n', 'utf8');
  git(committedReviewTask.task.worktreeRoot, ['add', '--', 'app.txt']);
  git(committedReviewTask.task.worktreeRoot, ['commit', '-m', 'task checkpoint']);
  const committedReview = await reviewCodingTask(config, committedReviewTask.task.taskId);
  assert.equal(committedReview.status, '');
  assert.deepEqual(committedReview.changedPaths, ['app.txt']);
  assert.equal(committedReview.changedFileCount, 1);
  assert.match(committedReview.diff, /committed task edit/);

  const direct = await assertDirectOwner(config, created.task.taskId, {
    expectedRevision: created.task.revision,
    executorEpoch: created.task.executorLease.epoch,
    leaseId: created.task.executorLease.leaseId
  });
  const begun = await beginDirectOperation(config, direct.taskId, {
    expectedRevision: direct.revision,
    executorEpoch: direct.executorLease.epoch,
    leaseId: direct.executorLease.leaseId,
    operationId: 'direct-edit-1'
  });
  const duplicateBegin = await beginDirectOperation(config, direct.taskId, {
    expectedRevision: begun.revision,
    executorEpoch: begun.executorLease.epoch,
    leaseId: begun.executorLease.leaseId,
    operationId: 'direct-edit-1'
  });
  assert.equal(duplicateBegin.revision, begun.revision);
  await fs.writeFile(path.join(begun.worktreeRoot, 'app.txt'), 'task edit\n', 'utf8');
  const directEnded = await endDirectOperation(config, begun.taskId, {
    expectedRevision: begun.revision,
    executorEpoch: begun.executorLease.epoch,
    leaseId: begun.executorLease.leaseId,
    operationId: 'direct-edit-1',
    lifecycle: 'waiting_review',
    resultSummary: 'Direct edit complete.'
  });

  const codexOwned = await transitionCodingTaskExecutor(config, directEnded.taskId, {
    expectedRevision: directEnded.revision,
    expectedExecutorEpoch: directEnded.executorLease.epoch,
    expectedLeaseId: directEnded.executorLease.leaseId,
    transitionKey: 'handoff-to-codex-1',
    to: 'codex'
  });
  const duplicateTransition = await transitionCodingTaskExecutor(config, directEnded.taskId, {
    expectedRevision: directEnded.revision,
    expectedExecutorEpoch: directEnded.executorLease.epoch,
    expectedLeaseId: directEnded.executorLease.leaseId,
    transitionKey: 'handoff-to-codex-1',
    to: 'codex'
  });
  assert.equal(duplicateTransition.revision, codexOwned.revision);
  assert.equal(codexOwned.lastGitObservation?.dirty, true);
  await expectReject(
    transitionCodingTaskExecutor(config, codexOwned.taskId, {
      expectedRevision: directEnded.revision,
      expectedExecutorEpoch: directEnded.executorLease.epoch,
      transitionKey: 'stale-handoff',
      to: 'direct'
    }),
    /CAS conflict/
  );

  const codexBegun = await beginCodingTaskOperation(config, codexOwned.taskId, {
    expectedRevision: codexOwned.revision,
    executor: 'codex',
    executorEpoch: codexOwned.executorLease.epoch,
    leaseId: codexOwned.executorLease.leaseId,
    operationId: 'codex-run-1',
    codexSessionId: 'session-smoke'
  });
  assert.equal(codexBegun.codexTurnActive, false);
  const codexHeartbeat = await heartbeatCodingTaskOperation(config, codexBegun.taskId, {
    expectedRevision: codexBegun.revision,
    executor: 'codex',
    executorEpoch: codexBegun.executorLease.epoch,
    leaseId: codexBegun.executorLease.leaseId,
    operationId: 'codex-run-1',
    codexThreadId: 'thread-smoke',
    codexTurnId: 'turn-smoke',
    codexSessionId: 'session-smoke',
    codexRunnerPid: process.pid
  });
  assert.equal(codexHeartbeat.codexTurnActive, true);
  await expectReject(
    transitionCodingTaskExecutor(config, codexHeartbeat.taskId, {
      expectedRevision: codexHeartbeat.revision,
      expectedExecutorEpoch: codexHeartbeat.executorLease.epoch,
      transitionKey: 'active-turn-rejected',
      to: 'direct'
    }),
    /alive|active/
  );
  const [cancellation, concurrentHeartbeat] = await Promise.all([
    requestCodingTaskCancellation(config, codexHeartbeat.taskId, {
      executor: 'codex',
      executorEpoch: codexHeartbeat.executorLease.epoch,
      leaseId: codexHeartbeat.executorLease.leaseId,
      operationId: 'codex-run-1',
      reason: 'smoke cancel'
    }),
    heartbeatCodingTaskOperationFenced(config, codexHeartbeat.taskId, {
      executor: 'codex',
      executorEpoch: codexHeartbeat.executorLease.epoch,
      leaseId: codexHeartbeat.executorLease.leaseId,
      operationId: 'codex-run-1',
      codexThreadId: 'thread-smoke',
      codexTurnId: 'turn-smoke',
      codexSessionId: 'session-smoke',
      codexRunnerPid: process.pid
    })
  ]);
  assert.ok(cancellation.state.revision !== concurrentHeartbeat.revision);
  const repeatedCancellation = await requestCodingTaskCancellation(config, codexHeartbeat.taskId, {
    executor: 'codex',
    executorEpoch: cancellation.state.executorLease.epoch,
    leaseId: cancellation.state.executorLease.leaseId,
    operationId: 'codex-run-1',
    reason: 'smoke cancel'
  });
  assert.equal(repeatedCancellation.state.revision, Math.max(cancellation.state.revision, concurrentHeartbeat.revision));
  assert.equal(repeatedCancellation.request.requestedAt, cancellation.request.requestedAt);
  assert.equal(
    (await readCodingTaskCancellation(config, codexHeartbeat.taskId, {
      operationId: 'codex-run-1', executorEpoch: codexHeartbeat.executorLease.epoch
    }))?.reason,
    'smoke cancel'
  );
  assert.equal(await readCodingTaskCancellation(config, codexHeartbeat.taskId, {
    operationId: 'later-run', executorEpoch: codexHeartbeat.executorLease.epoch + 1
  }), undefined);

  const beforeFinish = await getCodingTask(config, codexHeartbeat.taskId);
  const codexEnded = await finishCodingTaskOperationFenced(config, codexHeartbeat.taskId, {
    executor: 'codex',
    executorEpoch: beforeFinish.executorLease.epoch,
    leaseId: beforeFinish.executorLease.leaseId,
    operationId: 'codex-run-1',
    lifecycle: 'waiting_review',
    resultSummary: 'Runner completed, but cancellation must dominate.'
  });
  const duplicateFinish = await finishCodingTaskOperationFenced(config, codexHeartbeat.taskId, {
    executor: 'codex',
    executorEpoch: beforeFinish.executorLease.epoch,
    leaseId: beforeFinish.executorLease.leaseId,
    operationId: 'codex-run-1',
    lifecycle: 'waiting_review',
    resultSummary: 'Runner completed, but cancellation must dominate.'
  });
  assert.equal(duplicateFinish.revision, codexEnded.revision);
  assert.equal(codexEnded.lifecycle, 'canceled');
  assert.equal(codexEnded.lastCompletedOperation?.lifecycle, 'canceled');
  assert.equal(codexEnded.cancelRequestedAt, undefined);
  assert.equal(codexEnded.cancelReason, undefined);
  const terminalCancelRetry = await requestCodingTaskCancellation(config, codexEnded.taskId, {
    executor: 'codex',
    executorEpoch: codexEnded.executorLease.epoch,
    leaseId: codexEnded.executorLease.leaseId,
    operationId: 'codex-run-1',
    reason: 'smoke cancel'
  });
  assert.equal(terminalCancelRetry.state.revision, codexEnded.revision);
  assert.equal(terminalCancelRetry.request.requestedAt, cancellation.request.requestedAt);
  await expectReject(requestCodingTaskCancellation(config, codexEnded.taskId, {
    executor: 'codex',
    executorEpoch: codexEnded.executorLease.epoch,
    leaseId: codexEnded.executorLease.leaseId,
    operationId: 'codex-run-1',
    reason: 'conflicting retry'
  }), /different reason/);
  await expectReject(finishCodingTaskOperationFenced(config, codexHeartbeat.taskId, {
    executor: 'codex',
    executorEpoch: beforeFinish.executorLease.epoch,
    leaseId: beforeFinish.executorLease.leaseId,
    operationId: 'codex-run-1',
    lifecycle: 'failed',
    error: 'different terminal response'
  }), /different terminal writeback/);
  assert.equal(codexEnded.codexRunnerPid, undefined);
  assert.equal(codexEnded.codexTurnActive, false);

  // Opposite ordering: a fenced finish that commits first removes the active operation,
  // so a later new cancellation cannot retroactively change the terminal result.
  const finishFirstBegun = await beginDirectOperation(config, recoveredCreate.task.taskId, {
    expectedRevision: recoveredCreate.task.revision,
    executorEpoch: recoveredCreate.task.executorLease.epoch,
    leaseId: recoveredCreate.task.executorLease.leaseId,
    operationId: 'finish-before-cancel-1'
  });
  const finishFirstEnded = await finishCodingTaskOperationFenced(config, finishFirstBegun.taskId, {
    executor: 'direct',
    executorEpoch: finishFirstBegun.executorLease.epoch,
    leaseId: finishFirstBegun.executorLease.leaseId,
    operationId: 'finish-before-cancel-1',
    lifecycle: 'waiting_review',
    resultSummary: 'Finish won the task lock.'
  });
  assert.equal(finishFirstEnded.lifecycle, 'waiting_review');
  await expectReject(requestCodingTaskCancellation(config, finishFirstEnded.taskId, {
    executor: 'direct',
    executorEpoch: finishFirstEnded.executorLease.epoch,
    leaseId: finishFirstEnded.executorLease.leaseId,
    operationId: 'finish-before-cancel-1',
    reason: 'too late'
  }), /no active operation/);

  // A live owner is never auto-recovered. A dead PID plus stale heartbeat is reconciled with Git readback.
  const directAgain = await transitionCodingTaskExecutor(config, codexEnded.taskId, {
    expectedRevision: codexEnded.revision,
    expectedExecutorEpoch: codexEnded.executorLease.epoch,
    expectedLeaseId: codexEnded.executorLease.leaseId,
    transitionKey: 'back-to-direct-for-recovery',
    to: 'direct'
  });
  const recoveryBegun = await beginDirectOperation(config, directAgain.taskId, {
    expectedRevision: directAgain.revision,
    executorEpoch: directAgain.executorLease.epoch,
    leaseId: directAgain.executorLease.leaseId,
    operationId: 'direct-crash-1'
  });
  await expectReject(recoverInterruptedCodingTaskOperation(config, recoveryBegun.taskId, {
    expectedRevision: recoveryBegun.revision,
    executor: 'direct',
    executorEpoch: recoveryBegun.executorLease.epoch,
    operationId: 'direct-crash-1',
    minimumStaleMs: 5_000
  }), /alive|not stale/);
  const recoveryStatePath = path.join(dataRoot, 'tasks', recoveryBegun.taskId, 'state.json');
  const crashed = JSON.parse(await fs.readFile(recoveryStatePath, 'utf8'));
  crashed.activeOperation.pid = 2147483647;
  crashed.activeOperation.heartbeatAt = '2000-01-01T00:00:00.000Z';
  await fs.writeFile(recoveryStatePath, `${JSON.stringify(crashed, null, 2)}\n`, 'utf8');
  const recovered = await recoverInterruptedCodingTaskOperation(config, recoveryBegun.taskId, {
    expectedRevision: recoveryBegun.revision,
    executor: 'direct',
    executorEpoch: recoveryBegun.executorLease.epoch,
    operationId: 'direct-crash-1',
    minimumStaleMs: 5_000
  });
  assert.equal(recovered.activeOperation, undefined);
  assert.equal(recovered.lifecycle, 'failed');
  assert.equal(recovered.events.at(-1)?.kind, 'operation_interrupted');

  await fs.writeFile(path.join(recovered.worktreeRoot, 'new-file.txt'), 'untracked task file\n', 'utf8');
  await fs.writeFile(path.join(recovered.worktreeRoot, '.env'), 'TRACKED_SECRET=changed-secret-value\n', 'utf8');
  await fs.writeFile(path.join(recovered.worktreeRoot, ':(glob)**'), 'literal pathspec filename changed\n', 'utf8');
  await fs.writeFile(path.join(recovered.worktreeRoot, 'private-key.pem'), 'UNTRACKED_PRIVATE_KEY_BYTES\n', 'utf8');
  await fs.mkdir(path.join(recovered.worktreeRoot, '.ssh'));
  await fs.writeFile(path.join(recovered.worktreeRoot, '.ssh', 'id_rsa'), 'UNTRACKED_SSH_PRIVATE_KEY_BYTES\n', 'utf8');
  const review = await reviewCodingTask(config, recovered.taskId, {
    isPathContentAllowed: (relativePath) =>
      relativePath !== '.env' && !relativePath.endsWith('.pem') && !relativePath.startsWith('.ssh/')
  });
  assert.match(review.diff, /task edit/);
  assert.match(review.diff, /new-file\.txt/);
  assert.match(review.diff, /untracked task file/);
  assert.match(review.diff, /literal pathspec filename changed/);
  assert.doesNotMatch(review.diff, /changed-secret-value|base-secret|UNTRACKED_PRIVATE_KEY_BYTES|UNTRACKED_SSH_PRIVATE_KEY_BYTES/);
  assert.deepEqual(review.omittedPaths, ['.env', '.ssh/id_rsa', 'private-key.pem']);
  assert.deepEqual(review.changedPaths.sort(), [':(glob)**', 'app.txt', 'new-file.txt']);
  assert.equal(review.omittedPathCount, 3);
  assert.equal(review.contentComplete, false);
  assert.equal(review.changedFileCount, review.changedPaths.length);
  assert.equal(review.changedFileCount, 3);
  assert.ok(review.additions >= 3);
  assert.ok(review.deletions >= 1);
  assert.equal(review.diffSha256, review.visibleDiffSha256);
  assert.notEqual(review.repositoryObservationSha256, review.visibleDiffSha256);
  assert.equal(review.dirty, true);

  // Persisted provenance tampering fails closed and is restored for the final restart check.
  const statePath = path.join(dataRoot, 'tasks', created.task.taskId, 'state.json');
  const validStateJson = await fs.readFile(statePath, 'utf8');
  const forged = JSON.parse(validStateJson);
  forged.sourceGitCommonDir = path.join(fixture, 'forged-common-dir');
  await fs.writeFile(statePath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
  await expectReject(resolveCodingTaskWorkspace({ dataRoot }, created.task.workspaceId, guard), /common-directory identity changed/);
  await fs.writeFile(statePath, validStateJson, 'utf8');
  assert.equal((await getCodingTask({ dataRoot }, created.task.taskId)).taskId, created.task.taskId);

  if (process.platform !== 'win32') {
    const linkRoot = path.join(fixture, 'task-data-link');
    await fs.symlink(dataRoot, linkRoot, 'dir');
    await expectReject(listCodingTasks({ dataRoot: linkRoot }), /real directory|canonical/);
    const symlinkTaskId = 'task_aaaaaaaaaaaaaaaaaaaaaaaa';
    const outsideTaskDir = path.join(fixture, 'outside-task-dir');
    await fs.mkdir(outsideTaskDir);
    await fs.symlink(outsideTaskDir, path.join(dataRoot, 'tasks', symlinkTaskId), 'dir');
    await expectReject(getCodingTask({ dataRoot }, symlinkTaskId), /real directory/);
  }

  console.log('coding task core smoke: ok');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
