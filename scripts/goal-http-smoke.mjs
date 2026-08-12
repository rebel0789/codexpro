import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const projectRoot = path.resolve('.');
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-http-')));
const sourceRoot = path.join(fixture, 'source');
const dataRoot = path.join(fixture, 'state');
const jobRoot = path.join(fixture, 'jobs');
const codexHome = path.join(fixture, 'codex-home');
const fakeCodex = path.join(fixture, 'fake-codex');
const launchLog = path.join(fixture, 'launch.log');
const token = 'codexpro-goal-http-smoke-token-2026';
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
let server;
let client;

try {
  await Promise.all([
    fs.mkdir(sourceRoot),
    fs.mkdir(dataRoot, { mode: 0o700 }),
    fs.mkdir(jobRoot, { mode: 0o700 }),
    fs.mkdir(codexHome, { mode: 0o700 })
  ]);
  git(sourceRoot, ['init', '-q']);
  git(sourceRoot, ['config', 'user.name', 'Goal HTTP Smoke']);
  git(sourceRoot, ['config', 'user.email', 'goal-http@example.invalid']);
  await fs.mkdir(path.join(sourceRoot, 'src'));
  await fs.writeFile(path.join(sourceRoot, 'src', 'alpha.txt'), 'alpha base\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'src', 'beta.txt'), 'beta base\n', 'utf8');
  git(sourceRoot, ['add', '--', 'src/alpha.txt', 'src/beta.txt']);
  git(sourceRoot, ['commit', '-qm', 'base']);
  const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  const refsBefore = git(sourceRoot, ['show-ref']);

  const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const log = ${JSON.stringify(launchLog)};
let buffer = '';
let slot = 'unknown';
const id = String(process.pid);
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function turn(status = 'inProgress') { return { id: 'turn-' + id, status, error: null, items: status === 'completed' ? [{ type: 'agentMessage', id: 'final', text: 'Goal worker ' + slot + ' completed with git diff --check.', phase: 'final_answer' }] : [] }; }
function handle(message) {
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId || 'thread-' + id, sessionId: 'session-' + id, ephemeral: false } } });
  if (message.method === 'turn/start') {
    const prompt = message.params.input?.map((item) => item.text || '').join('\\n') || '';
    slot = prompt.includes('work_alpha') ? 'alpha' : prompt.includes('work_beta') ? 'beta' : 'unknown';
    fs.appendFileSync(log, 'start:' + slot + ':' + Date.now() + '\\n');
    fs.writeFileSync(path.join(process.cwd(), 'src', slot + '.txt'), slot + ' from Goal worker\\n');
    send({ id: message.id, result: { turn: turn() } });
    setTimeout(() => {
      fs.appendFileSync(log, 'finish:' + slot + ':' + Date.now() + '\\n');
      send({ method: 'turn/completed', params: { threadId: 'thread-' + id, turn: turn('completed') } });
    }, 600);
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'thread-' + id, turn: turn('interrupted') } });
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

  const env = cleanEnv({
    CODEXPRO_ROOT: sourceRoot,
    CODEXPRO_ALLOWED_ROOTS: sourceRoot,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'full',
    CODEXPRO_WRITE_MODE: 'workspace',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TASK_DIR: dataRoot,
    CODEXPRO_JOB_DIR: jobRoot,
    CODEXPRO_CODEX_DIR: codexHome,
    CODEXPRO_CODEX_BIN: fakeCodex,
    CODEXPRO_CODEX_MODEL: 'gpt-5.6-sol',
    CODEXPRO_CODEX_REASONING_EFFORT: 'high',
    CODEXPRO_CODING_TASK_TIMEOUT_MS: '30000',
    CODEXPRO_TOOL_CARDS: '1',
    CODEXPRO_INHERIT_ENV: '0'
  });
  server = await startServer(env);
  ({ client } = await connectClient(mcpUrl, token));
  const tools = await client.listTools();
  for (const name of ['propose_goal', 'approve_goal', 'start_goal', 'get_goal', 'refresh_goal', 'publish_goal_blackboard', 'integrate_goal_work', 'review_goal', 'complete_goal', 'apply_goal']) {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing Goal tool ${name}`);
    assert.match(tool._meta?.ui?.resourceUri || '', /^ui:\/\/widget\/codexpro-tool-card-/);
  }
  const opened = await callTool(client, 'open_current_workspace', { include_tree: false });
  const proposed = await callTool(client, 'propose_goal', {
    workspace_id: opened.structuredContent.workspace_id,
    goal_key: 'http-parallel-goal-v1',
    title: 'HTTP parallel Goal',
    goal: 'Run two workers, recover across reconnect, integrate, review, and apply.',
    completion_criteria: ['Alpha and beta are integrated'],
    verification: ['git diff --check'],
    execution_policy: 'supervised',
    workspace_policy: 'isolated',
    permissions: {
      file_globs: ['src/**'],
      commands: ['git diff --check'],
      network: false,
      source_effects: { apply: true, commit: false, push: false, draft_pr: false }
    },
    base_sha: baseSha,
    limits: { max_concurrency: 2, timeout_ms: 30000, max_turns_per_worker: 1, max_retries_per_worker: 0 },
    work: [
      { work_id: 'work_alpha', title: 'Implement alpha', goal: 'Modify only src/alpha.txt.', acceptance_criteria: ['Alpha is complete'], verification: ['git diff --check'], file_globs: ['src/alpha.txt'], parallel_group: 'parallel' },
      { work_id: 'work_beta', title: 'Implement beta', goal: 'Modify only src/beta.txt.', acceptance_criteria: ['Beta is complete'], verification: ['git diff --check'], file_globs: ['src/beta.txt'], parallel_group: 'parallel' }
    ]
  });
  const goalId = proposed.structuredContent.goal_id;
  assert.match(goalId, /^goal_[a-f0-9]{24}$/);
  assert.equal(proposed.structuredContent.lifecycle, 'proposed');
  assert.equal(proposed.structuredContent.execution_started, false);
  await assert.rejects(fs.stat(proposed.structuredContent.integration_worktree_root), { code: 'ENOENT' });
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), '');

  const approved = await callTool(client, 'approve_goal', {
    goal_id: goalId,
    expected_revision: proposed.structuredContent.revision,
    contract_fingerprint: proposed.structuredContent.contract_fingerprint,
    approval_key: 'http-approval-v1',
    confirm: true
  });
  assert.equal(approved.structuredContent.lifecycle, 'approved');
  assert.equal(approved.structuredContent.execution_started, false);
  const started = await callTool(client, 'start_goal', {
    goal_id: goalId,
    expected_revision: approved.structuredContent.revision,
    start_key: 'http-start-v1'
  });
  assert.equal(started.structuredContent.launched_run_count, 2);
  assert.equal(started.structuredContent.running_work_count, 2);
  const goalStatePath = path.join(dataRoot, 'goals', goalId, 'state.json');
  const passiveBytes = await fs.readFile(goalStatePath);
  await client.close();
  client = undefined;
  await stopServer(server);
  server = undefined;
  server = await startServer(env);
  ({ client } = await connectClient(mcpUrl, token));
  const passive = await callTool(client, 'get_goal', { goal_id: goalId });
  assert.equal(passive.structuredContent.goal_id, goalId);
  assert.deepEqual(await fs.readFile(goalStatePath), passiveBytes, 'passive get_goal must not reconcile or write');

  let refreshed;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    refreshed = await callTool(client, 'refresh_goal', { goal_id: goalId });
    if (refreshed.structuredContent.work.every((item) => item.status === 'waiting_review')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(refreshed.structuredContent.lifecycle, 'waiting_review');
  const launchLines = (await fs.readFile(launchLog, 'utf8')).trim().split('\n');
  const starts = launchLines.filter((line) => line.startsWith('start:'));
  const finishes = launchLines.filter((line) => line.startsWith('finish:'));
  assert.equal(starts.length, 2);
  assert.equal(finishes.length, 2);
  assert.ok(Math.max(...starts.map(timestampOf)) < Math.min(...finishes.map(timestampOf)), 'both workers must start before either finishes');

  let blackboard = await callTool(client, 'publish_goal_blackboard', {
    goal_id: goalId,
    expected_revision: refreshed.structuredContent.revision,
    record_key: 'alpha-verification-v1',
    kind: 'verification',
    author: 'worker:work_alpha',
    work_id: 'work_alpha',
    summary: 'Alpha worker completed its bounded change.',
    evidence: ['git diff --check passed'],
    paths: ['src/alpha.txt']
  });
  blackboard = await callTool(client, 'publish_goal_blackboard', {
    goal_id: goalId,
    expected_revision: blackboard.structuredContent.revision,
    record_key: 'beta-verification-v1',
    kind: 'verification',
    author: 'worker:work_beta',
    work_id: 'work_beta',
    summary: 'Beta worker completed its bounded change.',
    evidence: ['git diff --check passed'],
    paths: ['src/beta.txt']
  });
  let integrated = await callTool(client, 'integrate_goal_work', {
    goal_id: goalId,
    work_id: 'work_alpha',
    expected_revision: blackboard.structuredContent.revision,
    integration_key: 'integrate-alpha-v1'
  });
  integrated = await callTool(client, 'integrate_goal_work', {
    goal_id: goalId,
    work_id: 'work_beta',
    expected_revision: integrated.structuredContent.revision,
    integration_key: 'integrate-beta-v1'
  });
  assert.equal(integrated.structuredContent.work.every((item) => item.status === 'integrated'), true);
  const review = await callTool(client, 'review_goal', { goal_id: goalId });
  assert.deepEqual(review.structuredContent.review.changedPaths, ['src/alpha.txt', 'src/beta.txt']);
  assert.match(review.structuredContent.review.diff, /alpha from Goal worker/);
  assert.match(review.structuredContent.review.diff, /beta from Goal worker/);
  assert.equal(review.structuredContent.verification_passed, true);
  assert.equal(review.structuredContent.verification.command, 'git diff --check');
  assert.equal(review.structuredContent.verification.status, 'passed');
  assert.equal(review.structuredContent.verification.output, '');
  const completed = await callTool(client, 'complete_goal', {
    goal_id: goalId,
    expected_revision: integrated.structuredContent.revision,
    completion_key: 'complete-http-v1',
    summary: 'Pro reviewed both worker results and the combined patch.',
    criteria: [{ requirement: 'Alpha and beta are integrated', status: 'passed', evidence: 'Combined Goal review contains both changed paths.' }],
    verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'Both workers reported the check and the integrated patch is valid.' }],
    confirm: true
  });
  assert.equal(completed.structuredContent.lifecycle, 'completed');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'alpha.txt'), 'utf8'), 'alpha base\n');
  await fs.writeFile(path.join(sourceRoot, 'user-local.txt'), 'preserve local dirt\n', 'utf8');
  const applied = await callTool(client, 'apply_goal', {
    goal_id: goalId,
    expected_revision: completed.structuredContent.revision,
    application_key: 'apply-http-v1',
    confirm: true
  });
  assert.equal(applied.structuredContent.goal.sourceApplication.status, 'applied');
  assert.deepEqual(applied.structuredContent.goal.sourceApplication.sourceDirtyPathsBefore, ['user-local.txt']);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'alpha.txt'), 'utf8'), 'alpha from Goal worker\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'src', 'beta.txt'), 'utf8'), 'beta from Goal worker\n');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'user-local.txt'), 'utf8'), 'preserve local dirt\n');
  assert.equal(git(sourceRoot, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(git(sourceRoot, ['show-ref']), refsBefore);
  assert.equal(git(sourceRoot, ['log', '-1', '--format=%s']), 'base');
  const applyRetry = await callTool(client, 'apply_goal', {
    goal_id: goalId,
    expected_revision: completed.structuredContent.revision,
    application_key: 'apply-http-v1',
    confirm: true
  });
  assert.equal(applyRetry.structuredContent.revision, applied.structuredContent.revision);

  console.log('goal HTTP smoke: ok (deterministic fake App Server)');
  console.log(`  goal=${goalId} base=${baseSha.slice(0, 12)} workers=2`);
  console.log('  verified: inert proposal, fingerprint approval, parallel detached workers, passive reconnect, Blackboard, Pro integration/review/completion, and journaled source apply');
} finally {
  await client?.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  await fs.rm(fixture, { recursive: true, force: true });
}

function timestampOf(line) {
  return Number(line.split(':').at(-1));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function cleanEnv(overrides) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    ...overrides
  };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(env) {
  const child = spawn(process.execPath, ['dist/http.js'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`HTTP server exited ${child.exitCode}: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Timed out waiting for HTTP server: ${stderr}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
}

async function connectClient(url, authToken) {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } });
  const mcpClient = new Client({ name: 'codexpro-goal-http-smoke', version: '1.0.0' });
  await mcpClient.connect(transport);
  return { client: mcpClient, transport };
}

async function callTool(mcpClient, name, args = {}) {
  const result = await mcpClient.callTool({ name, arguments: args });
  if (result.isError) {
    const message = result.content?.find?.((part) => part.type === 'text')?.text || JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${message}`);
  }
  return result;
}
