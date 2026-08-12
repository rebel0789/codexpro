import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const projectRoot = path.resolve('.');
const realMode = process.env.CODEXPRO_REAL_CODEX_E2E === '1';
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-multiturn-http-')));
const sourceRoot = path.join(fixture, 'source');
const dataRoot = path.join(fixture, 'state');
const jobRoot = path.join(fixture, 'jobs');
const gates = path.join(fixture, 'gates');
const protocolLog = path.join(fixture, 'protocol.jsonl');
const fakeCodex = path.join(fixture, 'fake-codex');
const codexHome = realMode ? await fs.realpath(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))) : path.join(fixture, 'codex-home');
const port = await freePort();
const token = 'codexpro-goal-multiturn-http-smoke-token';
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let client;

try {
  await Promise.all([
    fs.mkdir(sourceRoot), fs.mkdir(dataRoot, { mode: 0o700 }), fs.mkdir(jobRoot, { mode: 0o700 }),
    fs.mkdir(gates, { mode: 0o700 }), fs.writeFile(protocolLog, ''), ...(!realMode ? [fs.mkdir(codexHome, { mode: 0o700 })] : [])
  ]);
  git(['init', '-q']); git(['config', 'user.name', 'Goal Multiturn HTTP']); git(['config', 'user.email', 'goal-multiturn@example.invalid']);
  await fs.mkdir(path.join(sourceRoot, 'src'));
  await fs.writeFile(path.join(sourceRoot, 'src', 'multi-turn.txt'), 'base\n');
  await fs.writeFile(path.join(sourceRoot, 'dirty.txt'), 'dirty base\n');
  await fs.writeFile(path.join(sourceRoot, 'staged.txt'), 'staged base\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  await fs.writeFile(path.join(sourceRoot, 'dirty.txt'), 'dirty user edit\n');
  await fs.writeFile(path.join(sourceRoot, 'staged.txt'), 'staged user edit\n'); git(['add', 'staged.txt']);
  await fs.writeFile(path.join(sourceRoot, 'untracked.txt'), 'untracked user file\n');
  const baseSha = git(['rev-parse', 'HEAD']); const sourceBefore = await sourceAuthority();

  if (!realMode) {
    const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const log=${JSON.stringify(protocolLog)}, gates=${JSON.stringify(gates)}, threadId='thread-multiturn-stable', sessionId='session-multiturn-stable'; let buffer='';
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n'); const record=(value)=>fs.appendFileSync(log,JSON.stringify({...value,pid:process.pid,at:Date.now()})+'\\n');
function complete(turnId,text){send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null,items:[{type:'agentMessage',id:'final',text,phase:'final_answer'}]}}})}
function handle(message){
 if(message.method==='initialize')return send({id:message.id,result:{}}); if(message.method==='initialized')return;
 if(message.method==='thread/start'){record({kind:'thread_start'});return send({id:message.id,result:{thread:{id:threadId,sessionId,ephemeral:false}}})}
 if(message.method==='thread/resume'){record({kind:'thread_resume',requestedThreadId:message.params.threadId});return send({id:message.id,result:{thread:{id:threadId,sessionId,ephemeral:false}}})}
 if(message.method==='turn/start'){const operationId=message.params.clientUserMessageId;const second=operationId.endsWith(':run:2');const turnId=second?'turn-multiturn-two':'turn-multiturn-one';const file=path.join(process.cwd(),'src','multi-turn.txt');const observed=fs.readFileSync(file,'utf8');record({kind:'turn_start',operationId,turnId,threadId:message.params.threadId,observed});send({id:message.id,result:{turn:{id:turnId,status:'inProgress',error:null,items:[]}}});
  if(!second){fs.writeFileSync(file,'turn one complete\\n');setTimeout(()=>complete(turnId,'Turn one exact mutation complete.'),100);return}
  const timer=setInterval(()=>{if(fs.existsSync(path.join(gates,'release-turn-two'))){clearInterval(timer);fs.writeFileSync(file,'turn one complete\\nturn two complete\\n');record({kind:'turn_two_mutated',operationId,turnId});complete(turnId,'Turn two observed turn one and wrote the exact final content.')}},25);return}
 if(message.method==='turn/interrupt'){send({id:message.id,result:{}})}
}
process.stdin.on('data',(chunk)=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\\n');if(index<0)break;const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())handle(JSON.parse(line))}});
`;
    await fs.writeFile(fakeCodex, fakeSource, { mode: 0o700 }); await fs.chmod(fakeCodex, 0o700);
    const fakeCheck = spawnSync(process.execPath, ['--check', fakeCodex], { encoding: 'utf8' }); if (fakeCheck.status !== 0) throw new Error(`Invalid fake App Server: ${fakeCheck.stderr}`);
  }
  const codexBinary = realMode ? await realCodexBinary() : fakeCodex;
  const env = environment(codexBinary);
  server = await startServer(env); ({ client } = await connect());
  const opened = await call('open_current_workspace', { include_tree: false });
  const proposed = await call('propose_goal', {
    workspace_id: opened.structuredContent.workspace_id, goal_key: 'persistent-multiturn-http-v1', title: 'Persistent two-turn HTTP Goal',
    goal: 'Run exactly two pre-approved turns on one persistent CodingTask and integrate only the final cumulative checkpoint.',
    completion_criteria: ['The final private checkpoint has the exact approved two-line content'], verification: ['git diff --check'],
    execution_policy: 'persistent', workspace_policy: 'isolated', worker_model: process.env.CODEXPRO_REAL_CODEX_MODEL || 'gpt-5.6-sol', worker_effort: process.env.CODEXPRO_REAL_CODEX_EFFORT || 'high',
    limits: { max_concurrency: 1, timeout_ms: realMode ? 600_000 : 30_000, max_turns_per_worker: 2, max_retries_per_worker: 0 },
    permissions: { file_globs: ['src/multi-turn.txt'], commands: [], network: false, source_effects: { apply: false, commit: false, push: false, draft_pr: false } }, base_sha: baseSha,
    work: [{ work_id: 'work_multiturn', title: 'Two bounded turns', goal: 'Replace only src/multi-turn.txt with exactly "turn one complete\\n". Do not modify another path.', acceptance_criteria: ['Turn one exact content is present before continuation'], verification: ['git diff --check'], file_globs: ['src/multi-turn.txt'], continuation_intents: [{ intent_id: 'finalize_exact', prompt: 'Read src/multi-turn.txt and verify it is exactly "turn one complete\\n". Then replace only that file with exactly "turn one complete\\nturn two complete\\n". Do not modify another path.' }] }]
  });
  assert.equal(proposed.structuredContent.work[0].continuationIntents.length, 1);
  assert.match(proposed.structuredContent.work[0].continuationIntents[0].fingerprint, /^[0-9a-f]{64}$/);
  const approved = await call('approve_goal', { goal_id: proposed.structuredContent.goal_id, expected_revision: proposed.structuredContent.revision, contract_fingerprint: proposed.structuredContent.contract_fingerprint, approval_key: 'persistent-multiturn-http-approve-v1', confirm: true });
  const goalId = approved.structuredContent.goal_id; const goalStatePath = path.join(dataRoot, 'goals', goalId, 'state.json');
  const started = await call('start_goal', { goal_id: goalId, expected_revision: approved.structuredContent.revision, start_key: 'persistent-multiturn-http-start-v1' });
  assert.equal(started.structuredContent.execution_policy, 'persistent');
  await pollJson(path.join(dataRoot, 'goals', goalId, 'scheduler', 'runtime.json'), (runtime) => runtime && ['starting', 'running'].includes(runtime.status), 10_000);
  await client.close(); client = undefined; await stopServer(server); server = undefined;

  let intermediate;
  let firstRunBefore;
  if (!realMode) {
    const turnTwoReady = await poll(async () => ({ events: await protocolEvents(), state: await fs.readFile(goalStatePath, 'utf8').then(JSON.parse) }), (value) => value.state.lifecycle === 'failed' || value.events.some((event) => event.kind === 'turn_start' && event.operationId.endsWith(':run:2')), 30_000);
    if (turnTwoReady.state.lifecycle === 'failed') throw new Error(`Persistent multiturn scheduler failed before turn two: ${turnTwoReady.state.error}; task evidence=${JSON.stringify(await snapshotTree(path.join(dataRoot, 'tasks')))}`);
    intermediate = await pollJson(goalStatePath, (state) => state.work[0].turns?.length === 2 && state.work[0].turns[0].status === 'succeeded' && ['reserved', 'running'].includes(state.work[0].turns[1].status), 30_000);
    const work = intermediate.work[0]; const [turnOne, turnTwo] = work.turns;
    assert.equal(work.status === 'continuing' || work.status === 'running', true); assert.equal(work.integratedCommitSha, undefined);
    assert.equal(intermediate.integrationHeadSha, baseSha); assert.equal(gitAt(intermediate.integrationWorktreeRoot, ['rev-parse', 'HEAD']), baseSha);
    assert.equal(gitAt(intermediate.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '0');
    await assert.rejects(fs.stat(path.join(dataRoot, 'goals', goalId, 'integrations', 'work_multiturn.json')), { code: 'ENOENT' });
    assert.equal(turnOne.taskId, turnTwo.taskId); assert.equal(turnTwo.previousOperationId, turnOne.operationId);
    assert.deepEqual([turnOne.operationId, turnTwo.operationId], [`goal:${goalId.slice(5)}:work_multiturn:run:1`, `goal:${goalId.slice(5)}:work_multiturn:run:2`]);
    assert.equal(turnOne.threadId, 'thread-multiturn-stable'); assert.equal(turnOne.sessionId, 'session-multiturn-stable'); assert.equal(turnOne.turnId, 'turn-multiturn-one');
    const events = await protocolEvents(); const resume = events.find((event) => event.kind === 'thread_resume'); const second = events.find((event) => event.kind === 'turn_start' && event.operationId.endsWith(':run:2'));
    assert.equal(resume.requestedThreadId, turnOne.threadId); assert.equal(second.threadId, turnOne.threadId); assert.equal(second.observed, 'turn one complete\n');
    firstRunBefore = await snapshotTree(runDir(turnOne.taskId, turnOne.operationId));
    assert.deepEqual(await sourceAuthority(), sourceBefore, 'intermediate successful turn must not affect source authority');

    server = await startServer(env); ({ client } = await connect());
    const stateBeforePassive = await fs.readFile(goalStatePath); const protocolBeforePassive = await fs.readFile(protocolLog);
    const passiveGet = await call('get_goal', { goal_id: goalId }); const passiveList = await call('list_goals', { limit: 100 }); const passiveReview = await call('review_goal', { goal_id: goalId });
    assert.equal(passiveGet.structuredContent.work[0].turns.length, 2); assert.ok(passiveList.structuredContent.goals.some((goal) => goal.goalId === goalId));
    assert.equal(passiveReview.structuredContent.review.changedFileCount, 0); assert.equal(passiveReview.structuredContent.review.diff, '');
    assert.deepEqual(await fs.readFile(goalStatePath), stateBeforePassive, 'passive restart reads must not mutate Goal state'); assert.deepEqual(await fs.readFile(protocolLog), protocolBeforePassive, 'passive restart reads must not launch another turn');
    await fs.writeFile(path.join(gates, 'release-turn-two'), '1');
  }

  const done = await pollJson(goalStatePath, (state) => state.lifecycle === 'waiting_review' && state.scheduler?.status === 'stopped', realMode ? 600_000 : 30_000);
  if (!client) { server = await startServer(env); ({ client } = await connect()); }
  const work = done.work[0]; const [turnOne, turnTwo] = work.turns;
  assert.equal(work.status, 'integrated'); assert.equal(work.turns.length, 2); assert.deepEqual(work.turns.map((turn) => turn.status), ['succeeded', 'succeeded']);
  assert.deepEqual(work.turns.map((turn) => turn.operationId), [`goal:${goalId.slice(5)}:work_multiturn:run:1`, `goal:${goalId.slice(5)}:work_multiturn:run:2`]);
  assert.equal(turnOne.taskId, turnTwo.taskId); assert.equal(turnOne.baseSha, turnTwo.baseSha); assert.equal(turnOne.threadId, turnTwo.threadId); assert.equal(turnOne.sessionId, turnTwo.sessionId); assert.notEqual(turnOne.turnId, turnTwo.turnId);
  assert.equal(turnTwo.previousOperationId, turnOne.operationId); assert.equal(turnTwo.intentId, 'finalize_exact'); assert.equal(work.integrationKey, `goal:${goalId}:work_multiturn:integrate:1`);
  assert.equal(gitAt(done.integrationWorktreeRoot, ['rev-list', '--count', `${baseSha}..HEAD`]), '1', 'only the final cumulative checkpoint may integrate');
  assert.equal(await fs.readFile(path.join(done.integrationWorktreeRoot, 'src', 'multi-turn.txt'), 'utf8'), 'turn one complete\nturn two complete\n');
  if (!realMode) {
    assert.equal(turnTwo.threadId, 'thread-multiturn-stable'); assert.equal(turnTwo.sessionId, 'session-multiturn-stable'); assert.equal(turnTwo.turnId, 'turn-multiturn-two');
    assert.deepEqual(await snapshotTree(runDir(turnOne.taskId, turnOne.operationId)), firstRunBefore, 'turn one immutable run evidence must survive turn two byte-identically');
    assert.equal((await protocolEvents()).filter((event) => event.kind === 'turn_start').length, 2, 'the approved contract must launch exactly two turns and no retry');
  }
  const review = await call('review_goal', { goal_id: goalId });
  assert.deepEqual(review.structuredContent.review.changedPaths, ['src/multi-turn.txt']); assert.equal(review.structuredContent.review.changedFileCount, 1);
  assert.match(review.structuredContent.review.diff, /turn one complete/); assert.match(review.structuredContent.review.diff, /turn two complete/);
  const terminalState = await fs.readFile(goalStatePath); const retried = await call('start_goal', { goal_id: goalId, expected_revision: started.structuredContent.revision, start_key: 'persistent-multiturn-http-start-v1' });
  assert.equal(retried.structuredContent.lifecycle, 'waiting_review'); assert.deepEqual(await fs.readFile(goalStatePath), terminalState, 'same-key terminal restart must be byte-idempotent');
  assert.deepEqual(await sourceAuthority(), sourceBefore, 'two-turn persistent Goal must preserve source HEAD, refs, index, staged, unstaged, and untracked bytes');

  console.log(`Goal multiturn HTTP smoke: ok (${realMode ? 'installed real Codex' : 'deterministic worker App Server'})`);
  console.log(`  goal=${goalId} task=${turnOne.taskId} thread=${turnOne.threadId} turns=2 integration_commits=1`);
  if (!realMode) console.log('  real mode: CODEXPRO_REAL_CODEX_E2E=1 CODEXPRO_REAL_CODEX_BIN=/absolute/path/to/codex npm run goal:multiturn-http-smoke');
} finally {
  await client?.close().catch(() => undefined); if (server) await stopServer(server).catch(() => undefined); await terminateFixtureProcesses(); await fs.rm(fixture, { recursive: true, force: true });
}

function environment(codexBinary) { return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C', CODEXPRO_ROOT: sourceRoot, CODEXPRO_ALLOWED_ROOTS: sourceRoot, CODEXPRO_HOST: '127.0.0.1', CODEXPRO_PORT: String(port), CODEXPRO_HTTP_TOKEN: token, CODEXPRO_BASH_MODE: 'full', CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full', CODEXPRO_TASK_DIR: dataRoot, CODEXPRO_JOB_DIR: jobRoot, CODEXPRO_CODEX_DIR: codexHome, CODEXPRO_CODEX_BIN: codexBinary, CODEXPRO_CODEX_MODEL: process.env.CODEXPRO_REAL_CODEX_MODEL || 'gpt-5.6-sol', CODEXPRO_CODEX_REASONING_EFFORT: process.env.CODEXPRO_REAL_CODEX_EFFORT || 'high', CODEXPRO_CODING_TASK_TIMEOUT_MS: realMode ? '600000' : '30000', CODEXPRO_TOOL_CARDS: '0', CODEXPRO_INHERIT_ENV: '0' }; }
function git(args) { return gitAt(sourceRoot, args); }
function gitAt(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`); return result.stdout.trim(); }
async function sourceAuthority() { return { head: git(['rev-parse', 'HEAD']), refs: git(['show-ref']), status: git(['status', '--porcelain=v2', '--untracked-files=all']), diff: git(['diff', '--binary']), staged: git(['diff', '--cached', '--binary']), tree: git(['write-tree']), source: await fs.readFile(path.join(sourceRoot, 'src', 'multi-turn.txt'), 'base64'), dirty: await fs.readFile(path.join(sourceRoot, 'dirty.txt'), 'base64'), stagedFile: await fs.readFile(path.join(sourceRoot, 'staged.txt'), 'base64'), untracked: await fs.readFile(path.join(sourceRoot, 'untracked.txt'), 'base64') }; }
function runDir(taskId, operationId) { return path.join(dataRoot, 'tasks', taskId, 'runs', `run_${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`); }
async function snapshotTree(root) { const entries = []; async function visit(directory, prefix = '') { for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const absolute = path.join(directory, entry.name); if (entry.isDirectory()) await visit(absolute, relative); else entries.push([relative, (await fs.readFile(absolute)).toString('base64')]); } } await visit(root); return entries; }
async function protocolEvents() { return (await fs.readFile(protocolLog, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
async function poll(read, predicate, timeout) { const deadline = Date.now() + timeout; let value; while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await delay(50); } throw new Error(`Timed out polling: ${JSON.stringify(value)}`); }
async function pollJson(filename, predicate, timeout) { return poll(async () => { try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; } }, predicate, timeout); }
async function freePort() { return new Promise((resolve, reject) => { const listener = net.createServer(); listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { const address = listener.address(); listener.close((error) => error ? reject(error) : resolve(address.port)); }); }); }
async function realCodexBinary() { const requested = process.env.CODEXPRO_REAL_CODEX_BIN || spawnSync('which', ['codex'], { encoding: 'utf8' }).stdout.trim(); if (!requested) throw new Error('Real mode requires CODEXPRO_REAL_CODEX_BIN or codex on PATH.'); const resolved = await fs.realpath(path.resolve(requested)); const stat = await fs.stat(resolved); if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`Real Codex is not executable: ${resolved}`); return resolved; }
async function startServer(env) { const child = spawn(process.execPath, ['dist/http.js'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', (chunk) => { stderr += String(chunk); }); const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (child.exitCode !== null) throw new Error(`HTTP server exited ${child.exitCode}: ${stderr}`); try { const response = await fetch(`${baseUrl}/healthz`, { headers: { Authorization: `Bearer ${token}` } }); if (response.ok) return child; } catch {} await delay(50); } child.kill('SIGTERM'); throw new Error(`HTTP server timeout: ${stderr}`); }
async function stopServer(child) { if (child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(3_000)]); }
async function connect() { const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }); const connected = new Client({ name: 'codexpro-goal-multiturn-http-smoke', version: '1.0.0' }); await connected.connect(transport); return { client: connected }; }
async function call(name, args = {}) { const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error(`${name} failed: ${result.content?.find?.((part) => part.type === 'text')?.text || JSON.stringify(result.structuredContent)}`); return result; }
async function fixtureProcesses() { return spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout.split('\n').flatMap((line) => { const match = line.trim().match(/^(\d+)\s+(.+)$/); return match && Number(match[1]) !== process.pid && match[2].includes(`${fixture}${path.sep}`) ? [Number(match[1])] : []; }); }
async function terminateFixtureProcesses() { for (let attempt = 0; attempt < 40; attempt += 1) { const pids = await fixtureProcesses(); if (!pids.length) return; for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch {} await delay(50); } for (const pid of await fixtureProcesses()) try { process.kill(pid, 'SIGKILL'); } catch {} }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
