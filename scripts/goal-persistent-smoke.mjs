import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { approveGoal, getGoal, pauseGoal, proposeGoal } from '../dist/goalOps.js';
import { createGoalContentPolicySnapshot } from '../dist/goalPolicy.js';
import { getPersistentGoalScheduler, requestPersistentGoalCancel, resumePersistentGoal, runPersistentGoalScheduler, startPersistentGoal } from '../dist/goalScheduler.js';
import { beginCodingTaskOperation, createCodingTask, getCodingTask } from '../dist/codingTaskOps.js';
import { getCodingTaskRun, launchCodingTaskRun } from '../dist/codingTaskRunner.js';
import { reviewGoal } from '../dist/goalExecution.js';

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
  const sourceRoot = path.join(fixture, 'source'); const dataRoot = path.join(fixture, 'state'); const fakeCodex = path.join(fixture, 'fake-codex'); const launches = path.join(fixture, 'launches.log');
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
const launches=${JSON.stringify(launches)}; let buffer=''; let slot=''; const threadId='thread-stable'; const sessionId='session-stable'; const turnId='turn-'+process.pid;
function send(v){process.stdout.write(JSON.stringify(v)+'\\n')} function turn(status='inProgress'){return {id:turnId,status,error:null,items:status==='completed'?[{type:'agentMessage',id:'final',text:'persistent '+slot+' complete',phase:'final_answer'}]:[]}}
function handle(m){ if(m.method==='initialize')return send({id:m.id,result:{}}); if(m.method==='initialized')return; if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId||threadId,sessionId,ephemeral:false}}}); if(m.method==='turn/start'){const prompt=m.params.input?.map(x=>x.text||'').join('\\n')||''; slot=prompt.includes('work_noop')?'noop':prompt.includes('work_pause')?'pause':prompt.includes('work_cancel')?'cancel':prompt.includes('work_secret')?'secret':prompt.includes('work_b')?'b':'a'; fs.appendFileSync(launches,'start:'+slot+'\\n'); if(slot==='secret')fs.writeFileSync(path.join(process.cwd(),'src','.ENV'),'TOP_SECRET=1\\n'); else if(slot!=='noop')fs.writeFileSync(path.join(process.cwd(),'src',slot==='b'?'b.txt':'a.txt'),'persistent '+slot+'\\n'); send({id:m.id,result:{turn:turn()}}); setTimeout(()=>{fs.appendFileSync(launches,'finish:'+slot+'\\n');send({method:'turn/completed',params:{threadId,turn:turn('completed')}})},slot==='pause'||slot==='cancel'?1500:100); return} if(m.method==='turn/interrupt'){send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId,turn:turn('interrupted')}})}}
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
  assert.deepEqual(multiWork.turns.map((turn) => turn.operationId), [`goal:${multi.goalId.slice(5)}:work_multi:run:1`, `goal:${multi.goalId.slice(5)}:work_multi:run:2`]);
  assert.equal(multiWork.turns[0].taskId, multiWork.turns[1].taskId); assert.equal(multiWork.turns[0].threadId, multiWork.turns[1].threadId); assert.equal(multiWork.turns[0].sessionId, multiWork.turns[1].sessionId);
  assert.equal(multiWork.integrationKey, `goal:${multi.goalId}:work_multi:integrate:1`);
  assert.equal(git(multiDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '1', 'only the final authorized cumulative checkpoint integrates once');

  const noOpGoal = await approved('persistent-noop-v1', [{ workId: 'work_noop', title: 'No-op', goal: 'Inspect only and make no changes.', acceptanceCriteria: ['No change is a valid authorized result'], fileGlobs: ['src/a.txt'] }]);
  await startPersistentGoal(executionConfig, noOpGoal.goalId, { expectedRevision: noOpGoal.revision, startKey: 'start-noop-v1' });
  const noOpDone = await poll(() => getPersistentGoalScheduler(storeConfig, noOpGoal.goalId), (view) => view.goal.lifecycle === 'waiting_review' && view.runtime?.status === 'stopped');
  assert.equal(noOpDone.goal.work[0].status, 'integrated'); assert.equal(noOpDone.goal.integrationHeadSha, baseSha);
  assert.deepEqual(noOpDone.goal.work[0].turns[0].terminalObservation.changedPaths, []);
  assert.equal(git(noOpDone.goal.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '0', 'valid no-op integration must not fabricate a commit');

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
    assert.equal(deferred.lifecycle, 'running'); assert.notEqual(deferred.work[0].status, 'failed');
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
  await startPersistentGoal(executionConfig, immediateGoal.goalId, { expectedRevision: immediateGoal.revision, startKey: 'start-immediate-v1' });
  const immediateRunning = await poll(() => getGoal(storeConfig, immediateGoal.goalId), (goal) => goal.work[0].status === 'running');
  const immediateStartsBefore = (await fs.readFile(launches, 'utf8')).split('\n').filter((line) => line === 'start:pause').length;
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

  const secretGoal = await approved('persistent-secret-v1', [{ workId: 'work_secret', title: 'Secret', goal: 'Create src/.ENV.', acceptanceCriteria: ['Secret'], fileGlobs: ['src/**'] }]);
  await startPersistentGoal(executionConfig, secretGoal.goalId, { expectedRevision: secretGoal.revision, startKey: 'start-secret-v1' });
  const blocked = await poll(() => getGoal(storeConfig, secretGoal.goalId), (goal) => goal.lifecycle === 'failed'); assert.match(blocked.error, /content|review/i); assert.equal(blocked.integrationHeadSha, baseSha); assert.equal(await fs.stat(path.join(sourceRoot, 'src', '.ENV')).then(() => true, () => false), false);

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

  const noRunGoal = await approved('persistent-created-no-run-v1', [{ workId: 'work_no_run', title: 'No run', goal: 'Do not launch after cancellation.', acceptanceCriteria: ['Fenced'], fileGlobs: ['src/a.txt'] }]);
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

  const terminalCrashGoal = await approved('persistent-terminal-crash-v1', [{ workId: 'work_terminal_crash', title: 'Terminal crash', goal: 'Exercise terminal run recovery.', acceptanceCriteria: ['Recovered'], fileGlobs: ['src/a.txt'] }]);
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
