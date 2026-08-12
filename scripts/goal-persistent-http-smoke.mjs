import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const projectRoot = path.resolve('.');
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-persistent-http-')));
const sourceRoot = path.join(fixture, 'source');
const dataRoot = path.join(fixture, 'state');
const jobRoot = path.join(fixture, 'jobs');
const gates = path.join(fixture, 'gates');
const fakeCodex = path.join(fixture, 'fake-codex');
const launchLog = path.join(fixture, 'launch.log');
const token = 'codexpro-persistent-http-smoke-token-2026';
const realMode = process.env.CODEXPRO_REAL_CODEX_E2E === '1';
const codexHome = realMode
  ? await fs.realpath(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')))
  : path.join(fixture, 'codex-home');
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
let server;
let client;
let baseSha;

try {
  await Promise.all([
    fs.mkdir(sourceRoot), fs.mkdir(dataRoot, { mode: 0o700 }), fs.mkdir(jobRoot, { mode: 0o700 }),
    ...(!realMode ? [fs.mkdir(codexHome, { mode: 0o700 })] : []), fs.mkdir(gates, { mode: 0o700 }), fs.writeFile(launchLog, '')
  ]);
  git(['init', '-q']);
  git(['config', 'user.name', 'Persistent Goal HTTP Smoke']);
  git(['config', 'user.email', 'persistent-goal-http@example.invalid']);
  await fs.mkdir(path.join(sourceRoot, 'src'));
  for (const name of ['a', 'b', 'c', 'pause-root', 'pause-child', 'cancel-root', 'cancel-child', 'blocked']) {
    await fs.writeFile(path.join(sourceRoot, 'src', `${name}.txt`), `${name} base\n`);
  }
  await fs.writeFile(path.join(sourceRoot, 'dirty.txt'), 'dirty base\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  await fs.writeFile(path.join(sourceRoot, 'dirty.txt'), 'dirty user edit\n');
  await fs.writeFile(path.join(sourceRoot, 'untracked.txt'), 'untracked user file\n');
  baseSha = git(['rev-parse', 'HEAD']);
  const sourceBefore = await sourceAuthority();

  const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const log=${JSON.stringify(launchLog)}, gates=${JSON.stringify(gates)}; let buf='', slot='unknown'; const id=String(process.pid);
const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
const turn=(status='inProgress')=>({id:'turn-'+id,status,error:null,items:status==='completed'?[{type:'agentMessage',id:'final',text:'Persistent worker '+slot+' completed.',phase:'final_answer'}]:[]});
function finish(thread){fs.appendFileSync(log,'finish:'+slot+':'+Date.now()+'\\n');send({method:'turn/completed',params:{threadId:thread,turn:turn('completed')}})}
function handle(m){if(m.method==='initialize')return send({id:m.id,result:{}});if(m.method==='initialized')return;
if(m.method==='thread/start'||m.method==='thread/resume')return send({id:m.id,result:{thread:{id:m.params.threadId||'thread-'+id,sessionId:'session-'+id,ephemeral:false}}});
if(m.method==='turn/start'){const p=m.params.input?.map(x=>x.text||'').join('\\n')||'';
slot=p.includes('work_primary_a')?'primary-a':p.includes('work_primary_b')?'primary-b':p.includes('work_primary_c')?'primary-c':p.includes('work_pause_root')?'pause-root':p.includes('work_pause_child')?'pause-child':p.includes('work_cancel_root')?'cancel-root':p.includes('work_cancel_child')?'cancel-child':p.includes('work_blocked')?'blocked':'unknown';
fs.appendFileSync(log,'pid:'+slot+':'+id+'\\nstart:'+slot+':'+Date.now()+'\\n');
if(slot==='blocked'){fs.writeFileSync(path.join(process.cwd(),'.env'),'API_TOKEN=blockedSecretSentinel1234567890\\n');fs.writeFileSync(path.join(process.cwd(),'src','blocked.txt'),'blocked allowed companion\\n')}else{const file=slot.replace('primary-','');fs.writeFileSync(path.join(process.cwd(),'src',file+'.txt'),slot+' integrated\\n')}
send({id:m.id,result:{turn:turn()}});const gate=path.join(gates,'hold-'+slot);if(fs.existsSync(gate)){const timer=setInterval(()=>{if(fs.existsSync(path.join(gates,'release-'+slot))){clearInterval(timer);finish('thread-'+id)}},25)}else setTimeout(()=>finish('thread-'+id),slot.startsWith('primary-')?500:100);return}
if(m.method==='turn/interrupt'){fs.appendFileSync(log,'interrupt:'+slot+':'+Date.now()+'\\n');send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:'thread-'+id,turn:turn('interrupted')}})}}
process.stdin.on('data',c=>{buf+=c;for(;;){const i=buf.indexOf('\\n');if(i<0)break;const line=buf.slice(0,i);buf=buf.slice(i+1);if(line.trim())handle(JSON.parse(line))}});
`;
  await fs.writeFile(fakeCodex, fakeSource, { mode: 0o700 }); await fs.chmod(fakeCodex, 0o700);
  const codexBinary = realMode ? await realCodexBinary() : fakeCodex;
  const env = environment({ CODEXPRO_CODEX_BIN: codexBinary });
  server = await startServer(env);
  ({ client } = await connect());
  const inventory = await client.listTools();
  for (const name of ['propose_goal', 'approve_goal', 'start_goal', 'get_goal', 'list_goals', 'review_goal', 'pause_goal', 'resume_goal', 'cancel_goal']) {
    assert.ok(inventory.tools.some((tool) => tool.name === name), `missing persistent Goal tool ${name}`);
  }
  const opened = await call('open_current_workspace', { include_tree: false });

  // Primary production flow: one start, then both MCP client and HTTP server disappear.
  const primary = await createApprovedGoal(opened.structuredContent.workspace_id, {
    key: 'persistent-http-primary-v1', title: 'Persistent HTTP dependency DAG', maxConcurrency: 2,
    work: [
      work('work_primary_a', 'src/a.txt'), work('work_primary_b', 'src/b.txt'),
      work('work_primary_c', 'src/c.txt', ['work_primary_a', 'work_primary_b'])
    ]
  });
  const started = await call('start_goal', { goal_id: primary.goalId, expected_revision: primary.revision, start_key: 'persistent-http-primary-start-v1' });
  assert.equal(started.structuredContent.execution_policy, 'persistent');
  assert.match(started.structuredContent.scheduler_definition_fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(['queued', 'running'].includes(started.structuredContent.scheduler.authority_status));
  const primaryStatePath = goalStatePath(primary.goalId);
  await pollJson(path.join(dataRoot, 'goals', primary.goalId, 'scheduler', 'runtime.json'), (runtime) => ['starting', 'running'].includes(runtime.status), 10_000);
  await client.close(); client = undefined;
  await stopServer(server); server = undefined;
  const completedOnDisk = await pollJson(primaryStatePath, (state) => state.lifecycle === 'waiting_review' && state.scheduler?.status === 'stopped', realMode ? 600_000 : 30_000);
  assert.equal(completedOnDisk.work.every((item) => item.status === 'integrated'), true);
  assert.equal(completedOnDisk.scheduler.status, 'stopped');
  assert.equal(completedOnDisk.scheduler.stopReason, 'semantic_review');
  await assertPersistentQuiescence(primary.goalId, completedOnDisk);
  assert.deepEqual(await sourceAuthority(), sourceBefore, 'detached persistent scheduling must not change source Git authority');
  if (!realMode) {
    const launches = await launchLines();
    for (const slot of ['primary-a', 'primary-b', 'primary-c']) assert.equal(launches.filter((line) => line.startsWith(`start:${slot}:`)).length, 1);
    assert.ok(Math.max(timeOf(launches, 'primary-a', 'start'), timeOf(launches, 'primary-b', 'start')) < Math.min(timeOf(launches, 'primary-a', 'finish'), timeOf(launches, 'primary-b', 'finish')), 'max_concurrency=2 must run both independent roots concurrently');
    assert.ok(timeOf(launches, 'primary-c', 'start') > Math.max(timeOf(launches, 'primary-a', 'finish'), timeOf(launches, 'primary-b', 'finish')), 'dependent C must launch after both parents finish and are integrated');
  }

  server = await startServer(env); ({ client } = await connect());
  const passiveState = await fs.readFile(primaryStatePath); const passiveGoalTree = await snapshotTree(path.join(dataRoot, 'goals', primary.goalId)); const launchesBeforePassive = await fs.readFile(launchLog);
  const got = await call('get_goal', { goal_id: primary.goalId });
  assert.equal(got.structuredContent.lifecycle, 'waiting_review'); assert.equal(got.structuredContent.scheduler_alive, false);
  assert.equal(got.structuredContent.scheduler.stop_reason, 'semantic_review');
  const listed = await call('list_goals', { limit: 100 }); assert.ok(listed.structuredContent.goals.some((goal) => goal.goalId === primary.goalId));
  const reviewed = await call('review_goal', { goal_id: primary.goalId });
  assert.deepEqual(reviewed.structuredContent.review.changedPaths, ['src/a.txt', 'src/b.txt', 'src/c.txt']);
  assert.equal(reviewed.structuredContent.review.changedFileCount, 3, 'Goal review changedFileCount must count authoritative base-relative changedPaths, not clean worktree status');
  assert.equal(reviewed.structuredContent.changed_files_count, 3, 'Goal review must expose a snake_case changed-files alias for cards and MCP clients');
  assert.equal((reviewed.structuredContent.review.diff.match(/^diff --git /gm) ?? []).length, 3, 'Goal review diff must contain exactly the three reported changedPaths');
  assert.equal(reviewed.structuredContent.integrated_changes_present, true);
  assert.match(reviewed.structuredContent.review.diff, /primary-a integrated/); assert.match(reviewed.structuredContent.review.diff, /primary-c integrated/);
  assert.deepEqual(await fs.readFile(primaryStatePath), passiveState, 'get/list/review must be passive');
  assert.deepEqual(await snapshotTree(path.join(dataRoot, 'goals', primary.goalId)), passiveGoalTree, 'get/list/review must leave all Goal scheduler persistence byte-identical');
  assert.deepEqual(await fs.readFile(launchLog), launchesBeforePassive, 'get/list/review must not spawn');
  const primaryRuntimePath = path.join(dataRoot, 'goals', primary.goalId, 'scheduler', 'runtime.json');
  const waitingRuntime = await fs.readFile(primaryRuntimePath);
  await callError('pause_goal', { goal_id: primary.goalId, expected_revision: got.structuredContent.revision, pause_key: 'persistent-http-waiting-pause-v1' }, /running persistent Goal|waiting_review|pause/i);
  assert.deepEqual(await fs.readFile(primaryStatePath), passiveState, 'waiting_review persistent pause refusal must not mutate Goal state');
  assert.deepEqual(await fs.readFile(primaryRuntimePath), waitingRuntime, 'waiting_review persistent pause refusal must not mutate scheduler runtime');
  assert.deepEqual(await fs.readFile(launchLog), launchesBeforePassive, 'waiting_review persistent pause refusal must not spawn');
  const retry = await call('start_goal', { goal_id: primary.goalId, expected_revision: started.structuredContent.revision, start_key: 'persistent-http-primary-start-v1' });
  assert.equal(retry.structuredContent.lifecycle, 'waiting_review');
  assert.deepEqual(await fs.readFile(primaryStatePath), passiveState, 'terminal same-key start retry must be byte-idempotent');

  if (!realMode) {
    // Pause linearizes before terminal reconciliation/integration and resume explicitly wakes a new scheduler epoch.
    await fs.writeFile(path.join(gates, 'hold-pause-root'), '1');
    const pausedFixture = await createApprovedGoal(opened.structuredContent.workspace_id, {
      key: 'persistent-http-pause-v1', title: 'Persistent pause and resume', maxConcurrency: 1,
      work: [work('work_pause_root', 'src/pause-root.txt'), work('work_pause_child', 'src/pause-child.txt', ['work_pause_root'])]
    });
    const pauseStarted = await call('start_goal', { goal_id: pausedFixture.goalId, expected_revision: pausedFixture.revision, start_key: 'persistent-http-pause-start-v1' });
    await waitLaunch('pause-root');
    const pauseRunning = await pollTool('get_goal', { goal_id: pausedFixture.goalId }, (result) => result.structuredContent.work.find((item) => item.workId === 'work_pause_root')?.status === 'running', 10_000);
    const paused = await call('pause_goal', { goal_id: pausedFixture.goalId, expected_revision: pauseRunning.structuredContent.revision, pause_key: 'persistent-http-pause-v1' });
    assert.equal(paused.structuredContent.lifecycle, 'paused');
    const pausedSchedulerAuthority = paused.structuredContent.goal.scheduler;
    const pausedStatePath = goalStatePath(pausedFixture.goalId);
    const resumed = await call('resume_goal', { goal_id: pausedFixture.goalId, expected_revision: paused.structuredContent.revision, resume_key: 'persistent-http-resume-v1' });
    assert.equal(resumed.structuredContent.lifecycle, 'running');
    await fs.writeFile(path.join(gates, 'release-pause-root'), '1');
    const resumedDone = await pollJson(pausedStatePath, (state) => state.lifecycle === 'waiting_review' && state.scheduler?.status === 'stopped', 20_000);
    assert.equal(resumedDone.work.every((item) => item.status === 'integrated'), true); await waitLaunch('pause-child');
    const pauseLaunches = await launchLines();
    assert.equal(pauseLaunches.filter((line) => line.startsWith('start:pause-root:')).length, 1, 'resume must reuse the active root run exactly once');
    assert.equal(pauseLaunches.filter((line) => line.startsWith('start:pause-child:')).length, 1, 'resume must launch the dependent exactly once');
    assert.equal(resumedDone.scheduler.epoch, pausedSchedulerAuthority.epoch + 1, 'immediate resume must establish a new scheduler epoch without a lost wakeup');
    const resumedRuntime = await pollJson(path.join(dataRoot, 'goals', pausedFixture.goalId, 'scheduler', 'runtime.json'), (runtime) => runtime.status === 'stopped' && runtime.epoch === resumedDone.scheduler.epoch && runtime.leaseId === resumedDone.scheduler.leaseId, 5_000);
    assert.equal(resumedRuntime.epoch, resumedDone.scheduler.epoch, 'terminal runtime epoch must equal resumed Goal authority');
    assert.equal(resumedRuntime.leaseId, resumedDone.scheduler.leaseId, 'terminal runtime lease must equal resumed Goal authority');
    assert.equal(resumedRuntime.definitionFingerprint, resumedDone.scheduler.definitionFingerprint, 'terminal runtime definition must equal resumed Goal authority');
    assert.equal(resumedRuntime.status, 'stopped'); assert.equal(resumedRuntime.stopReason, 'semantic_review');

    // Cancel wins over active work and prevents every dependent launch/integration.
    await fs.writeFile(path.join(gates, 'hold-cancel-root'), '1');
    const cancelFixture = await createApprovedGoal(opened.structuredContent.workspace_id, {
      key: 'persistent-http-cancel-v1', title: 'Persistent cancel dominance', maxConcurrency: 1,
      work: [work('work_cancel_root', 'src/cancel-root.txt'), work('work_cancel_child', 'src/cancel-child.txt', ['work_cancel_root'])]
    });
    const cancelStarted = await call('start_goal', { goal_id: cancelFixture.goalId, expected_revision: cancelFixture.revision, start_key: 'persistent-http-cancel-start-v1' });
    await waitLaunch('cancel-root');
    let canceled = await requestCancel(cancelFixture.goalId, 'persistent-http-cancel-v1', 'HTTP cancel dominance fixture');
    if (canceled.structuredContent.lifecycle === 'canceling') {
      canceled = await pollCancel(cancelFixture.goalId, 'persistent-http-cancel-v1', 'HTTP cancel dominance fixture', 15_000);
    }
    assert.equal(canceled.structuredContent.lifecycle, 'canceled'); assert.equal((await launchLines()).some((line) => line.startsWith('start:cancel-child:')), false);
    assert.equal(canceled.structuredContent.work.some((item) => item.status === 'integrated'), false);

    // A secret/blocked worker result fails closed and never reaches private integration or source.
    const blockedFixture = await createApprovedGoal(opened.structuredContent.workspace_id, {
      key: 'persistent-http-blocked-v1', title: 'Persistent blocked content', maxConcurrency: 1,
      work: [work('work_blocked', 'src/blocked.txt')]
    });
    await call('start_goal', { goal_id: blockedFixture.goalId, expected_revision: blockedFixture.revision, start_key: 'persistent-http-blocked-start-v1' });
    const blockedState = await pollJson(goalStatePath(blockedFixture.goalId), (state) => state.lifecycle === 'failed', 20_000);
    assert.equal(blockedState.integrationHeadSha, baseSha); assert.doesNotMatch(JSON.stringify(await call('get_goal', { goal_id: blockedFixture.goalId })), /blockedSecretSentinel1234567890/);
    assert.doesNotMatch(JSON.stringify(await call('review_goal', { goal_id: blockedFixture.goalId })), /blockedSecretSentinel1234567890/);
    await assert.rejects(fs.stat(path.join(sourceRoot, '.env')), { code: 'ENOENT' });
  }

  assert.deepEqual(await sourceAuthority(), sourceBefore, 'all persistent Goal scheduler flows must leave source bytes, index, HEAD, refs, and status unchanged');

  // Off mode has no Codex executable and cannot wake execution; passive surfaces remain byte-identical and no-spawn.
  await client.close(); client = undefined; await stopServer(server); server = undefined;
  const primaryBeforeOff = await snapshotTree(path.join(dataRoot, 'goals', primary.goalId)); const launchesBeforeOff = await fs.readFile(launchLog);
  const offEnv = environment({ CODEXPRO_WRITE_MODE: 'off', CODEXPRO_BASH_MODE: 'off', CODEXPRO_CODEX_BIN: undefined, PATH: '/usr/bin:/bin' });
  server = await startServer(offEnv); ({ client } = await connect());
  const offTools = await client.listTools(); assert.equal(offTools.tools.some((tool) => ['start_goal', 'resume_goal'].includes(tool.name)), false);
  await call('get_goal', { goal_id: primary.goalId }); await call('list_goals', { limit: 100 }); await call('review_goal', { goal_id: primary.goalId });
  assert.deepEqual(await snapshotTree(path.join(dataRoot, 'goals', primary.goalId)), primaryBeforeOff); assert.deepEqual(await fs.readFile(launchLog), launchesBeforeOff);
  assert.deepEqual(await sourceAuthority(), sourceBefore);

  console.log(`persistent Goal HTTP smoke: ok (${realMode ? 'installed real Codex' : 'deterministic worker App Server'})`);
  console.log(`  goal=${primary.goalId} base=${baseSha.slice(0, 12)} scheduler=detached dependencies=integrated`);
  if (realMode) console.log(`  real_codex=${codexBinary} codex_home=${codexHome}`);
  if (!realMode) console.log('  real mode: CODEXPRO_REAL_CODEX_E2E=1 CODEXPRO_REAL_CODEX_BIN=/absolute/path/to/codex npm run goal:persistent-http-smoke');
} finally {
  await client?.close().catch(() => undefined); if (server) await stopServer(server).catch(() => undefined);
  await removeFixture();
}

function work(workId, pathname, dependsOn = []) { const content = `${workId.replace(/^work_/, '').replaceAll('_', '-')} integrated\n`; return { work_id: workId, title: workId, goal: `Replace only ${pathname}; its entire content must be exactly ${JSON.stringify(content)}. Do not modify any other path.`, acceptance_criteria: [`${pathname} has exactly ${JSON.stringify(content)}`], verification: ['git diff --check'], depends_on: dependsOn, file_globs: [pathname] }; }
async function createApprovedGoal(workspaceId, fixtureInput) {
  const proposed = await call('propose_goal', { workspace_id: workspaceId, goal_key: fixtureInput.key, title: fixtureInput.title, goal: 'Execute this approved DAG mechanically in private worktrees.', completion_criteria: ['All work is integrated for semantic review'], verification: ['git diff --check'], execution_policy: 'persistent', workspace_policy: 'isolated', permissions: { file_globs: fixtureInput.work.flatMap((item) => item.file_globs), commands: [], network: false, source_effects: { apply: false, commit: false, push: false, draft_pr: false } }, base_sha: baseSha, limits: { max_concurrency: fixtureInput.maxConcurrency, timeout_ms: realMode ? 600_000 : 30_000, max_turns_per_worker: 1, max_retries_per_worker: 0 }, work: fixtureInput.work });
  const approved = await call('approve_goal', { goal_id: proposed.structuredContent.goal_id, expected_revision: proposed.structuredContent.revision, contract_fingerprint: proposed.structuredContent.contract_fingerprint, approval_key: `${fixtureInput.key}-approval`, confirm: true });
  return { goalId: approved.structuredContent.goal_id, revision: approved.structuredContent.revision };
}
function environment(overrides = {}) { const out = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', CODEXPRO_ROOT: sourceRoot, CODEXPRO_ALLOWED_ROOTS: sourceRoot, CODEXPRO_HOST: '127.0.0.1', CODEXPRO_PORT: String(port), CODEXPRO_HTTP_TOKEN: token, CODEXPRO_BASH_MODE: 'full', CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full', CODEXPRO_TASK_DIR: dataRoot, CODEXPRO_JOB_DIR: jobRoot, CODEXPRO_CODEX_DIR: codexHome, CODEXPRO_CODEX_MODEL: 'gpt-5.6-sol', CODEXPRO_CODEX_REASONING_EFFORT: 'high', CODEXPRO_CODING_TASK_TIMEOUT_MS: realMode ? '600000' : '30000', CODEXPRO_TOOL_CARDS: '1', CODEXPRO_INHERIT_ENV: '0', ...overrides }; for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key]; return out; }
function git(args) { const result = spawnSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }
async function sourceAuthority() { return { head: git(['rev-parse', 'HEAD']), refs: git(['show-ref']), log: git(['log', '-1', '--format=%H:%s']), status: git(['status', '--porcelain=v2', '--untracked-files=all']), diff: git(['diff', '--binary']), staged: git(['diff', '--cached', '--binary']), tree: git(['write-tree']), files: Object.fromEntries(await Promise.all((await fs.readdir(path.join(sourceRoot, 'src'))).sort().map(async (name) => [name, await fs.readFile(path.join(sourceRoot, 'src', name), 'base64')]))), dirty: await fs.readFile(path.join(sourceRoot, 'dirty.txt'), 'base64'), untracked: await fs.readFile(path.join(sourceRoot, 'untracked.txt'), 'base64') }; }
async function assertPersistentQuiescence(goalId, state) { const runtime = JSON.parse(await fs.readFile(path.join(dataRoot, 'goals', goalId, 'scheduler', 'runtime.json'), 'utf8')); const runnerPids = []; for (const item of state.work) { if (!item.codingTaskId) continue; for (const [, encoded] of await snapshotTree(path.join(dataRoot, 'tasks', item.codingTaskId))) { const parsed = tryJson(Buffer.from(encoded, 'base64').toString('utf8')); if (Number.isSafeInteger(parsed?.runnerPid)) runnerPids.push(parsed.runnerPid); } } const appPids = realMode ? [] : (await launchLines()).filter((line) => line.startsWith('pid:primary-')).map((line) => Number(line.split(':').at(-1))); for (const pid of new Set([runtime.pid, ...runnerPids, ...appPids])) await waitProcessExit(pid, 5_000); }
async function snapshotTree(root) { const entries = []; async function visit(directory, prefix = '') { for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(directory, entry.name); if (entry.isDirectory()) await visit(absolute, relative); else entries.push([relative, (await fs.readFile(absolute)).toString('base64')]); } } await visit(root); return entries; }
function tryJson(text) { try { return JSON.parse(text); } catch { return undefined; } }
function processAlive(pid) { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
async function waitProcessExit(pid, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (!processAlive(pid)) return; await delay(25); } throw new Error(`Persistent Goal process ${pid} remained live after terminal scheduler state.`); }
function goalStatePath(goalId) { return path.join(dataRoot, 'goals', goalId, 'state.json'); }
async function launchLines() { return (await fs.readFile(launchLog, 'utf8')).trim().split('\n').filter(Boolean); }
function timeOf(lines, slot, kind) { return Number(lines.find((line) => line.startsWith(`${kind}:${slot}:`))?.split(':').at(-1) || 0); }
async function waitLaunch(slot) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if ((await launchLines()).some((line) => line.startsWith(`start:${slot}:`))) return; await delay(25); } throw new Error(`Timed out waiting for ${slot} launch`); }
async function pollJson(filename, predicate, timeout) { const deadline = Date.now() + timeout; let value; while (Date.now() < deadline) { try { value = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; } if (value && predicate(value)) return value; await delay(50); } throw new Error(`Timed out polling ${filename}: ${JSON.stringify(value)}`); }
async function pollTool(name, args, predicate, timeout) { const deadline = Date.now() + timeout; let result; while (Date.now() < deadline) { result = await call(name, args); if (predicate(result)) return result; await delay(100); } throw new Error(`Timed out polling ${name}: ${JSON.stringify(result?.structuredContent)}`); }
async function requestCancel(goalId, cancelKey, reason) { for (let attempt=0;attempt<30;attempt+=1) { const current=await call('get_goal',{goal_id:goalId}); const result=await client.callTool({name:'cancel_goal',arguments:{goal_id:goalId,expected_revision:current.structuredContent.revision,cancel_key:cancelKey,reason}}); if(!result.isError)return result; if(!/revision conflict/i.test(JSON.stringify(result)))throw new Error(`cancel_goal failed: ${JSON.stringify(result)}`); await delay(20); } throw new Error('cancel_goal could not linearize against scheduler revisions'); }
async function pollCancel(goalId, cancelKey, reason, timeout) { const deadline=Date.now()+timeout; let result; while(Date.now()<deadline){result=await requestCancel(goalId,cancelKey,reason);if(result.structuredContent.lifecycle==='canceled')return result;await delay(100)}throw new Error(`Timed out polling cancel_goal: ${JSON.stringify(result?.structuredContent)}`); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function freePort() { return new Promise((resolve, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); socket.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
async function realCodexBinary() { const requested = process.env.CODEXPRO_REAL_CODEX_BIN || spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim(); if (!requested) throw new Error('Real Codex E2E requires CODEXPRO_REAL_CODEX_BIN or codex on PATH.'); const resolved = await fs.realpath(path.resolve(requested)); const stat = await fs.stat(resolved); if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`Real Codex binary is not an executable regular file: ${resolved}`); return resolved; }
async function startServer(env) { const child = spawn(process.execPath, ['dist/http.js'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr=''; child.stderr.on('data', (chunk) => { stderr += String(chunk); }); const deadline=Date.now()+10_000; while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(`HTTP server exited ${child.exitCode}: ${stderr}`);try{const response=await fetch(`${baseUrl}/healthz`,{headers:{Authorization:`Bearer ${token}`}});if(response.ok)return child}catch{}await delay(50)}child.kill('SIGTERM');throw new Error(`Timed out waiting for HTTP server: ${stderr}`); }
async function stopServer(child) { if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise((resolve)=>child.once('exit',resolve)),delay(3_000)]); }
async function removeFixture() { for (let attempt=0;attempt<20;attempt+=1) { try { await fs.rm(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:50}); return; } catch (error) { if (attempt===19) throw error; await delay(100); } } }
async function connect() { const transport=new StreamableHTTPClientTransport(new URL(mcpUrl),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});const connected=new Client({name:'codexpro-persistent-goal-http-smoke',version:'1.0.0'});await connected.connect(transport);return{client:connected,transport}; }
async function call(name,args={}) { const result=await client.callTool({name,arguments:args});if(result.isError){const message=result.content?.find?.((part)=>part.type==='text')?.text||JSON.stringify(result.structuredContent);throw new Error(`${name} failed: ${message}`)}return result; }
async function callError(name,args,pattern) { const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true,`${name} must fail closed`);assert.match(JSON.stringify(result),pattern);return result; }
