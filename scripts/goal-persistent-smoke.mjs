import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveGoal, computeGoalContractFingerprint, getGoal, pauseGoal, proposeGoal } from '../dist/goalOps.js';
import { createGoalContentPolicySnapshot } from '../dist/goalPolicy.js';
import { GOAL_SCHEDULER_TEST_HOOKS, getPersistentGoalScheduler, reconcilePersistentGoalCancellation, requestPersistentGoalCancel, resumePersistentGoal, runPersistentGoalScheduler, startPersistentGoal } from '../dist/goalScheduler.js';
import { beginCodingTaskOperation, createCodingTask, getCodingTask } from '../dist/codingTaskOps.js';
import { getCodingTaskRun, launchCodingTaskRun } from '../dist/codingTaskRunner.js';
import { reviewGoal } from '../dist/goalExecution.js';
import { parseGoalState } from '../dist/goalState.js';

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
async function poll(read, accept, timeout = 15_000) {
  const deadline = Date.now() + timeout; let value;
  while (Date.now() < deadline) { value = await read(); if (accept(value)) return value; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`);
}
async function fixtureProcesses(fixtureRoot) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const relative = path.relative(temporaryRoot, fixtureRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(fixtureRoot).startsWith('codexpro-goal-persistent-')) {
    throw new Error(`Refusing process cleanup outside an exact persistent-smoke fixture: ${fixtureRoot}`);
  }
  return execFileSync('ps', ['-axo', 'pid=,state=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid || !match[3].includes(`${fixtureRoot}${path.sep}`)) return [];
    return [{ pid: Number(match[1]), state: match[2], command: match[3] }];
  });
}

async function terminateFixtureProcesses(fixtureRoot) {
  let processes = []; let stableSince;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    processes = await fixtureProcesses(fixtureRoot);
    if (!processes.length) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= 1_000) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    stableSince = undefined;
    for (const item of processes) { try { process.kill(item.pid, 'SIGCONT'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    for (const item of processes) { try { process.kill(item.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const item of await fixtureProcesses(fixtureRoot)) { try { process.kill(item.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
  }
  processes = await fixtureProcesses(fixtureRoot);
  assert.deepEqual(processes, [], `persistent smoke leaked fixture-owned processes: ${JSON.stringify(processes)}`);
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-persistent-')));
try {
  const sourceRoot = path.join(fixture, 'source'); const dataRoot = path.join(fixture, 'state'); const fakeCodex = path.join(fixture, 'fake-codex'); const launches = path.join(fixture, 'launches.log'); const failInitializeOnce = path.join(fixture, 'fail-initialize-once'); const duplicateTurnMarker = path.join(fixture, 'duplicate-turn');
  await fs.mkdir(sourceRoot); git(sourceRoot, ['init', '-q']); git(sourceRoot, ['config', 'user.name', 'Persistent Smoke']); git(sourceRoot, ['config', 'user.email', 'persistent@example.invalid']);
  const cleanupProbeRoot = path.join(fixture, 'codexpro-goal-persistent-cleanup-probe');
  await fs.mkdir(cleanupProbeRoot);
  const cleanupProbe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(cleanupProbeRoot, 'probe')], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { cleanupProbe.once('spawn', resolve); cleanupProbe.once('error', reject); }); cleanupProbe.unref();
  process.kill(cleanupProbe.pid, 'SIGSTOP');
  assert.equal((await fixtureProcesses(cleanupProbeRoot)).some((item) => item.pid === cleanupProbe.pid && item.state.includes('T')), true, 'cleanup regression must own an actually stopped fixture process');
  await terminateFixtureProcesses(cleanupProbeRoot);
  assert.deepEqual(await fixtureProcesses(cleanupProbeRoot), []);
  await fs.mkdir(path.join(sourceRoot, 'src')); await fs.writeFile(path.join(sourceRoot, 'src', 'a.txt'), 'base a\n'); await fs.writeFile(path.join(sourceRoot, 'src', 'b.txt'), 'base b\n');
  git(sourceRoot, ['add', '--', 'src/a.txt', 'src/b.txt']); git(sourceRoot, ['commit', '-qm', 'base']); const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']); const sourceStatus = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const launches=${JSON.stringify(launches)}; const failInitializeOnce=${JSON.stringify(failInitializeOnce)}; const duplicateTurnMarker=${JSON.stringify(duplicateTurnMarker)}; let buffer=''; let slot=''; const threadId='thread-stable'; const sessionId='session-stable'; const turnId=fs.existsSync(duplicateTurnMarker)?'duplicate-semantic-turn':'turn-'+process.pid; const failureMarker=fs.existsSync(failInitializeOnce)?fs.readFileSync(failInitializeOnce,'utf8').trim():''; const failOnResume=failureMarker==='resume'; const failAcrossTurns=failureMarker==='aggregate';
if(failAcrossTurns)process.once('exit',()=>fs.writeFileSync(failInitializeOnce,'resume'));
function send(v){process.stdout.write(JSON.stringify(v)+'\\n')} function turn(status='inProgress'){return {id:turnId,status,error:null,items:status==='completed'?[{type:'agentMessage',id:'final',text:'persistent '+slot+' complete',phase:'final_answer'}]:[]}}
function handle(m){ if(m.method==='initialize'){if(failOnResume){fs.writeFileSync(failInitializeOnce,'1');return send({id:m.id,result:{}})}if(fs.existsSync(failInitializeOnce)){const remaining=Math.max(0,Number(fs.readFileSync(failInitializeOnce,'utf8').trim())||1)-1;if(remaining)fs.writeFileSync(failInitializeOnce,String(remaining));else fs.unlinkSync(failInitializeOnce);fs.appendFileSync(launches,'infra-fail\\n');process.exit(71)}return send({id:m.id,result:{}})} if(m.method==='initialized')return; if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId||threadId,sessionId,ephemeral:false}}}); if(m.method==='turn/start'){const prompt=m.params.input?.map(x=>x.text||'').join('\\n')||''; slot=prompt.includes('work_noop')?'noop':prompt.includes('work_hold')?'hold':prompt.includes('work_pause')?'pause':prompt.includes('work_cancel')?'cancel':prompt.includes('work_secret')?'secret':prompt.includes('work_b')?'b':'a'; fs.appendFileSync(launches,'start:'+slot+'\\n'); if(slot==='secret')fs.writeFileSync(path.join(process.cwd(),'src','.ENV'),'TOP_SECRET=1\\n'); else if(slot!=='noop')fs.writeFileSync(path.join(process.cwd(),'src',slot==='b'||slot==='hold'?'b.txt':'a.txt'),'persistent '+slot+'\\n'); send({id:m.id,result:{turn:turn()}}); setTimeout(()=>{fs.appendFileSync(launches,'finish:'+slot+'\\n');send({method:'turn/completed',params:{threadId,turn:turn('completed')}})},slot==='pause'||slot==='cancel'||slot==='hold'?1500:100); return} if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId,turn:turn('interrupted')}})}}
process.stdin.on('data',c=>{buffer+=c;for(;;){const i=buffer.indexOf('\\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())handle(JSON.parse(line))}});`;
  await fs.writeFile(fakeCodex, fakeSource, { mode: 0o700 }); await fs.chmod(fakeCodex, 0o700);
  const storeConfig = { dataRoot, lockTimeoutMs: 60_000 }; const executionConfig = { dataRoot, lockTimeoutMs: 60_000, codexBinary: fakeCodex, codexDir: fixture, maxOutputBytes: 2 * 1024 * 1024 };
  const policy = createGoalContentPolicySnapshot(['**/.env', '**/*.pem']);
  const baseInput = {
    title: 'Persistent scheduler smoke', goal: 'Mechanically execute an approved DAG into private integration.', completionCriteria: ['All work is integrated'], verification: ['git diff --check'], executionPolicy: 'persistent', workspacePolicy: 'isolated', workerModel: 'gpt-5.6-sol', workerEffort: 'high',
    limits: { maxConcurrency: 2, timeoutMs: 10_000, maxTurnsPerWorker: 1, maxRetriesPerWorker: 0, maxLogBytes: 1_048_576 },
    permissions: { fileGlobs: ['src/**'], commands: [], network: false, sourceEffects: { apply: false, commit: false, push: false, draftPr: false } }, contentPolicy: policy, baseSha
  };
  async function approved(goalKey, work) {
    const proposed = await proposeGoal(storeConfig, { root: sourceRoot }, { assertSourceWorkspace: (root) => assert.equal(root, sourceRoot) }, { ...baseInput, goalKey, work });
    return approveGoal(storeConfig, proposed.goal.goalId, { expectedRevision: proposed.goal.revision, contractFingerprint: proposed.goal.contractFingerprint, approvalKey: `approve-${goalKey}` });
  }

  const dag = await approved('persistent-dag-v1', [
    { workId: 'work_a', title: 'A', goal: 'Modify src/a.txt.', acceptanceCriteria: ['A'], fileGlobs: ['src/a.txt'] },
    { workId: 'work_b', title: 'B', goal: 'Modify src/b.txt.', acceptanceCriteria: ['B'], dependsOn: ['work_a'], fileGlobs: ['src/b.txt'] }
  ]);
  const started = await startPersistentGoal(executionConfig, dag.goalId, { expectedRevision: dag.revision, startKey: 'start-dag-v1' });
  assert.equal(started.reused, false); assert.equal(started.goal.scheduler.status, 'queued');
  const retries = await Promise.all(Array.from({ length: 20 }, () => startPersistentGoal(executionConfig, dag.goalId, { expectedRevision: dag.revision, startKey: 'start-dag-v1' })));
  assert.equal(retries.every((retry) => retry.reused), true);
  const done = await poll(() => getPersistentGoalScheduler(storeConfig, dag.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped');
  assert.equal(done.goal.work.every((work) => work.status === 'integrated'), true); assert.equal(done.runtime.status, 'stopped'); assert.equal(done.runtime.stopReason, 'semantic_review');
  const doneReview = await reviewGoal(executionConfig, dag.goalId, () => true);
  assert.equal(doneReview.review.changedFileCount, 2, 'persistent Goal review counts committed files changed from base, not clean-worktree status entries');
  assert.deepEqual(doneReview.review.changedPaths, ['src/a.txt', 'src/b.txt']);
  assert.equal(git(done.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '2');
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatus, 'persistent execution must not affect source');
  const passiveBefore = await fs.readFile(path.join(dataRoot, 'goals', dag.goalId, 'state.json')); await getPersistentGoalScheduler(storeConfig, dag.goalId); assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', dag.goalId, 'state.json')), passiveBefore);
  await assert.rejects(pauseGoal(storeConfig, dag.goalId, { expectedRevision: done.goal.revision, requestKey: 'pause-after-review-v1' }), /stopped for Pro semantic review/);
  assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', dag.goalId, 'state.json')), passiveBefore, 'persistent waiting_review pause rejection must be zero-mutation');

  const multiInput = { ...baseInput, limits: { ...baseInput.limits, maxConcurrency: 1, maxTurnsPerWorker: 2 } };
  const multiProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...multiInput, goalKey: 'persistent-multi-v1', work: [{ workId: 'work_multi', title: 'Multi', goal: 'Modify src/a.txt in the initial turn.', acceptanceCriteria: ['Two authorized turns'], fileGlobs: ['src/a.txt'], continuationIntents: [{ intentId: 'verify_final', prompt: 'Inspect the existing src/a.txt change, preserve it, and return the final authorized result.' }] }] });
  const multi = await approveGoal(storeConfig, multiProposed.goal.goalId, { expectedRevision: multiProposed.goal.revision, contractFingerprint: multiProposed.goal.contractFingerprint, approvalKey: 'approve-multi-v1' });
  await startPersistentGoal(executionConfig, multi.goalId, { expectedRevision: multi.revision, startKey: 'start-multi-v1' });
  const multiDone = await poll(() => getPersistentGoalScheduler(storeConfig, multi.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped', 30_000);
  const multiWork = multiDone.goal.work[0];
  assert.equal(multiWork.status, 'integrated'); assert.equal(multiWork.turns.length, 2);
  assert.deepEqual(multiWork.turns.map((turn) => turn.status), ['succeeded', 'succeeded']);
  assert.deepEqual(multiWork.turns.map((turn) => turn.operationId), [`goal:${multi.goalId.slice(5)}:work_multi:turn:1:attempt:0`, `goal:${multi.goalId.slice(5)}:work_multi:turn:2:attempt:0`]);
  assert.equal(multiWork.turns[0].taskId, multiWork.turns[1].taskId); assert.equal(multiWork.turns[0].threadId, multiWork.turns[1].threadId); assert.equal(multiWork.turns[0].sessionId, multiWork.turns[1].sessionId);
  assert.equal(multiWork.turns[0].terminalObservation.changedPathCount, 1); assert.equal(multiWork.turns[1].attempts[0].startObservation.changedPathCount, 1);
  assert.equal(multiWork.turns[1].attempts[0].startObservation.changedPathsSha256, multiWork.turns[0].terminalObservation.changedPathsSha256);
  assert.equal(multiWork.integrationKey, `goal:${multi.goalId}:work_multi:integrate:1`);
  assert.equal(git(multiDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '1', 'only the final authorized cumulative checkpoint integrates once');
  const duplicateTurnTamper = structuredClone(multiDone.goal); duplicateTurnTamper.work[0].turns[1].turnId = duplicateTurnTamper.work[0].turns[0].turnId;
  assert.throws(() => parseGoalState(duplicateTurnTamper, multiDone.goal.goalId), /turn identity continuity/);

  const duplicateTurnProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...multiInput, goalKey: 'persistent-duplicate-turn-v1', work: [{ workId: 'work_duplicate_turn', title: 'Duplicate turn', goal: 'Modify src/a.txt and continue.', acceptanceCriteria: ['Reject replayed semantic turn identity'], fileGlobs: ['src/a.txt'], continuationIntents: [{ intentId: 'duplicate_final', prompt: 'Complete the final authorized turn without replaying identity.' }] }] });
  const duplicateTurnGoal = await approveGoal(storeConfig, duplicateTurnProposed.goal.goalId, { expectedRevision: duplicateTurnProposed.goal.revision, contractFingerprint: duplicateTurnProposed.goal.contractFingerprint, approvalKey: 'approve-duplicate-turn-v1' });
  await fs.writeFile(duplicateTurnMarker, '1\n', { mode: 0o600 });
  await startPersistentGoal(executionConfig, duplicateTurnGoal.goalId, { expectedRevision: duplicateTurnGoal.revision, startKey: 'start-duplicate-turn-v1' });
  const duplicateTurnDone = await poll(() => getPersistentGoalScheduler(storeConfig, duplicateTurnGoal.goalId), (view) => view.goal.lifecycle === 'failed' && ['stopped', 'failed'].includes(view.runtime?.status), 30_000);
  await fs.unlink(duplicateTurnMarker);
  assert.match(duplicateTurnDone.goal.error, /identity|provenance/i);
  assert.equal(duplicateTurnDone.goal.work[0].status, 'failed');
  const duplicateAttempt = duplicateTurnDone.goal.work[0].turns[1].attempts[0];
  assert.deepEqual([duplicateAttempt.status, duplicateAttempt.failure?.code, duplicateAttempt.failure?.category, duplicateAttempt.failure?.phase], ['failed', 'identity_mismatch', 'identity', 'turn_start']);
  assert.equal(duplicateTurnDone.goal.work[0].integrationSha, undefined);
  assert.equal(git(duplicateTurnDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '0', 'duplicate semantic turn identity must not integrate');

  const continuationRetryInput = { ...baseInput, limits: { ...baseInput.limits, maxConcurrency: 1, maxTurnsPerWorker: 2, maxRetriesPerWorker: 1 } };
  const continuationRetryProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...continuationRetryInput, goalKey: 'persistent-continuation-retry-v1', work: [{ workId: 'work_cont_retry', title: 'Continuation retry', goal: 'Modify src/a.txt, then continue.', acceptanceCriteria: ['Retry continuation before its turn'], fileGlobs: ['src/a.txt'], continuationIntents: [{ intentId: 'final_retry', prompt: 'Preserve the first turn change and complete the final authorized turn.' }] }] });
  const continuationRetryGoal = await approveGoal(storeConfig, continuationRetryProposed.goal.goalId, { expectedRevision: continuationRetryProposed.goal.revision, contractFingerprint: continuationRetryProposed.goal.contractFingerprint, approvalKey: 'approve-cont-retry-v1' });
  await fs.writeFile(failInitializeOnce, 'resume\n', { mode: 0o600 });
  await startPersistentGoal(executionConfig, continuationRetryGoal.goalId, { expectedRevision: continuationRetryGoal.revision, startKey: 'start-cont-retry-v1' });
  const continuationRetryDone = await poll(() => getPersistentGoalScheduler(storeConfig, continuationRetryGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped', 30_000);
  const continuationRetryTurns = continuationRetryDone.goal.work[0].turns; assert.equal(continuationRetryTurns[1].attempts.length, 2);
  assert.equal(continuationRetryTurns[1].attempts[0].failure.code, 'app_server_initialize_transport');
  assert.equal(continuationRetryTurns[1].attempts[0].terminalObservation.changedPathsSha256, continuationRetryTurns[0].terminalObservation.changedPathsSha256);
  assert.equal(continuationRetryTurns[1].attempts[0].terminalObservation.changedPathCount, continuationRetryTurns[0].terminalObservation.changedPathCount);
  assert.equal(continuationRetryTurns[1].threadId, continuationRetryTurns[0].threadId); assert.equal(continuationRetryTurns[1].sessionId, continuationRetryTurns[0].sessionId);
  const continuationDecisionRoot = path.join(dataRoot, 'tasks', continuationRetryDone.goal.work[0].codingTaskId, 'continuations');
  assert.equal((await fs.readdir(continuationDecisionRoot)).length, 2, 'each continuation attempt has an immutable lineage decision');

  const aggregateRetryInput = { ...baseInput, limits: { ...baseInput.limits, maxConcurrency: 1, maxTurnsPerWorker: 2, maxRetriesPerWorker: 2 } };
  const aggregateRetryProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...aggregateRetryInput, goalKey: 'persistent-aggregate-retry-v1', work: [{ workId: 'work_aggregate', title: 'Aggregate retry', goal: 'Modify src/a.txt across two authorized turns.', acceptanceCriteria: ['Spend one retry on each semantic turn'], fileGlobs: ['src/a.txt'], continuationIntents: [{ intentId: 'aggregate_final', prompt: 'Preserve the first turn change and complete the final authorized turn.' }] }] });
  const aggregateRetryGoal = await approveGoal(storeConfig, aggregateRetryProposed.goal.goalId, { expectedRevision: aggregateRetryProposed.goal.revision, contractFingerprint: aggregateRetryProposed.goal.contractFingerprint, approvalKey: 'approve-aggregate-retry-v1' });
  await fs.writeFile(failInitializeOnce, 'aggregate\n', { mode: 0o600 });
  await startPersistentGoal(executionConfig, aggregateRetryGoal.goalId, { expectedRevision: aggregateRetryGoal.revision, startKey: 'start-aggregate-retry-v1' });
  const aggregateRetryDone = await poll(() => getPersistentGoalScheduler(storeConfig, aggregateRetryGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped', 45_000);
  const aggregateWork = aggregateRetryDone.goal.work[0];
  assert.deepEqual(aggregateWork.turns.map((turn) => turn.attempts.length), [2, 2], 'the retry budget is aggregate across semantic turns');
  assert.deepEqual(aggregateWork.turns.flatMap((turn) => turn.attempts.map((attempt) => attempt.status)), ['failed', 'succeeded', 'failed', 'succeeded']);
  assert.equal(Date.parse(aggregateWork.turns[0].attempts[1].notBefore) - Date.parse(aggregateWork.turns[0].attempts[0].finishedAt), 1_000);
  assert.equal(Date.parse(aggregateWork.turns[1].attempts[1].notBefore) - Date.parse(aggregateWork.turns[1].attempts[0].finishedAt), 5_000);
  assert.equal(aggregateWork.turns[0].taskId, aggregateWork.turns[1].taskId);
  assert.equal(aggregateWork.turns[0].threadId, aggregateWork.turns[1].threadId);
  assert.equal(aggregateWork.turns[0].sessionId, aggregateWork.turns[1].sessionId);
  assert.equal(aggregateWork.turns[1].attempts[0].terminalObservation.changedPathsSha256, aggregateWork.turns[0].terminalObservation.changedPathsSha256);
  assert.equal(aggregateWork.turns[1].attempts[1].startObservation.changedPathsSha256, aggregateWork.turns[0].terminalObservation.changedPathsSha256);
  assert.equal(aggregateWork.turns[1].attempts[1].startObservation.changedPathCount, aggregateWork.turns[0].terminalObservation.changedPathCount);
  const aggregateDecisionRoot = path.join(dataRoot, 'tasks', aggregateWork.codingTaskId, 'continuations');
  assert.equal((await fs.readdir(aggregateDecisionRoot)).length, 2, 'both continuation attempts retain distinct immutable decisions');
  assert.equal(git(aggregateRetryDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '1', 'aggregate retries still produce exactly one final integration');

  const noOpGoal = await approved('persistent-noop-v1', [{ workId: 'work_noop', title: 'No-op', goal: 'Inspect only and make no changes.', acceptanceCriteria: ['No change is a valid authorized result'], fileGlobs: ['src/a.txt'] }]);
  await startPersistentGoal(executionConfig, noOpGoal.goalId, { expectedRevision: noOpGoal.revision, startKey: 'start-noop-v1' });
  const noOpDone = await poll(() => getPersistentGoalScheduler(storeConfig, noOpGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped');
  assert.equal(noOpDone.goal.work[0].status, 'integrated'); assert.equal(noOpDone.goal.integrationHeadSha, baseSha);
  assert.deepEqual(noOpDone.goal.work[0].turns[0].terminalObservation.changedPaths, []);
  assert.equal(git(noOpDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '0', 'valid no-op integration must not fabricate a commit');

  const retryInput = { ...baseInput, limits: { ...baseInput.limits, maxConcurrency: 1, maxRetriesPerWorker: 1 } };
  const retryProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...retryInput, goalKey: 'persistent-retry-v1', work: [{ workId: 'work_retry', title: 'Retry', goal: 'Modify src/a.txt after one proven infrastructure failure.', acceptanceCriteria: ['Retried exactly once'], fileGlobs: ['src/a.txt'] }] });
  const retryGoal = await approveGoal(storeConfig, retryProposed.goal.goalId, { expectedRevision: retryProposed.goal.revision, contractFingerprint: retryProposed.goal.contractFingerprint, approvalKey: 'approve-retry-v1' });
  const infraFailuresBeforeRetry = (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'infra-fail').length;
  await fs.writeFile(failInitializeOnce, '1\n', { mode: 0o600 });
  await startPersistentGoal(executionConfig, retryGoal.goalId, { expectedRevision: retryGoal.revision, startKey: 'start-retry-v1' });
  const retryDone = await poll(() => getPersistentGoalScheduler(storeConfig, retryGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped', 30_000);
  const retryTurn = retryDone.goal.work[0].turns[0];
  assert.equal(retryTurn.attempts.length, 2); assert.deepEqual(retryTurn.attempts.map((attempt) => attempt.status), ['failed', 'succeeded']);
  assert.equal(retryTurn.attempts[0].failure.code, 'app_server_initialize_transport'); assert.equal(retryTurn.attempts[0].failure.retryable, true);
  assert.equal(retryTurn.attempts[0].operationId, `goal:${retryGoal.goalId.slice(5)}:work_retry:turn:1:attempt:0`);
  assert.equal(retryTurn.attempts[1].operationId, `goal:${retryGoal.goalId.slice(5)}:work_retry:turn:1:attempt:1`);
  assert.equal((await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'infra-fail').length, infraFailuresBeforeRetry + 1);
  for (const field of ['statusSha256', 'diffStatSha256', 'changedPathsSha256', 'changedPathCount']) {
    const tamperedAttempt = structuredClone(retryDone.goal); const observation = tamperedAttempt.work[0].turns[0].attempts[0].startObservation;
    if (field === 'changedPathCount') observation[field] += 1; else observation[field] = '0'.repeat(64);
    assert.throws(() => parseGoalState(tamperedAttempt, retryDone.goal.goalId), /attempt baseline|retry fence|compact authority/);
    const removed = structuredClone(retryDone.goal); delete removed.work[0].turns[0].attempts[0].startObservation[field];
    assert.throws(() => parseGoalState(removed, retryDone.goal.goalId), /compact authority/);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(retryDone.goal)) < 256 * 1024, 'compact attempt ledger remains far below the 4MiB durable state cap');

  const exhaustInput = { ...baseInput, limits: { ...baseInput.limits, maxConcurrency: 1, maxRetriesPerWorker: 2 } };
  const exhaustProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...exhaustInput, goalKey: 'persistent-retry-exhaust-v1', work: [{ workId: 'work_exhaust', title: 'Exhaust retries', goal: 'Fail before all model turns.', acceptanceCriteria: ['Bounded failure'], fileGlobs: ['src/a.txt'] }] });
  const exhaustGoal = await approveGoal(storeConfig, exhaustProposed.goal.goalId, { expectedRevision: exhaustProposed.goal.revision, contractFingerprint: exhaustProposed.goal.contractFingerprint, approvalKey: 'approve-exhaust-v1' });
  await fs.writeFile(failInitializeOnce, '3\n', { mode: 0o600 }); await startPersistentGoal(executionConfig, exhaustGoal.goalId, { expectedRevision: exhaustGoal.revision, startKey: 'start-exhaust-v1' });
  const exhausted = await poll(() => getGoal(storeConfig, exhaustGoal.goalId), (goal) => goal.lifecycle === 'failed', 30_000);
  assert.deepEqual(exhausted.work[0].turns[0].attempts.map((attempt) => attempt.status), ['failed', 'failed', 'failed']);
  assert.equal(exhausted.work[0].turns[0].attempts.every((attempt) => attempt.failure.code === 'app_server_initialize_transport'), true);
  const exhaustedAttempts = exhausted.work[0].turns[0].attempts;
  assert.equal(Date.parse(exhaustedAttempts[1].notBefore) - Date.parse(exhaustedAttempts[0].finishedAt), 1_000);
  assert.equal(Date.parse(exhaustedAttempts[2].notBefore) - Date.parse(exhaustedAttempts[1].finishedAt), 5_000);
  assert.equal(exhaustedAttempts.length, 3, 'two retries are aggregate and no attempt four may be reserved');
  const crossedFailureTuple = structuredClone(exhausted);
  Object.assign(crossedFailureTuple.work[0].turns[0].attempts[2].failure, { code: 'turn_timeout', category: 'model_or_tool', phase: 'turn_start', retryable: false, outcomeKnown: false, turnStarted: true });
  assert.throws(() => parseGoalState(crossedFailureTuple, exhausted.goalId), /attempt failure tuple/, 'Goal attempt failures accept only canonical runner code/category/phase tuples');

  const slotProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...retryInput, goalKey: 'persistent-retry-slot-v1', work: [
    { workId: 'work_retry_slot', title: 'Retry slot', goal: 'Modify src/a.txt after one infrastructure failure.', acceptanceCriteria: ['Retry after peer'], fileGlobs: ['src/a.txt'] },
    { workId: 'work_hold', title: 'Held peer', goal: 'Modify src/b.txt slowly while retry backoff expires.', acceptanceCriteria: ['Hold the only slot'], fileGlobs: ['src/b.txt'] }
  ] });
  const slotGoal = await approveGoal(storeConfig, slotProposed.goal.goalId, { expectedRevision: slotProposed.goal.revision, contractFingerprint: slotProposed.goal.contractFingerprint, approvalKey: 'approve-retry-slot-v1' });
  await fs.writeFile(failInitializeOnce, '1\n', { mode: 0o600 }); const slotLogOffset = (await fs.readFile(launches, 'utf8')).length;
  await startPersistentGoal(executionConfig, slotGoal.goalId, { expectedRevision: slotGoal.revision, startKey: 'start-retry-slot-v1' });
  await poll(() => getGoal(storeConfig, slotGoal.goalId), (goal) => goal.lifecycle === 'waiting_review', 30_000);
  const slotLines = (await fs.readFile(launches, 'utf8')).slice(slotLogOffset).trim().split('\n');
  assert.ok(slotLines.indexOf('infra-fail') < slotLines.indexOf('start:hold'));
  assert.ok(slotLines.indexOf('finish:hold') < slotLines.indexOf('start:a'), 'due retry must not bypass maxConcurrency while the peer owns the only slot');

  const backoffProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...retryInput, goalKey: 'persistent-backoff-cancel-v1', work: [{ workId: 'work_backoff_cancel', title: 'Backoff cancel', goal: 'Cancel after one infrastructure failure.', acceptanceCriteria: ['No retry launch'], fileGlobs: ['src/a.txt'] }] });
  const backoffGoal = await approveGoal(storeConfig, backoffProposed.goal.goalId, { expectedRevision: backoffProposed.goal.revision, contractFingerprint: backoffProposed.goal.contractFingerprint, approvalKey: 'approve-backoff-cancel-v1' });
  await fs.writeFile(failInitializeOnce, '1\n', { mode: 0o600 });
  await startPersistentGoal(executionConfig, backoffGoal.goalId, { expectedRevision: backoffGoal.revision, startKey: 'start-backoff-cancel-v1' });
  const inBackoff = await poll(() => getGoal(storeConfig, backoffGoal.goalId), (goal) => goal.work[0].turns?.[0]?.attempts?.at(-1)?.status === 'backoff');
  const backoffCanceled = await requestPersistentGoalCancel(storeConfig, backoffGoal.goalId, { expectedRevision: inBackoff.revision, cancelKey: 'cancel-backoff-v1' });
  assert.equal(backoffCanceled.lifecycle, 'canceled'); assert.equal(backoffCanceled.work[0].turns[0].status, 'canceled');
  assert.deepEqual(backoffCanceled.work[0].turns[0].attempts.map((attempt) => attempt.status), ['failed', 'canceled']);
  const backoffBytes = await fs.readFile(path.join(dataRoot, 'goals', backoffGoal.goalId, 'state.json'));
  const backoffRetryCancel = await requestPersistentGoalCancel(storeConfig, backoffGoal.goalId, { expectedRevision: inBackoff.revision, cancelKey: 'cancel-backoff-v1' });
  assert.equal(backoffRetryCancel.revision, backoffCanceled.revision); assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', backoffGoal.goalId, 'state.json')), backoffBytes);

  const crashCancelProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...retryInput, goalKey: 'persistent-cancel-ledger-crash-v1', work: [{ workId: 'work_crash_cancel', title: 'Cancel crash', goal: 'Crash after child finish and before Goal ledger.', acceptanceCriteria: ['Recover exact lease'], fileGlobs: ['src/a.txt'] }] });
  const crashCancelGoal = await approveGoal(storeConfig, crashCancelProposed.goal.goalId, { expectedRevision: crashCancelProposed.goal.revision, contractFingerprint: crashCancelProposed.goal.contractFingerprint, approvalKey: 'approve-crash-cancel-v1' });
  await fs.writeFile(failInitializeOnce, '1\n', { mode: 0o600 }); await startPersistentGoal(executionConfig, crashCancelGoal.goalId, { expectedRevision: crashCancelGoal.revision, startKey: 'start-crash-cancel-v1' });
  const crashBackoff = await poll(() => getGoal(storeConfig, crashCancelGoal.goalId), (goal) => goal.work[0].turns?.[0]?.attempts?.at(-1)?.status === 'backoff');
  let injected = false; GOAL_SCHEDULER_TEST_HOOKS.beforeCancellationLedgerWrite = async (goalId) => { if (goalId === crashCancelGoal.goalId && !injected) { injected = true; throw new Error('simulated crash before Goal cancel ledger'); } };
  await assert.rejects(requestPersistentGoalCancel(storeConfig, crashCancelGoal.goalId, { expectedRevision: crashBackoff.revision, cancelKey: 'cancel-crash-ledger-v1' }), /simulated crash/);
  delete GOAL_SCHEDULER_TEST_HOOKS.beforeCancellationLedgerWrite;
  const crashTaskBeforeRecovery = await getCodingTask(storeConfig, crashBackoff.work[0].codingTaskId);
  assert.equal(crashTaskBeforeRecovery.lifecycle, 'canceled'); assert.equal(crashTaskBeforeRecovery.executor, 'codex', 'child remains Codex-owned until Goal ledger is durable');
  const recoveredCancel = await reconcilePersistentGoalCancellation(storeConfig, crashCancelGoal.goalId); assert.equal(recoveredCancel.lifecycle, 'canceled');
  const recoveredAttempt = recoveredCancel.work[0].turns[0].attempts.at(-1); assert.equal(recoveredAttempt.status, 'canceled'); assert.equal(recoveredAttempt.executorLeaseId, crashTaskBeforeRecovery.executorLease.leaseId);
  const crashTaskRetired = await getCodingTask(storeConfig, crashTaskBeforeRecovery.taskId); assert.equal(crashTaskRetired.executor, 'direct');

  const absentGoal = await approved('persistent-absent-task-cancel-v1', [{ workId: 'work_absent', title: 'Absent task', goal: 'Cancel a reservation before task creation.', acceptanceCriteria: ['Unbound cancellation'], fileGlobs: ['src/a.txt'] }]);
  const absentNow = new Date().toISOString(); const absentOperation = `goal:${absentGoal.goalId.slice(5)}:work_absent:turn:1:attempt:0`; const absentTaskKey = `goal:${absentGoal.goalId}:work_absent`;
  const absentTaskId = `task_${createHash('sha256').update(`${absentGoal.sourceGitCommonDir}\0${absentTaskKey}`).digest('hex').slice(0, 24)}`;
  const absentState = { ...absentGoal, lifecycle: 'running', startKey: 'start-absent-v1', integrationHeadSha: baseSha, startedAt: absentNow,
    scheduler: { epoch: 1, leaseId: 'lease-absent-v1', startKey: 'start-absent-v1', definitionFingerprint: 'c'.repeat(64), status: 'queued', requestedAt: absentNow }, revision: absentGoal.revision + 1, updatedAt: absentNow,
    work: absentGoal.work.map((work) => ({ ...work, status: 'launching', baseSha, operationId: absentOperation, launch: { launchKey: `goal:${absentGoal.goalId}:${work.workId}:launch:1`, taskKey: absentTaskKey, taskId: absentTaskId, schedulerEpoch: 1, schedulerLeaseId: 'lease-absent-v1', operationId: absentOperation, baseSha, reservedAt: absentNow },
      turns: [{ turnIndex: 1, intentId: 'initial', intentFingerprint: createHash('sha256').update(`codexpro-goal-initial-intent-v1\0${work.workId}\0`).digest('hex'), promptSha256: '0'.repeat(64), operationId: absentOperation, taskId: absentTaskId, baseSha, status: 'reserved', attempts: [{ attemptIndex: 0, operationId: absentOperation, status: 'reserved', scheduledAt: absentNow, notBefore: absentNow }], reservedAt: absentNow }] })) };
  const absentPrompt = (await import('../dist/goalPrompt.js')).buildGoalWorkerPrompt(absentState, absentState.work[0]);
  absentState.work[0].turns[0].intentFingerprint = createHash('sha256').update(`codexpro-goal-initial-intent-v1\0work_absent\0${absentPrompt}`).digest('hex'); absentState.work[0].turns[0].promptSha256 = createHash('sha256').update(absentPrompt).digest('hex');
  const absentPath = path.join(dataRoot, 'goals', absentGoal.goalId, 'state.json'); await fs.writeFile(absentPath, `${JSON.stringify(absentState, null, 2)}\n`, { mode: 0o600 });
  const absentCanceled = await requestPersistentGoalCancel(storeConfig, absentGoal.goalId, { expectedRevision: absentState.revision, cancelKey: 'cancel-absent-v1' });
  const absentAttempt = absentCanceled.work[0].turns[0].attempts[0]; assert.equal(absentCanceled.lifecycle, 'canceled'); assert.equal(absentAttempt.status, 'canceled');
  assert.equal(absentAttempt.taskRevision, undefined); assert.equal(absentAttempt.executorEpoch, undefined); assert.equal(absentAttempt.runFingerprint, undefined); assert.equal(absentAttempt.terminalObservation.headSha, baseSha);

  const terminalBarrierGoal = await approved('persistent-terminal-publication-barrier-v1', [{ workId: 'work_pause', title: 'Terminal publication barrier', goal: 'Modify src/a.txt while the test fences terminal task writeback.', acceptanceCriteria: ['Terminal publication is retried'], fileGlobs: ['src/a.txt'] }]);
  await startPersistentGoal(executionConfig, terminalBarrierGoal.goalId, { expectedRevision: terminalBarrierGoal.revision, startKey: 'start-terminal-publication-barrier-v1' });
  const barrierRunning = await poll(() => getGoal(storeConfig, terminalBarrierGoal.goalId), (goal) => goal.work[0].status === 'running' && goal.work[0].codingTaskId && goal.work[0].operationId);
  const barrierWork = barrierRunning.work[0];
  const barrierRun = await poll(() => getCodingTaskRun(storeConfig, barrierWork.codingTaskId, barrierWork.operationId), (run) => run.status === 'running' && run.runnerAlive && run.runnerPid);
  const barrierRunStatePath = path.join(dataRoot, 'tasks', barrierWork.codingTaskId, 'runs', `run_${createHash('sha256').update(barrierWork.operationId).digest('hex').slice(0, 32)}`, 'state.json');
  const runningRunBytes = await fs.readFile(barrierRunStatePath); const syntheticTerminal = JSON.parse(runningRunBytes);
  process.kill(barrierRun.runnerPid, 'SIGSTOP');
  try {
    syntheticTerminal.status = 'waiting_review'; syntheticTerminal.updatedAt = new Date().toISOString(); syntheticTerminal.finishedAt = syntheticTerminal.updatedAt;
    await fs.writeFile(barrierRunStatePath, `${JSON.stringify(syntheticTerminal, null, 2)}\n`, { mode: 0o600 });
    const published = await getCodingTaskRun(storeConfig, barrierWork.codingTaskId, barrierWork.operationId);
    assert.equal(published.status, 'waiting_review'); assert.equal(published.runnerAlive, true, 'fixture must hold the exact window after terminal run publication and before fenced task finish');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const deferred = await getGoal(storeConfig, terminalBarrierGoal.goalId);
    assert.equal(deferred.lifecycle, 'running', `terminal publication must defer instead of failing: ${JSON.stringify({ lifecycle: deferred.lifecycle, error: deferred.error, work: deferred.work[0] })}`); assert.notEqual(deferred.work[0].status, 'failed');
    await fs.writeFile(barrierRunStatePath, runningRunBytes, { mode: 0o600 });
  } finally { process.kill(barrierRun.runnerPid, 'SIGCONT'); }
  const barrierDone = await poll(() => getPersistentGoalScheduler(storeConfig, terminalBarrierGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped', 20_000);
  assert.equal(barrierDone.goal.work[0].status, 'integrated');

  const pausedGoal = await approved('persistent-pause-v1', [{ workId: 'work_pause', title: 'Pause', goal: 'Modify src/a.txt slowly.', acceptanceCriteria: ['Pause'], fileGlobs: ['src/a.txt'] }]);
  await startPersistentGoal(executionConfig, pausedGoal.goalId, { expectedRevision: pausedGoal.revision, startKey: 'start-pause-v1' });
  const runningPause = await poll(() => getGoal(storeConfig, pausedGoal.goalId), (goal) => goal.work[0].status === 'running');
  const pauseOwner = await poll(() => getPersistentGoalScheduler(storeConfig, pausedGoal.goalId), (view) => view.schedulerAlive);
  process.kill(pauseOwner.runtime.pid, 'SIGSTOP');
  const pauseRuntimePath = path.join(dataRoot, 'goals', pausedGoal.goalId, 'scheduler', 'runtime.json');
  const staleRuntime = { ...pauseOwner.runtime, heartbeatAt: new Date(Date.now() - 60_000).toISOString() };
  await fs.writeFile(pauseRuntimePath, `${JSON.stringify(staleRuntime, null, 2)}\n`, { mode: 0o600 });
  const staleRetries = await Promise.all(Array.from({ length: 20 }, () => startPersistentGoal(executionConfig, pausedGoal.goalId, { expectedRevision: pausedGoal.revision, startKey: 'start-pause-v1' })));
  assert.equal(staleRetries.every((result) => result.reused), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const unchangedOwner = JSON.parse(await fs.readFile(pauseRuntimePath, 'utf8'));
  assert.equal(unchangedOwner.pid, pauseOwner.runtime.pid); assert.equal(unchangedOwner.processNonce, pauseOwner.runtime.processNonce, 'lock waiters must never overwrite the live scheduler runtime owner');
  process.kill(pauseOwner.runtime.pid, 'SIGCONT');
  const paused = await pauseGoal(storeConfig, pausedGoal.goalId, { expectedRevision: runningPause.revision, requestKey: 'pause-v1' }); assert.equal(paused.lifecycle, 'paused');
  await new Promise((resolve) => setTimeout(resolve, 1_000)); const stillPaused = await getGoal(storeConfig, pausedGoal.goalId); assert.equal(stillPaused.lifecycle, 'paused'); assert.notEqual(stillPaused.work[0].status, 'integrated');
  const pausedStopped = await poll(() => getPersistentGoalScheduler(storeConfig, pausedGoal.goalId), (view) => !view.schedulerAlive && view.runtime?.status === 'stopped');
  const quiescentState = await fs.readFile(path.join(dataRoot, 'goals', pausedGoal.goalId, 'state.json')); const quiescentRuntime = await fs.readFile(pauseRuntimePath);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', pausedGoal.goalId, 'state.json')), quiescentState, 'nonblocking retry children must not claim after the owner stops');
  assert.deepEqual(await fs.readFile(pauseRuntimePath), quiescentRuntime, 'nonblocking retry children must leave no later runtime mutation');
  const pausedDefinitionPath = path.join(dataRoot, 'goals', pausedGoal.goalId, 'scheduler', `definition-${pausedStopped.goal.scheduler.definitionFingerprint}.json`);
  await runPersistentGoalScheduler(pausedDefinitionPath, dataRoot);
  assert.deepEqual(await fs.readFile(path.join(dataRoot, 'goals', pausedGoal.goalId, 'state.json')), quiescentState, 'delayed scheduler invocation after paused stop must be a byte-identical no-op');
  assert.deepEqual(await fs.readFile(pauseRuntimePath), quiescentRuntime, 'delayed scheduler invocation after paused stop must not rewrite runtime');
  const pausedStricter = createGoalContentPolicySnapshot([...policy.blockedGlobs, '**/*.paused-secret']);
  await assert.rejects(startPersistentGoal(executionConfig, pausedGoal.goalId, { expectedRevision: pausedStopped.goal.revision, startKey: 'start-pause-v1', runtimeContentPolicy: pausedStricter }), /require resumePersistentGoal|Only explicit persistent resume/);
  assert.equal((await getGoal(storeConfig, pausedGoal.goalId)).lifecycle, 'paused');
  const resumed = await resumePersistentGoal(executionConfig, pausedGoal.goalId, { expectedRevision: pausedStopped.goal.revision, resumeKey: 'resume-v1', runtimeContentPolicy: pausedStricter }); assert.equal(resumed.goal.lifecycle, 'running');
  assert.deepEqual(resumed.definition.contentPolicy.blockedGlobs, pausedStricter.blockedGlobs);
  await poll(() => getGoal(storeConfig, pausedGoal.goalId), (goal) => goal.lifecycle === 'waiting_review');

  const immediateGoal = await approved('persistent-immediate-resume-v1', [{ workId: 'work_pause', title: 'Immediate resume', goal: 'Resume without an arbitrary delay.', acceptanceCriteria: ['Exactly once'], fileGlobs: ['src/a.txt'] }]);
  const priorPauseStarts = (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length;
  await startPersistentGoal(executionConfig, immediateGoal.goalId, { expectedRevision: immediateGoal.revision, startKey: 'start-immediate-v1' });
  const immediateRunning = await poll(() => getGoal(storeConfig, immediateGoal.goalId), (goal) => goal.work[0].status === 'running');
  const immediateStartsBefore = await poll(async () => (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length, (count) => count > priorPauseStarts);
  const immediatePaused = await pauseGoal(storeConfig, immediateGoal.goalId, { expectedRevision: immediateRunning.revision, requestKey: 'pause-immediate-v1' });
  const immediateResumed = await resumePersistentGoal(executionConfig, immediateGoal.goalId, { expectedRevision: immediatePaused.revision, resumeKey: 'resume-immediate-v1' });
  assert.equal(immediateResumed.goal.lifecycle, 'running', 'immediate resume must publish new scheduler authority after old-owner quiescence');
  const immediateDone = await poll(() => getPersistentGoalScheduler(storeConfig, immediateGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped');
  assert.equal(immediateDone.goal.work[0].status, 'integrated');
  assert.equal(immediateDone.runtime.epoch, immediateDone.goal.scheduler.epoch, 'old scheduler terminal write must not overwrite resumed runtime epoch');
  assert.equal(immediateDone.runtime.leaseId, immediateDone.goal.scheduler.leaseId, 'old scheduler terminal write must not overwrite resumed runtime lease');
  assert.equal(immediateDone.runtime.definitionFingerprint, immediateDone.goal.scheduler.definitionFingerprint);
  const immediateStartsAfter = (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length;
  assert.equal(immediateStartsAfter, immediateStartsBefore, 'resume must recover the same running operation without a fresh worker launch');

  const cancelGoal = await approved('persistent-cancel-v1', [{ workId: 'work_cancel', title: 'Cancel', goal: 'Modify src/a.txt slowly.', acceptanceCriteria: ['Cancel'], fileGlobs: ['src/a.txt'] }]);
  await startPersistentGoal(executionConfig, cancelGoal.goalId, { expectedRevision: cancelGoal.revision, startKey: 'start-cancel-v1' });
  const cancelRunning = await poll(() => getGoal(storeConfig, cancelGoal.goalId), (goal) => goal.work[0].status === 'running');
  let canceling = await requestPersistentGoalCancel(storeConfig, cancelGoal.goalId, { expectedRevision: cancelRunning.revision, cancelKey: 'cancel-v1', reason: 'smoke cancel' }); assert.ok(['canceling', 'canceled'].includes(canceling.lifecycle));
  canceling = await poll(async () => requestPersistentGoalCancel(storeConfig, cancelGoal.goalId, { expectedRevision: cancelRunning.revision, cancelKey: 'cancel-v1', reason: 'smoke cancel' }), (goal) => goal.lifecycle === 'canceled'); assert.equal(canceling.lifecycle, 'canceled');

  const secretProposed = await proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...exhaustInput, goalKey: 'persistent-secret-v1', work: [{ workId: 'work_secret', title: 'Secret', goal: 'Create src/.ENV.', acceptanceCriteria: ['Secret'], fileGlobs: ['src/**'] }] });
  const secretGoal = await approveGoal(storeConfig, secretProposed.goal.goalId, { expectedRevision: secretProposed.goal.revision, contractFingerprint: secretProposed.goal.contractFingerprint, approvalKey: 'approve-secret-v1' });
  await startPersistentGoal(executionConfig, secretGoal.goalId, { expectedRevision: secretGoal.revision, startKey: 'start-secret-v1' });
  const blocked = await poll(() => getGoal(storeConfig, secretGoal.goalId), (goal) => goal.lifecycle === 'failed'); assert.match(blocked.error, /content|review/i); assert.equal(blocked.work[0].turns[0].attempts.length, 1, 'policy/content failure is never retryable'); assert.equal(blocked.integrationHeadSha, baseSha); assert.equal(await fs.stat(path.join(sourceRoot, 'src', '.ENV')).then(() => true, () => false), false);

  const recoveryGoal = await approved('persistent-recovery-v1', [{ workId: 'work_pause', title: 'Crash recovery', goal: 'Modify src/a.txt once.', acceptanceCriteria: ['Recovered'], fileGlobs: ['src/a.txt'] }]);
  const recoveryStartsBefore = (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length;
  await startPersistentGoal(executionConfig, recoveryGoal.goalId, { expectedRevision: recoveryGoal.revision, startKey: 'start-recovery-v1' });
  const recoveryActive = await poll(() => getPersistentGoalScheduler(storeConfig, recoveryGoal.goalId), (view) => view.schedulerAlive && view.goal.work[0].status === 'running');
  const historicalEpoch = recoveryActive.goal.work[0].launch.schedulerEpoch;
  process.kill(recoveryActive.runtime.pid, 'SIGKILL');
  await poll(() => getPersistentGoalScheduler(storeConfig, recoveryGoal.goalId), (view) => !view.schedulerAlive);
  const stricterPolicy = createGoalContentPolicySnapshot([...policy.blockedGlobs, '**/*.key']);
  const recoveredStart = await startPersistentGoal(executionConfig, recoveryGoal.goalId, { expectedRevision: recoveryGoal.revision, startKey: 'start-recovery-v1', runtimeContentPolicy: stricterPolicy });
  assert.equal(recoveredStart.reused, true);
  assert.deepEqual(recoveredStart.definition.contentPolicy.blockedGlobs, stricterPolicy.blockedGlobs);
  await assert.rejects(startPersistentGoal(executionConfig, recoveryGoal.goalId, { expectedRevision: recoveryGoal.revision, startKey: 'start-recovery-v1', runtimeContentPolicy: policy }), /cannot be loosened/);
  const recovered = await poll(() => getPersistentGoalScheduler(storeConfig, recoveryGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped');
  assert.ok(recovered.goal.scheduler.epoch > historicalEpoch);
  assert.equal(recovered.goal.work[0].launch.schedulerEpoch, historicalEpoch, 'reservation provenance remains immutable across scheduler takeover');
  assert.equal((await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length, recoveryStartsBefore + 1, 'scheduler recovery must resume the exact operation without a fresh worker launch');

  const tamperGoal = await approved('persistent-tamper-v1', [{ workId: 'work_tamper', title: 'Tamper', goal: 'Modify src/a.txt.', acceptanceCriteria: ['Untampered'], fileGlobs: ['src/a.txt'] }]);
  const tamperStatePath = path.join(dataRoot, 'goals', tamperGoal.goalId, 'state.json');
  const tampered = JSON.parse(await fs.readFile(tamperStatePath, 'utf8')); tampered.work[0].goal = 'broadened unapproved work';
  await fs.writeFile(tamperStatePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(startPersistentGoal(executionConfig, tamperGoal.goalId, { expectedRevision: tamperGoal.revision, startKey: 'start-tamper-v1' }), /contract fingerprint/);
  assert.equal(await fs.stat(path.join(dataRoot, 'goals', tamperGoal.goalId, 'scheduler')).then(() => true, () => false), false);
  assert.equal(await fs.stat(tamperGoal.integrationWorktreeRoot).then(() => true, () => false), false);

  const legacyApproved = async (goalKey, work) => { const current = await approved(goalKey, work); const legacy = structuredClone(current); delete legacy.retryPolicy; legacy.contractFingerprint = computeGoalContractFingerprint(legacy); legacy.approval.contractFingerprint = legacy.contractFingerprint; await fs.writeFile(path.join(dataRoot, 'goals', legacy.goalId, 'state.json'), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 }); return legacy; };
  const noRunGoal = await legacyApproved('persistent-created-no-run-v1', [{ workId: 'work_no_run', title: 'No run', goal: 'Do not launch after cancellation.', acceptanceCriteria: ['Fenced'], fileGlobs: ['src/a.txt'] }]);
  const noRunTask = await createCodingTask(storeConfig, { root: sourceRoot }, undefined, { taskKey: `goal:${noRunGoal.goalId}:work_no_run`, title: 'Reserved child', goal: 'Reserved but never launched.', executor: 'codex', baseSha, goalId: noRunGoal.goalId, goalWorkId: 'work_no_run' });
  const noRunStatePath = path.join(dataRoot, 'goals', noRunGoal.goalId, 'state.json'); const noRunNow = new Date().toISOString();
  const noRunOperationId = `goal:${noRunGoal.goalId.slice(5)}:work_no_run:run:1`;
  const noRunState = { ...noRunGoal, lifecycle: 'running', startKey: 'start-no-run-v1', integrationHeadSha: baseSha, scheduler: { epoch: 1, leaseId: 'lease-no-run-v1', startKey: 'start-no-run-v1', definitionFingerprint: 'a'.repeat(64), status: 'queued', requestedAt: noRunNow }, revision: noRunGoal.revision + 1, updatedAt: noRunNow, startedAt: noRunNow, work: noRunGoal.work.map((work) => ({ ...work, status: 'launching', baseSha, operationId: noRunOperationId, launch: { launchKey: `goal:${noRunGoal.goalId}:${work.workId}:launch:1`, taskKey: `goal:${noRunGoal.goalId}:${work.workId}`, taskId: noRunTask.task.taskId, schedulerEpoch: 1, schedulerLeaseId: 'lease-no-run-v1', operationId: noRunOperationId, baseSha, reservedAt: noRunNow } })) };
  await fs.writeFile(noRunStatePath, `${JSON.stringify(noRunState, null, 2)}\n`, { mode: 0o600 });
  const begunNoRunTask = await beginCodingTaskOperation(storeConfig, noRunTask.task.taskId, { expectedRevision: noRunTask.task.revision, executor: 'codex', executorEpoch: noRunTask.task.executorLease.epoch, leaseId: noRunTask.task.executorLease.leaseId, operationId: noRunOperationId });
  assert.equal(begunNoRunTask.activeOperation.operationId, noRunOperationId, 'fixture must persist the crash state after synthetic begin');
  const noRunArtifacts = path.join(dataRoot, 'tasks', noRunTask.task.taskId, 'runs');
  assert.equal(await fs.stat(noRunArtifacts).then(() => true, () => false), false, 'synthetic begin crash fixture must not create a run artifact');
  const noRunCanceled = await requestPersistentGoalCancel(storeConfig, noRunGoal.goalId, { expectedRevision: noRunState.revision, cancelKey: 'cancel-no-run-v1' }); assert.equal(noRunCanceled.lifecycle, 'canceled');
  const retiredTask = await getCodingTask(storeConfig, noRunTask.task.taskId); assert.equal(retiredTask.lifecycle, 'canceled'); assert.equal(retiredTask.executor, 'direct');
  assert.equal(await fs.stat(noRunArtifacts).then(() => true, () => false), false, 'cancel recovery must not fabricate a run artifact');
  const noRunGoalBytes = await fs.readFile(noRunStatePath); const noRunTaskPath = path.join(dataRoot, 'tasks', noRunTask.task.taskId, 'state.json'); const noRunTaskBytes = await fs.readFile(noRunTaskPath);
  const noRunCancelRetry = await requestPersistentGoalCancel(storeConfig, noRunGoal.goalId, { expectedRevision: noRunState.revision, cancelKey: 'cancel-no-run-v1' });
  assert.equal(noRunCancelRetry.revision, noRunCanceled.revision); assert.deepEqual(await fs.readFile(noRunStatePath), noRunGoalBytes); assert.deepEqual(await fs.readFile(noRunTaskPath), noRunTaskBytes);
  await assert.rejects(launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, retiredTask.taskId, { operationId: noRunState.work[0].operationId, prompt: 'must not launch', expectedRevision: retiredTask.revision, executorEpoch: retiredTask.executorLease.epoch, leaseId: retiredTask.executorLease.leaseId }), /not owned by Codex/);

  const terminalCrashGoal = await legacyApproved('persistent-terminal-crash-v1', [{ workId: 'work_terminal_crash', title: 'Terminal crash', goal: 'Exercise terminal run recovery.', acceptanceCriteria: ['Recovered'], fileGlobs: ['src/a.txt'] }]);
  const crashTask = await createCodingTask(storeConfig, { root: sourceRoot }, undefined, { taskKey: `goal:${terminalCrashGoal.goalId}:work_terminal_crash`, title: 'Terminal crash child', goal: 'Modify src/a.txt.', executor: 'codex', baseSha, goalId: terminalCrashGoal.goalId, goalWorkId: 'work_terminal_crash' });
  const crashOperationId = `goal:${terminalCrashGoal.goalId.slice(5)}:work_terminal_crash:run:1`;
  await launchCodingTaskRun({ dataRoot, codexBinary: fakeCodex }, crashTask.task.taskId, { operationId: crashOperationId, prompt: 'Work item: work_pause terminal crash', expectedRevision: crashTask.task.revision, executorEpoch: crashTask.task.executorLease.epoch, leaseId: crashTask.task.executorLease.leaseId, timeoutMs: 5_000 });
  const begunCrashTask = await poll(() => getCodingTask(storeConfig, crashTask.task.taskId), (task) => task.activeOperation?.operationId === crashOperationId && task.codexTurnActive);
  await poll(() => getCodingTaskRun(storeConfig, crashTask.task.taskId, crashOperationId), (run) => ['waiting_review', 'completed'].includes(run.status) && !run.runnerAlive);
  await fs.writeFile(path.join(dataRoot, 'tasks', crashTask.task.taskId, 'state.json'), `${JSON.stringify(begunCrashTask, null, 2)}\n`, { mode: 0o600 });
  const crashNow = new Date().toISOString(); const crashGoalStatePath = path.join(dataRoot, 'goals', terminalCrashGoal.goalId, 'state.json');
  const crashGoalState = { ...terminalCrashGoal, lifecycle: 'running', startKey: 'start-terminal-crash-v1', integrationHeadSha: baseSha, scheduler: { epoch: 1, leaseId: 'lease-terminal-crash-v1', startKey: 'start-terminal-crash-v1', definitionFingerprint: 'b'.repeat(64), status: 'queued', requestedAt: crashNow }, revision: terminalCrashGoal.revision + 1, updatedAt: crashNow, startedAt: crashNow, work: terminalCrashGoal.work.map((work) => ({ ...work, status: 'running', baseSha, codingTaskId: crashTask.task.taskId, operationId: crashOperationId, launch: { launchKey: `goal:${terminalCrashGoal.goalId}:${work.workId}:launch:1`, taskKey: `goal:${terminalCrashGoal.goalId}:${work.workId}`, taskId: crashTask.task.taskId, schedulerEpoch: 1, schedulerLeaseId: 'lease-terminal-crash-v1', operationId: crashOperationId, baseSha, reservedAt: crashNow } })) };
  await fs.writeFile(crashGoalStatePath, `${JSON.stringify(crashGoalState, null, 2)}\n`, { mode: 0o600 });
  const crashCanceled = await requestPersistentGoalCancel(storeConfig, terminalCrashGoal.goalId, { expectedRevision: crashGoalState.revision, cancelKey: 'cancel-terminal-crash-v1' });
  assert.equal(crashCanceled.lifecycle, 'canceled'); const crashRetiredTask = await getCodingTask(storeConfig, crashTask.task.taskId); assert.equal(crashRetiredTask.lifecycle, 'canceled'); assert.equal(crashRetiredTask.activeOperation, undefined); assert.equal(crashRetiredTask.executor, 'direct');

  const huge = 'x'.repeat(1_000);
  await assert.rejects(proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...baseInput, goalKey: 'persistent-prompt-bound-v1', work: Array.from({ length: 3 }, (_, index) => ({ workId: `work_huge_${index}`, title: huge.slice(0, 500), goal: 'x'.repeat(20_000), acceptanceCriteria: Array.from({ length: 50 }, () => huge.repeat(2)), verification: Array.from({ length: 50 }, () => huge.repeat(2)), fileGlobs: Array.from({ length: 100 }, (_, item) => `src/${index}/${item}/${huge.slice(0, 900)}`) })) }), /256KiB runner safety bound/);
  assert.equal((await fs.readdir(path.join(dataRoot, 'goals'))).some((name) => name.includes('prompt-bound')), false);
  await assert.rejects(proposeGoal(storeConfig, { root: sourceRoot }, undefined, { ...baseInput, goalKey: 'persistent-continuation-aggregate-bound-v1', limits: { ...baseInput.limits, maxTurnsPerWorker: 4 }, work: Array.from({ length: 3 }, (_, index) => ({ workId: `work_bound_${index}`, title: 'Bound', goal: 'Remain bounded.', acceptanceCriteria: ['Bounded'], fileGlobs: ['src/**'], continuationIntents: Array.from({ length: 3 }, (_, turn) => ({ intentId: `intent_${turn}`, prompt: 'p'.repeat(32_000) })) })) }), /aggregate 256KiB/);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatus);
  console.log('goal persistent smoke: ok');
} finally {
  await terminateFixtureProcesses(fixture);
  assert.deepEqual(await fixtureProcesses(fixture), []);
  await fs.rm(fixture, { recursive: true, force: true });
}
