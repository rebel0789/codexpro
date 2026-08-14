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
const liveRoot = path.join(fixture, 'live-source');
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
    fs.mkdir(liveRoot),
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
  git(liveRoot, ['init', '-q']);
  git(liveRoot, ['config', 'user.name', 'Goal Live HTTP Smoke']);
  git(liveRoot, ['config', 'user.email', 'goal-live-http@example.invalid']);
  await fs.mkdir(path.join(liveRoot, 'src'));
  await fs.writeFile(path.join(liveRoot, 'src', 'live.txt'), 'line one base\nline two base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'src', 'conflict.txt'), 'conflict base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'cumulative A base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'src', 'cumulative-b.txt'), 'cumulative B base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'src', 'canceled.txt'), 'canceled base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'dirty-unstaged.txt'), 'unstaged base\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'dirty-staged.txt'), 'staged base\n', 'utf8');
  git(liveRoot, ['add', '--', 'src/live.txt', 'src/conflict.txt', 'src/cumulative-a.txt', 'src/cumulative-b.txt', 'src/canceled.txt', 'dirty-unstaged.txt', 'dirty-staged.txt']);
  git(liveRoot, ['commit', '-qm', 'live base']);
  const liveBaseSha = git(liveRoot, ['rev-parse', 'HEAD']);
  const liveRefsBefore = git(liveRoot, ['show-ref']);
  await fs.writeFile(path.join(liveRoot, 'dirty-unstaged.txt'), 'unstaged user dirt\n', 'utf8');
  await fs.writeFile(path.join(liveRoot, 'dirty-staged.txt'), 'staged user dirt\n', 'utf8');
  git(liveRoot, ['add', '--', 'dirty-staged.txt']);
  await fs.writeFile(path.join(liveRoot, 'user-untracked.txt'), 'untracked user dirt\n', 'utf8');
  await fs.writeFile(path.join(fixture, 'outside-secret.txt'), 'OUTSIDE_SYMLINK_SENTINEL\n', 'utf8');
  const liveDirtyBefore = await captureGitAuthority(liveRoot);

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
    slot = prompt.includes('work_alpha') ? 'alpha' : prompt.includes('work_beta') ? 'beta' : prompt.includes('work_live_one') ? 'live-one' : prompt.includes('work_live_two') ? 'live-two' : prompt.includes('work_cumulative_a') ? 'cumulative-a' : prompt.includes('work_cumulative_b') ? 'cumulative-b' : prompt.includes('work_canceled') ? 'canceled' : prompt.includes('work_conflict') ? 'conflict' : prompt.includes('work_blocked') ? 'blocked' : prompt.includes('work_symlink') ? 'symlink' : 'unknown';
    fs.appendFileSync(log, 'start:' + slot + ':' + Date.now() + '\\n');
    if (slot === 'alpha' || slot === 'beta') fs.writeFileSync(path.join(process.cwd(), 'src', slot + '.txt'), slot + ' from Goal worker\\n');
    else if (slot === 'live-one') fs.writeFileSync(path.join(process.cwd(), 'src', 'live.txt'), 'line one projected\\nline two base\\n');
    else if (slot === 'live-two') fs.writeFileSync(path.join(process.cwd(), 'src', 'live.txt'), 'line one projected\\nline two base\\nline three projected\\n');
    else if (slot === 'cumulative-a') fs.writeFileSync(path.join(process.cwd(), 'src', 'cumulative-a.txt'), 'cumulative A projected\\n');
    else if (slot === 'cumulative-b') fs.writeFileSync(path.join(process.cwd(), 'src', 'cumulative-b.txt'), 'cumulative B projected\\n');
    else if (slot === 'canceled') fs.writeFileSync(path.join(process.cwd(), 'src', 'canceled.txt'), 'canceled projected\\n');
    else if (slot === 'conflict') fs.writeFileSync(path.join(process.cwd(), 'src', 'conflict.txt'), 'conflict projected\\n');
    else if (slot === 'blocked') fs.writeFileSync(path.join(process.cwd(), '.env'), 'LIVE_BLOCKED_SENTINEL=must-not-leak\\n');
    else if (slot === 'symlink') fs.symlinkSync(${JSON.stringify(path.join(fixture, 'outside-secret.txt'))}, path.join(process.cwd(), 'src', 'outside-link'));
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
    CODEXPRO_ALLOWED_ROOTS: `${sourceRoot}${path.delimiter}${liveRoot}`,
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
  for (const name of ['propose_goal', 'approve_goal', 'start_goal', 'get_goal', 'refresh_goal', 'publish_goal_blackboard', 'integrate_goal_work', 'review_goal', 'project_goal', 'revert_goal_projection', 'complete_goal', 'apply_goal']) {
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
  assert.equal('source_root' in proposed.structuredContent, false); assert.equal('integration_worktree_root' in proposed.structuredContent, false);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), '');

  const originalGoalStatePath = path.join(dataRoot, 'goals', goalId, 'state.json');
  const originalGoalState = JSON.parse(await fs.readFile(originalGoalStatePath, 'utf8'));
  const hiddenSourceRoot = path.join(fixture, 'not-allowed-source');
  const hiddenGoalIds = [];
  for (let index = 0; index < 25; index += 1) {
    const hiddenGoalId = `goal_${(0xabc000 + index).toString(16).padStart(24, '0')}`;
    hiddenGoalIds.push(hiddenGoalId);
    const hiddenGoalDir = path.join(dataRoot, 'goals', hiddenGoalId);
    await fs.mkdir(hiddenGoalDir, { mode: 0o700 });
    const hiddenState = {
      ...originalGoalState,
      goalId: hiddenGoalId,
      goalKey: `newer-hidden-goal-${index}`,
      title: `Newer hidden Goal ${index}`,
      sourceRoot: hiddenSourceRoot,
      integrationWorktreeRoot: path.join(dataRoot, 'goal-worktrees', hiddenGoalId),
      updatedAt: new Date(Date.now() + index + 1).toISOString()
    };
    await fs.writeFile(path.join(hiddenGoalDir, 'state.json'), `${JSON.stringify(hiddenState)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const limitedAllowedGoals = await callTool(client, 'list_goals', { limit: 1 });
  assert.equal(limitedAllowedGoals.structuredContent.goal_count, 1, 'newer disallowed Goals must not consume the requested list limit');
  assert.equal(limitedAllowedGoals.structuredContent.goals[0]?.goalId, goalId, 'list_goals must filter allowed source roots before applying limit');
  assert.equal(hiddenGoalIds.some((hiddenGoalId) => JSON.stringify(limitedAllowedGoals.structuredContent).includes(hiddenGoalId)), false);

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

  const liveWorkspace = await callTool(client, 'open_workspace', { path: liveRoot, include_tree: false });
  assert.equal(liveWorkspace.structuredContent.root, liveRoot);
  const liveProposed = await callTool(client, 'propose_goal', {
    workspace_id: liveWorkspace.structuredContent.workspace_id,
    goal_key: 'http-live-goal-v1',
    title: 'HTTP supervised Live Goal',
    goal: 'Project two reviewed incremental checkpoints through the production Live source-effect boundary.',
    completion_criteria: ['Both incremental checkpoints are integrated and the latest is projected'],
    verification: ['git diff --check'],
    execution_policy: 'supervised',
    workspace_policy: 'live',
    permissions: {
      file_globs: ['src/live.txt'],
      commands: ['git diff --check'],
      network: false,
      source_effects: { apply: true, commit: false, push: false, draft_pr: false }
    },
    base_sha: liveBaseSha,
    limits: { max_concurrency: 1, timeout_ms: 30000, max_turns_per_worker: 1, max_retries_per_worker: 0 },
    work: [
      { work_id: 'work_live_one', title: 'Live checkpoint one', goal: 'Change line one in src/live.txt.', acceptance_criteria: ['Line one is projected'], verification: ['git diff --check'], file_globs: ['src/live.txt'] },
      { work_id: 'work_live_two', title: 'Live checkpoint two', goal: 'Preserve checkpoint one and append line three in src/live.txt.', acceptance_criteria: ['Line three is projected'], verification: ['git diff --check'], depends_on: ['work_live_one'], file_globs: ['src/live.txt'] }
    ]
  });
  const liveGoalId = liveProposed.structuredContent.goal_id;
  assert.equal(liveProposed.structuredContent.workspace_policy, 'live');
  assert.equal(liveProposed.structuredContent.live_projection_allowed, true);
  assert.equal(liveProposed.structuredContent.execution_started, false);
  await assertGitAuthorityPreserved(liveRoot, liveDirtyBefore, 'Live proposal must preserve unrelated staged, unstaged, and untracked changes');
  const liveApproved = await callTool(client, 'approve_goal', {
    goal_id: liveGoalId,
    expected_revision: liveProposed.structuredContent.revision,
    contract_fingerprint: liveProposed.structuredContent.contract_fingerprint,
    approval_key: 'http-live-approval-v1',
    confirm: true
  });
  let liveStarted = await callTool(client, 'start_goal', {
    goal_id: liveGoalId,
    expected_revision: liveApproved.structuredContent.revision,
    start_key: 'http-live-start-v1'
  });
  assert.equal(liveStarted.structuredContent.launched_run_count, 1);
  let liveRefreshed = await waitForGoalWork(client, liveGoalId, 'work_live_one');
  let liveIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: liveGoalId,
    work_id: 'work_live_one',
    expected_revision: liveRefreshed.structuredContent.revision,
    integration_key: 'http-live-integrate-one-v1'
  });
  const liveStatePath = path.join(dataRoot, 'goals', liveGoalId, 'state.json');
  const passiveLiveState = await fs.readFile(liveStatePath);
  const passiveLiveSource = await captureGitAuthority(liveRoot);
  const passiveLiveFile = await fs.readFile(path.join(liveRoot, 'src', 'live.txt'));
  const liveGet = await callTool(client, 'get_goal', { goal_id: liveGoalId });
  assert.equal(liveGet.structuredContent.revision, liveIntegrated.structuredContent.revision);
  const liveReviewOne = await callTool(client, 'review_goal', { goal_id: liveGoalId });
  assert.deepEqual(await fs.readFile(liveStatePath), passiveLiveState, 'Live get/review must not mutate Goal authority');
  assert.deepEqual(await captureGitAuthority(liveRoot), passiveLiveSource, 'Live get/review must preserve unrelated Git authority');
  assert.deepEqual(await fs.readFile(path.join(liveRoot, 'src', 'live.txt')), passiveLiveFile, 'Live review must not project implicitly');
  assert.deepEqual(liveReviewOne.structuredContent.review.changedPaths, ['src/live.txt']);
  assert.match(liveReviewOne.structuredContent.review_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(liveReviewOne.structuredContent.projection_eligible, true);
  assert.deepEqual(liveReviewOne.structuredContent.projection_blockers, []);
  const launchesBeforeProjection = await fs.readFile(launchLog, 'utf8');
  const projectionOneArgs = {
    goal_id: liveGoalId,
    expected_revision: liveReviewOne.structuredContent.revision,
    projection_key: 'http-live-project-one-v1',
    integration_head_sha: liveReviewOne.structuredContent.integration_head_sha,
    review_fingerprint: liveReviewOne.structuredContent.review_fingerprint,
    confirm: true
  };
  const projectedOne = await callTool(client, 'project_goal', projectionOneArgs);
  assert.equal(projectedOne.structuredContent.projection_status, 'applied');
  assert.equal(projectedOne.structuredContent.projection.fromIntegrationSha, liveBaseSha);
  assert.equal(projectedOne.structuredContent.projection.toIntegrationSha, liveReviewOne.structuredContent.integration_head_sha);
  assert.deepEqual(projectedOne.structuredContent.projection.changedPaths, ['src/live.txt']);
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'live.txt'), 'utf8'), 'line one projected\nline two base\n');
  assert.equal(await fs.readFile(launchLog, 'utf8'), launchesBeforeProjection, 'project_goal must not launch a model');
  await assertGitAuthorityPreserved(liveRoot, liveDirtyBefore, 'Projection one must preserve unrelated staged, unstaged, and untracked changes');
  assert.equal(git(liveRoot, ['rev-parse', 'HEAD']), liveBaseSha);
  assert.equal(git(liveRoot, ['show-ref']), liveRefsBefore);
  const projectedOneState = await fs.readFile(liveStatePath);
  const projectedOneRetry = await callTool(client, 'project_goal', projectionOneArgs);
  assert.equal(projectedOneRetry.structuredContent.reused, true);
  assert.equal(projectedOneRetry.structuredContent.projection_id, projectedOne.structuredContent.projection_id);
  assert.equal(projectedOneRetry.structuredContent.revision, projectedOne.structuredContent.revision);
  assert.deepEqual(await fs.readFile(liveStatePath), projectedOneState, 'same-key projection retry must not rewrite Goal state');
  await client.close();
  client = undefined;
  await stopServer(server);
  server = undefined;
  server = await startServer(env);
  ({ client } = await connectClient(mcpUrl, token));
  const projectedOneRestartRetry = await callTool(client, 'project_goal', projectionOneArgs);
  assert.equal(projectedOneRestartRetry.structuredContent.reused, true);
  assert.equal(projectedOneRestartRetry.structuredContent.projection_id, projectedOne.structuredContent.projection_id);
  assert.deepEqual(await fs.readFile(liveStatePath), projectedOneState, 'same-key projection retry after restart must remain byte-idempotent');

  liveStarted = await callTool(client, 'start_goal', {
    goal_id: liveGoalId,
    expected_revision: projectedOneRestartRetry.structuredContent.revision,
    start_key: 'http-live-start-v1'
  });
  assert.equal(liveStarted.structuredContent.launched_run_count, 1);
  liveRefreshed = await waitForGoalWork(client, liveGoalId, 'work_live_two');
  liveIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: liveGoalId,
    work_id: 'work_live_two',
    expected_revision: liveRefreshed.structuredContent.revision,
    integration_key: 'http-live-integrate-two-v1'
  });
  const liveReviewTwo = await callTool(client, 'review_goal', { goal_id: liveGoalId });
  assert.match(liveReviewTwo.structuredContent.review_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(liveReviewTwo.structuredContent.projection_eligible, true);
  const projectionTwoArgs = {
    goal_id: liveGoalId,
    expected_revision: liveReviewTwo.structuredContent.revision,
    projection_key: 'http-live-project-two-v1',
    integration_head_sha: liveReviewTwo.structuredContent.integration_head_sha,
    review_fingerprint: liveReviewTwo.structuredContent.review_fingerprint,
    confirm: true
  };
  const projectedTwo = await callTool(client, 'project_goal', projectionTwoArgs);
  assert.equal(projectedTwo.structuredContent.projection.fromIntegrationSha, liveReviewOne.structuredContent.integration_head_sha);
  assert.equal(projectedTwo.structuredContent.projection.toIntegrationSha, liveReviewTwo.structuredContent.integration_head_sha);
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'live.txt'), 'utf8'), 'line one projected\nline two base\nline three projected\n');
  const beforeLifoRefusal = await fs.readFile(liveStatePath);
  await callToolError(client, 'revert_goal_projection', {
    goal_id: liveGoalId,
    expected_revision: projectedTwo.structuredContent.revision,
    projection_id: projectedOne.structuredContent.projection_id,
    revert_key: 'http-live-wrong-order-v1',
    confirm: true
  });
  assert.deepEqual(await fs.readFile(liveStatePath), beforeLifoRefusal, 'non-LIFO revert refusal must be passive');
  const privateProjectionArtifact = path.join(dataRoot, 'goals', liveGoalId, 'projections', projectedTwo.structuredContent.projection_id, 'before.json');
  await fs.chmod(privateProjectionArtifact, 0o644);
  let privateArtifactFailure;
  try {
    privateArtifactFailure = await callToolError(client, 'revert_goal_projection', {
      goal_id: liveGoalId,
      expected_revision: projectedTwo.structuredContent.revision,
      projection_id: projectedTwo.structuredContent.projection_id,
      revert_key: 'http-live-private-artifact-error-v1',
      confirm: true
    }, [privateProjectionArtifact, dataRoot, liveRoot]);
  } finally {
    await fs.chmod(privateProjectionArtifact, 0o600);
  }
  assert.match(privateArtifactFailure.content?.find?.((part) => part.type === 'text')?.text || '', /Detailed local error text remains private/);
  assert.equal('error' in privateArtifactFailure.structuredContent, false, 'Goal mutation failures must not expose a raw error field');
  assert.equal(privateArtifactFailure.structuredContent.mutation_error?.hasError, true);
  assert.match(privateArtifactFailure.structuredContent.mutation_error?.errorSha256 || '', /^[0-9a-f]{64}$/);
  assert.deepEqual(await fs.readFile(liveStatePath), beforeLifoRefusal, 'private artifact validation failure must not rewrite Goal state');
  const revertedTwo = await callTool(client, 'revert_goal_projection', {
    goal_id: liveGoalId,
    expected_revision: projectedTwo.structuredContent.revision,
    projection_id: projectedTwo.structuredContent.projection_id,
    revert_key: 'http-live-revert-two-v1',
    confirm: true
  });
  assert.equal(revertedTwo.structuredContent.projection_status, 'reverted');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'live.txt'), 'utf8'), 'line one projected\nline two base\n');
  const revertedTwoRetry = await callTool(client, 'revert_goal_projection', {
    goal_id: liveGoalId,
    expected_revision: projectedTwo.structuredContent.revision,
    projection_id: projectedTwo.structuredContent.projection_id,
    revert_key: 'http-live-revert-two-v1',
    confirm: true
  });
  assert.equal(revertedTwoRetry.structuredContent.reused, true);
  assert.equal(revertedTwoRetry.structuredContent.revision, revertedTwo.structuredContent.revision);
  const projectedTwoFinal = await callTool(client, 'project_goal', {
    ...projectionTwoArgs,
    expected_revision: revertedTwo.structuredContent.revision,
    projection_key: 'http-live-project-two-final-v1'
  });
  assert.equal(projectedTwoFinal.structuredContent.projection_status, 'applied');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'live.txt'), 'utf8'), 'line one projected\nline two base\nline three projected\n');
  await assertGitAuthorityPreserved(liveRoot, liveDirtyBefore, 'Repeated same-path projections and revert must preserve unrelated dirt');

  const liveCompleted = await callTool(client, 'complete_goal', {
    goal_id: liveGoalId,
    expected_revision: projectedTwoFinal.structuredContent.revision,
    completion_key: 'http-live-complete-v1',
    summary: 'Both reviewed incremental checkpoints are integrated and the current checkpoint is projected.',
    criteria: [{ requirement: 'Both incremental checkpoints are integrated and the latest is projected', status: 'passed', evidence: 'Production projection readback matches the second integration HEAD.' }],
    verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'review_goal verification passed for the integrated checkpoint.' }],
    review_fingerprint: liveReviewTwo.structuredContent.review_fingerprint,
    confirm: true
  });
  const beforeLiveApplyFile = await fs.readFile(path.join(liveRoot, 'src', 'live.txt'));
  const beforeLiveApplyAuthority = await captureGitAuthority(liveRoot);
  const liveApplied = await callTool(client, 'apply_goal', {
    goal_id: liveGoalId,
    expected_revision: liveCompleted.structuredContent.revision,
    application_key: 'http-live-apply-v1',
    confirm: true
  });
  assert.equal(liveApplied.structuredContent.goal.sourceApplication.status, 'applied');
  assert.equal(liveApplied.structuredContent.goal.sourceApplication.zeroWrite, true);
  assert.equal(liveApplied.structuredContent.goal.sourceApplication.adoptedProjectionId, projectedTwoFinal.structuredContent.projection_id);
  assert.equal(liveApplied.structuredContent.goal.live.adoptedProjectionId, projectedTwoFinal.structuredContent.projection_id);
  assert.deepEqual(await fs.readFile(path.join(liveRoot, 'src', 'live.txt')), beforeLiveApplyFile, 'Live final apply must adopt without rewriting source');
  assert.deepEqual(await captureGitAuthority(liveRoot), beforeLiveApplyAuthority, 'Live final apply must be zero-write for Git and filesystem authority');
  assert.equal(git(liveRoot, ['rev-parse', 'HEAD']), liveBaseSha);
  assert.equal(git(liveRoot, ['show-ref']), liveRefsBefore);
  assert.equal(git(liveRoot, ['log', '-1', '--format=%s']), 'live base');

  const cumulativeProposed = await callTool(client, 'propose_goal', {
    workspace_id: liveWorkspace.structuredContent.workspace_id,
    goal_key: 'http-live-cumulative-v1',
    title: 'HTTP Live cumulative projection Goal',
    goal: 'Project disjoint A then B checkpoints and verify finalization revalidates both active projections.',
    completion_criteria: ['Both disjoint checkpoints remain authoritatively projected'],
    verification: ['git diff --check'],
    execution_policy: 'supervised',
    workspace_policy: 'live',
    permissions: {
      file_globs: ['src/cumulative-a.txt', 'src/cumulative-b.txt'],
      commands: ['git diff --check'],
      network: false,
      source_effects: { apply: true, commit: false, push: false, draft_pr: false }
    },
    base_sha: liveBaseSha,
    limits: { max_concurrency: 1, timeout_ms: 30000, max_turns_per_worker: 1, max_retries_per_worker: 0 },
    work: [
      { work_id: 'work_cumulative_a', title: 'Cumulative checkpoint A', goal: 'Modify only src/cumulative-a.txt.', acceptance_criteria: ['A is projected'], verification: ['git diff --check'], file_globs: ['src/cumulative-a.txt'] },
      { work_id: 'work_cumulative_b', title: 'Cumulative checkpoint B', goal: 'Modify only src/cumulative-b.txt.', acceptance_criteria: ['B is projected while A remains projected'], verification: ['git diff --check'], depends_on: ['work_cumulative_a'], file_globs: ['src/cumulative-b.txt'] }
    ]
  });
  const cumulativeGoalId = cumulativeProposed.structuredContent.goal_id;
  const cumulativeApproved = await callTool(client, 'approve_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeProposed.structuredContent.revision,
    contract_fingerprint: cumulativeProposed.structuredContent.contract_fingerprint,
    approval_key: 'http-live-cumulative-approval-v1',
    confirm: true
  });
  let cumulativeStarted = await callTool(client, 'start_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeApproved.structuredContent.revision,
    start_key: 'http-live-cumulative-start-v1'
  });
  assert.equal(cumulativeStarted.structuredContent.launched_run_count, 1);
  let cumulativeReady = await waitForGoalWork(client, cumulativeGoalId, 'work_cumulative_a');
  let cumulativeIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: cumulativeGoalId,
    work_id: 'work_cumulative_a',
    expected_revision: cumulativeReady.structuredContent.revision,
    integration_key: 'http-live-cumulative-integrate-a-v1'
  });
  const cumulativeReviewA = await callTool(client, 'review_goal', { goal_id: cumulativeGoalId });
  const cumulativeProjectedA = await callTool(client, 'project_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeIntegrated.structuredContent.revision,
    projection_key: 'http-live-cumulative-project-a-v1',
    integration_head_sha: cumulativeReviewA.structuredContent.integration_head_sha,
    review_fingerprint: cumulativeReviewA.structuredContent.review_fingerprint,
    confirm: true
  });
  assert.deepEqual(cumulativeProjectedA.structuredContent.projection.changedPaths, ['src/cumulative-a.txt']);
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'utf8'), 'cumulative A projected\n');
  cumulativeStarted = await callTool(client, 'start_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeProjectedA.structuredContent.revision,
    start_key: 'http-live-cumulative-start-v1'
  });
  assert.equal(cumulativeStarted.structuredContent.launched_run_count, 1);
  cumulativeReady = await waitForGoalWork(client, cumulativeGoalId, 'work_cumulative_b');
  cumulativeIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: cumulativeGoalId,
    work_id: 'work_cumulative_b',
    expected_revision: cumulativeReady.structuredContent.revision,
    integration_key: 'http-live-cumulative-integrate-b-v1'
  });
  const cumulativeReviewB = await callTool(client, 'review_goal', { goal_id: cumulativeGoalId });
  const cumulativeProjectedB = await callTool(client, 'project_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeIntegrated.structuredContent.revision,
    projection_key: 'http-live-cumulative-project-b-v1',
    integration_head_sha: cumulativeReviewB.structuredContent.integration_head_sha,
    review_fingerprint: cumulativeReviewB.structuredContent.review_fingerprint,
    confirm: true
  });
  assert.deepEqual(cumulativeProjectedB.structuredContent.projection.changedPaths, ['src/cumulative-b.txt']);
  assert.equal(cumulativeProjectedB.structuredContent.projection.fromIntegrationSha, cumulativeReviewA.structuredContent.integration_head_sha);
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'utf8'), 'cumulative A projected\n');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-b.txt'), 'utf8'), 'cumulative B projected\n');
  const cumulativeCompleteArgs = {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeProjectedB.structuredContent.revision,
    completion_key: 'http-live-cumulative-complete-v1',
    summary: 'Both disjoint checkpoints were reviewed and projected.',
    criteria: [{ requirement: 'Both disjoint checkpoints remain authoritatively projected', status: 'passed', evidence: 'Cumulative source readback covers both A and B.' }],
    verification: [{ requirement: 'git diff --check', status: 'passed', evidence: 'The integrated cumulative patch passes review verification.' }],
    review_fingerprint: cumulativeReviewB.structuredContent.review_fingerprint,
    confirm: true
  };
  const cumulativeACompleteConflict = 'USER_A_EDIT_BEFORE_COMPLETE\n';
  await fs.writeFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), cumulativeACompleteConflict, 'utf8');
  const cumulativeStatePath = path.join(dataRoot, 'goals', cumulativeGoalId, 'state.json');
  const cumulativeStateBeforeComplete = await fs.readFile(cumulativeStatePath);
  const cumulativeBBytesBeforeComplete = await fs.readFile(path.join(liveRoot, 'src', 'cumulative-b.txt'));
  const cumulativeCompleteFailure = await callToolError(client, 'complete_goal', cumulativeCompleteArgs, [cumulativeACompleteConflict.trim()]);
  assert.match(JSON.stringify(cumulativeCompleteFailure), /cumulative projected state.*cumulative-a\.txt|source path drifted/i);
  assert.deepEqual(await fs.readFile(cumulativeStatePath), cumulativeStateBeforeComplete, 'cumulative complete conflict must not terminalize or mutate Goal state');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'utf8'), cumulativeACompleteConflict, 'complete conflict must not overwrite external A edit');
  assert.deepEqual(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-b.txt')), cumulativeBBytesBeforeComplete, 'complete conflict must not rewrite disjoint B');
  const cumulativeAfterCompleteFailure = await callTool(client, 'get_goal', { goal_id: cumulativeGoalId });
  assert.equal(cumulativeAfterCompleteFailure.structuredContent.lifecycle, 'waiting_review');
  assert.equal(cumulativeAfterCompleteFailure.structuredContent.goal.completion, null);

  await fs.writeFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'cumulative A projected\n', 'utf8');
  const cumulativeCompleted = await callTool(client, 'complete_goal', cumulativeCompleteArgs);
  assert.equal(cumulativeCompleted.structuredContent.lifecycle, 'completed');
  const cumulativeAApplyConflict = 'USER_A_EDIT_BEFORE_APPLY\n';
  await fs.writeFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), cumulativeAApplyConflict, 'utf8');
  const cumulativeStateBeforeApply = await fs.readFile(cumulativeStatePath);
  const cumulativeBBytesBeforeApply = await fs.readFile(path.join(liveRoot, 'src', 'cumulative-b.txt'));
  const cumulativeApplyFailure = await callToolError(client, 'apply_goal', {
    goal_id: cumulativeGoalId,
    expected_revision: cumulativeCompleted.structuredContent.revision,
    application_key: 'http-live-cumulative-apply-v1',
    confirm: true
  }, [cumulativeAApplyConflict.trim()]);
  assert.match(JSON.stringify(cumulativeApplyFailure), /cumulative projected state.*cumulative-a\.txt|source path drifted/i);
  assert.deepEqual(await fs.readFile(cumulativeStatePath), cumulativeStateBeforeApply, 'cumulative apply conflict must not create false application authority or mutate completed Goal state');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-a.txt'), 'utf8'), cumulativeAApplyConflict, 'apply conflict must not overwrite external A edit');
  assert.deepEqual(await fs.readFile(path.join(liveRoot, 'src', 'cumulative-b.txt')), cumulativeBBytesBeforeApply, 'apply conflict must not rewrite disjoint B');
  const cumulativeAfterApplyFailure = await callTool(client, 'get_goal', { goal_id: cumulativeGoalId });
  assert.equal(cumulativeAfterApplyFailure.structuredContent.lifecycle, 'completed');
  assert.equal(cumulativeAfterApplyFailure.structuredContent.source_application, null);
  await assertGitAuthorityPreserved(liveRoot, liveDirtyBefore, 'Cumulative finalization conflicts must preserve unrelated staged, unstaged, and untracked changes');
  assert.equal(git(liveRoot, ['rev-parse', 'HEAD']), liveBaseSha);
  assert.equal(git(liveRoot, ['show-ref']), liveRefsBefore);

  const canceledReady = await startSingleLiveGoal(client, {
    workspaceId: liveWorkspace.structuredContent.workspace_id,
    baseSha: liveBaseSha,
    goalKey: 'http-live-canceled-v1',
    workId: 'work_canceled',
    fileGlob: 'src/canceled.txt',
    title: 'Canceled Live projection retry'
  });
  const canceledGoalId = canceledReady.structuredContent.goal_id;
  const canceledIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: canceledGoalId,
    work_id: 'work_canceled',
    expected_revision: canceledReady.structuredContent.revision,
    integration_key: 'http-live-canceled-integrate-v1'
  });
  const canceledReview = await callTool(client, 'review_goal', { goal_id: canceledGoalId });
  const canceledProjectArgs = {
    goal_id: canceledGoalId,
    expected_revision: canceledIntegrated.structuredContent.revision,
    projection_key: 'http-live-canceled-project-v1',
    integration_head_sha: canceledReview.structuredContent.integration_head_sha,
    review_fingerprint: canceledReview.structuredContent.review_fingerprint,
    confirm: true
  };
  const canceledProjected = await callTool(client, 'project_goal', canceledProjectArgs);
  assert.equal(canceledProjected.structuredContent.projection_status, 'applied');
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'canceled.txt'), 'utf8'), 'canceled projected\n');
  const canceledGoal = await callTool(client, 'cancel_goal', {
    goal_id: canceledGoalId,
    expected_revision: canceledProjected.structuredContent.revision,
    cancel_key: 'http-live-canceled-cancel-v1',
    reason: 'Exercise terminal lifecycle fencing for an exact old project retry.'
  });
  assert.equal(canceledGoal.structuredContent.lifecycle, 'canceled');
  const canceledStatePath = path.join(dataRoot, 'goals', canceledGoalId, 'state.json');
  const canceledStateBeforeRetry = await fs.readFile(canceledStatePath);
  const canceledSourceBeforeRetry = {
    file: await fs.readFile(path.join(liveRoot, 'src', 'canceled.txt')),
    status: git(liveRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
    head: git(liveRoot, ['rev-parse', 'HEAD']),
    refs: git(liveRoot, ['show-ref'])
  };
  const canceledProjectFailure = await callToolError(client, 'project_goal', canceledProjectArgs);
  assert.match(JSON.stringify(canceledProjectFailure), /nonterminal|canceled|terminal/i, 'canceled exact old project retry must return an actionable lifecycle error');
  assert.deepEqual(await fs.readFile(canceledStatePath), canceledStateBeforeRetry, 'canceled exact old project retry must not mutate Goal state');
  assert.deepEqual({
    file: await fs.readFile(path.join(liveRoot, 'src', 'canceled.txt')),
    status: git(liveRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
    head: git(liveRoot, ['rev-parse', 'HEAD']),
    refs: git(liveRoot, ['show-ref'])
  }, canceledSourceBeforeRetry, 'canceled exact old project retry must not mutate source or Git authority');

  const goalSecretSentinel = 'sk-goalNestedSecretSentinel1234567890';
  const blackboardSecretSentinel = 'ghp_BlackboardNestedSecretSentinel1234567890';
  const errorSecretSentinel = 'npm_ErrorNestedSecretSentinel1234567890';
  let conflictReady = await startSingleLiveGoal(client, {
    workspaceId: liveWorkspace.structuredContent.workspace_id,
    baseSha: liveBaseSha,
    goalKey: 'http-live-conflict-v1',
    workId: 'work_conflict',
    fileGlob: 'src/conflict.txt',
    title: 'Live same-path conflict',
    goalText: `Exercise a conflict response containing nested persisted Goal data ${goalSecretSentinel}.`
  });
  const conflictGoalId = conflictReady.structuredContent.goal_id;
  conflictReady = await callTool(client, 'publish_goal_blackboard', {
    goal_id: conflictGoalId,
    expected_revision: conflictReady.structuredContent.revision,
    record_key: 'http-live-conflict-secret-record-v1',
    kind: 'verification',
    author: 'pro',
    summary: `Nested Blackboard fixture ${blackboardSecretSentinel}`,
    evidence: [`Secret-shaped persisted evidence ${blackboardSecretSentinel}`],
    paths: ['src/conflict.txt']
  });
  const conflictIntegrated = await callTool(client, 'integrate_goal_work', {
    goal_id: conflictGoalId,
    work_id: 'work_conflict',
    expected_revision: conflictReady.structuredContent.revision,
    integration_key: 'http-live-conflict-integrate-v1'
  });
  const conflictReview = await callTool(client, 'review_goal', { goal_id: conflictGoalId });
  const conflictProjected = await callTool(client, 'project_goal', {
    goal_id: conflictGoalId,
    expected_revision: conflictIntegrated.structuredContent.revision,
    projection_key: 'http-live-conflict-project-v1',
    integration_head_sha: conflictReview.structuredContent.integration_head_sha,
    review_fingerprint: conflictReview.structuredContent.review_fingerprint,
    confirm: true
  });
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'conflict.txt'), 'utf8'), 'conflict projected\n');
  const conflictStatePath = path.join(dataRoot, 'goals', conflictGoalId, 'state.json');
  const conflictSecretState = JSON.parse(await fs.readFile(conflictStatePath, 'utf8'));
  conflictSecretState.error = `Persisted nested Goal error ${errorSecretSentinel}`;
  await fs.writeFile(conflictStatePath, `${JSON.stringify(conflictSecretState, null, 2)}\n`, 'utf8');
  const persistedConflictSecrets = await fs.readFile(conflictStatePath, 'utf8');
  for (const sentinel of [goalSecretSentinel, blackboardSecretSentinel, errorSecretSentinel]) {
    assert.match(persistedConflictSecrets, new RegExp(escapeRegExp(sentinel)), 'security fixture must persist the raw nested sentinel before the failing MCP call');
  }
  const userConflict = 'USER_SAME_PATH_EDIT_MUST_SURVIVE\n';
  await fs.writeFile(path.join(liveRoot, 'src', 'conflict.txt'), userConflict, 'utf8');
  const conflictStateBeforeRevert = await fs.readFile(conflictStatePath);
  const conflictFailure = await callToolError(client, 'revert_goal_projection', {
    goal_id: conflictGoalId,
    expected_revision: conflictProjected.structuredContent.revision,
    projection_id: conflictProjected.structuredContent.projection_id,
    revert_key: 'http-live-conflict-revert-v1',
    confirm: true
  }, [userConflict.trim(), goalSecretSentinel, blackboardSecretSentinel, errorSecretSentinel]);
  const conflictFailureContent = JSON.stringify(conflictFailure.content);
  const conflictFailureStructured = JSON.stringify(conflictFailure.structuredContent);
  const conflictFailureCardPayload = JSON.stringify(conflictFailure._meta ?? {});
  for (const sentinel of [goalSecretSentinel, blackboardSecretSentinel, errorSecretSentinel]) {
    const tail = sentinel.slice(-16);
    assert.doesNotMatch(conflictFailureContent, new RegExp(escapeRegExp(sentinel)), 'Goal mutation error text leaked a persisted secret-shaped sentinel');
    assert.doesNotMatch(conflictFailureStructured, new RegExp(escapeRegExp(sentinel)), 'Goal mutation structured response leaked a persisted secret-shaped sentinel');
    assert.doesNotMatch(conflictFailureCardPayload, new RegExp(escapeRegExp(sentinel)), 'Goal mutation card metadata leaked a persisted secret-shaped sentinel');
    assert.doesNotMatch(JSON.stringify(conflictFailure), new RegExp(escapeRegExp(tail)), 'Goal mutation response leaked a recognizable secret token tail');
  }
  assert.match(conflictFailureStructured, /\[REDACTED_SECRET\]/, 'Goal mutation structured response must visibly redact nested persisted secrets');
  assert.match(conflictFailureContent, /conflict\.txt|same-path|source path drifted|recovery requires user action/i, 'redacted Goal mutation error must remain actionable');
  assert.match(JSON.stringify(conflictFailure), /same-path edit|source path drifted|recovery requires user action/i);
  assert.equal(await fs.readFile(path.join(liveRoot, 'src', 'conflict.txt'), 'utf8'), userConflict, 'conflicting user edit must never be overwritten');
  const conflictReadback = await callTool(client, 'get_goal', { goal_id: conflictGoalId });
  if (conflictReadback.structuredContent.live.pendingProjectionId) {
    assert.equal(conflictReadback.structuredContent.live.pendingProjectionId, conflictProjected.structuredContent.projection_id);
    assert.equal(conflictReadback.structuredContent.live.projections.at(-1).status, 'recovery_required');
  } else {
    assert.equal(conflictReadback.structuredContent.live.projections.at(-1).status, 'applied');
    assert.deepEqual(await fs.readFile(conflictStatePath), conflictStateBeforeRevert, 'preflight conflict refusal must not create a false recovery journal');
  }

  const blockedReady = await startSingleLiveGoal(client, {
    workspaceId: liveWorkspace.structuredContent.workspace_id,
    baseSha: liveBaseSha,
    goalKey: 'http-live-blocked-v1',
    workId: 'work_blocked',
    fileGlob: '.env',
    title: 'Blocked Live path'
  });
  const blockedGoalId = blockedReady.structuredContent.goal_id;
  const blockedStatePath = path.join(dataRoot, 'goals', blockedGoalId, 'state.json');
  const blockedStateBefore = await fs.readFile(blockedStatePath);
  await callToolError(client, 'integrate_goal_work', {
    goal_id: blockedGoalId,
    work_id: 'work_blocked',
    expected_revision: blockedReady.structuredContent.revision,
    integration_key: 'http-live-blocked-integrate-v1'
  }, ['LIVE_BLOCKED_SENTINEL=must-not-leak']);
  assert.deepEqual(await fs.readFile(blockedStatePath), blockedStateBefore, 'blocked-path integration refusal must not mutate Goal authority');
  await assert.rejects(fs.stat(path.join(liveRoot, '.env')), { code: 'ENOENT' });

  const symlinkReady = await startSingleLiveGoal(client, {
    workspaceId: liveWorkspace.structuredContent.workspace_id,
    baseSha: liveBaseSha,
    goalKey: 'http-live-symlink-v1',
    workId: 'work_symlink',
    fileGlob: 'src/outside-link',
    title: 'Symlink Live path',
    wanted: 'symlink_rejected'
  });
  const symlinkGoalId = symlinkReady.structuredContent.goal_id;
  const symlinkStatePath = path.join(dataRoot, 'goals', symlinkGoalId, 'state.json');
  const symlinkStateBefore = await fs.readFile(symlinkStatePath);
  await callToolError(client, 'integrate_goal_work', {
    goal_id: symlinkGoalId,
    work_id: 'work_symlink',
    expected_revision: symlinkReady.structuredContent.revision,
    integration_key: 'http-live-symlink-integrate-v1'
  }, ['OUTSIDE_SYMLINK_SENTINEL']);
  assert.deepEqual(await fs.readFile(symlinkStatePath), symlinkStateBefore, 'symlink integration refusal must not mutate Goal authority');
  await assert.rejects(fs.lstat(path.join(liveRoot, 'src', 'outside-link')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(fixture, 'outside-secret.txt'), 'utf8'), 'OUTSIDE_SYMLINK_SENTINEL\n');
  const unsafeReview = await callTool(client, 'review_goal', { goal_id: blockedGoalId });
  assert.doesNotMatch(JSON.stringify(unsafeReview), /LIVE_BLOCKED_SENTINEL=must-not-leak|OUTSIDE_SYMLINK_SENTINEL/);

  const offGoalStateBefore = await fs.readFile(liveStatePath);
  const offLaunchLogBefore = await fs.readFile(launchLog, 'utf8');
  const offSourceBefore = {
    status: git(liveRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
    head: git(liveRoot, ['rev-parse', 'HEAD']),
    refs: git(liveRoot, ['show-ref']),
    live: await fs.readFile(path.join(liveRoot, 'src', 'live.txt')),
    conflict: await fs.readFile(path.join(liveRoot, 'src', 'conflict.txt'))
  };
  await client.close();
  client = undefined;
  await stopServer(server);
  server = undefined;
  const offEnv = {
    ...env,
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_BASH_MODE: 'off'
  };
  server = await startServer(offEnv);
  ({ client } = await connectClient(mcpUrl, token));
  const offTools = await client.listTools();
  assert.equal(offTools.tools.some((tool) => tool.name === 'project_goal'), false, 'project_goal must not be advertised when write mode is off');
  assert.equal(offTools.tools.some((tool) => tool.name === 'revert_goal_projection'), false, 'revert_goal_projection must not be advertised when write mode is off');
  const offGet = await callTool(client, 'get_goal', { goal_id: liveGoalId });
  assert.equal(offGet.structuredContent.goal_id, liveGoalId);
  const offReview = await callTool(client, 'review_goal', { goal_id: liveGoalId });
  assert.equal(offReview.structuredContent.review_fingerprint, liveReviewTwo.structuredContent.review_fingerprint);
  const offProject = await callToolError(client, 'project_goal', {
    ...projectionTwoArgs,
    expected_revision: offGet.structuredContent.revision,
    projection_key: 'http-live-off-project-v1'
  });
  const offRevert = await callToolError(client, 'revert_goal_projection', {
    goal_id: conflictGoalId,
    expected_revision: conflictReadback.structuredContent.revision,
    projection_id: conflictProjected.structuredContent.projection_id,
    revert_key: 'http-live-off-revert-v1',
    confirm: true
  });
  assert.match(JSON.stringify(offProject), /writeMode=workspace|unknown tool|not found/i);
  assert.match(JSON.stringify(offRevert), /writeMode=workspace|unknown tool|not found/i);
  assert.deepEqual(await fs.readFile(liveStatePath), offGoalStateBefore, 'off-mode get/review/project/revert must not mutate Goal authority');
  assert.equal(await fs.readFile(launchLog, 'utf8'), offLaunchLogBefore, 'off-mode passive/refused Goal tools must not launch Codex');
  assert.deepEqual({
    status: git(liveRoot, ['status', '--porcelain=v2', '--untracked-files=all']),
    head: git(liveRoot, ['rev-parse', 'HEAD']),
    refs: git(liveRoot, ['show-ref']),
    live: await fs.readFile(path.join(liveRoot, 'src', 'live.txt')),
    conflict: await fs.readFile(path.join(liveRoot, 'src', 'conflict.txt'))
  }, offSourceBefore, 'off-mode passive and refused source-effect tools must preserve source authority');

  console.log('goal HTTP smoke: ok (deterministic fake App Server)');
  console.log(`  isolated_goal=${goalId} live_goal=${liveGoalId} base=${baseSha.slice(0, 12)} live_base=${liveBaseSha.slice(0, 12)}`);
  console.log('  verified: isolated apply; supervised Live P1/P2 projection; cumulative completion/apply fencing; canceled retry fencing; nested error-payload redaction; retry/restart idempotency; LIFO revert; dirty preservation; conflict, blocked-path, and symlink fail-closed; zero-write final adoption; off-mode passive authority');
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

async function captureGitAuthority(root) {
  const tracked = ['dirty-unstaged.txt', 'dirty-staged.txt'];
  const files = Object.fromEntries(await Promise.all(
    [...tracked, 'user-untracked.txt'].map(async (name) => [name, await fs.readFile(path.join(root, name), 'utf8')])
  ));
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    refs: git(root, ['show-ref']),
    status: git(root, ['status', '--porcelain=v2', '--untracked-files=all', '--', ...tracked, 'user-untracked.txt']),
    unstagedDiff: git(root, ['diff', '--binary', '--', ...tracked]),
    stagedDiff: git(root, ['diff', '--cached', '--binary', '--', ...tracked]),
    stagedBlob: git(root, ['show', ':dirty-staged.txt']),
    files
  };
}

async function assertGitAuthorityPreserved(root, expected, label) {
  const actual = await captureGitAuthority(root);
  assert.deepEqual(actual, expected, label);
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

async function callToolError(mcpClient, name, args, forbidden = []) {
  const result = await mcpClient.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} must fail closed`);
  const serialized = JSON.stringify(result);
  for (const value of forbidden) assert.doesNotMatch(serialized, new RegExp(escapeRegExp(value)), `${name} leaked blocked content`);
  return result;
}

async function waitForGoalWork(mcpClient, goalId, workId, wanted = 'waiting_review') {
  const deadline = Date.now() + 15_000;
  let refreshed;
  while (Date.now() < deadline) {
    refreshed = await callTool(mcpClient, 'refresh_goal', { goal_id: goalId });
    const item = refreshed.structuredContent.work.find((candidate) => candidate.workId === workId);
    if (item?.status === wanted) return refreshed;
    if (wanted === 'symlink_rejected') {
      const privateState = JSON.parse(await fs.readFile(path.join(dataRoot, 'goals', goalId, 'state.json'), 'utf8')); const privateItem = privateState.work.find((candidate) => candidate.workId === workId); const privateError = privateItem?.error || privateState.error || '';
      if (/ELOOP|symbolic link/i.test(privateError)) {
        assert.equal(item?.hasError, true); assert.match(item?.errorSha256 || '', /^[0-9a-f]{64}$/); assert.equal('error' in item, false);
        const publicPayload = JSON.stringify(refreshed); assert.equal(publicPayload.includes(privateError), false); assert.equal(publicPayload.includes(dataRoot), false); assert.equal(publicPayload.includes(fixture), false);
        return refreshed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${workId} to reach ${wanted}: ${JSON.stringify(refreshed?.structuredContent?.work)}`);
}

async function startSingleLiveGoal(mcpClient, { workspaceId, baseSha, goalKey, workId, fileGlob, title, goalText, wanted = 'waiting_review' }) {
  const proposed = await callTool(mcpClient, 'propose_goal', {
    workspace_id: workspaceId,
    goal_key: goalKey,
    title,
    goal: goalText ?? `Exercise the reviewed Live boundary for ${fileGlob}.`,
    completion_criteria: ['The bounded worker result is reviewed'],
    verification: ['git diff --check'],
    execution_policy: 'supervised',
    workspace_policy: 'live',
    permissions: {
      file_globs: [fileGlob],
      commands: ['git diff --check'],
      network: false,
      source_effects: { apply: true, commit: false, push: false, draft_pr: false }
    },
    base_sha: baseSha,
    limits: { max_concurrency: 1, timeout_ms: 30000, max_turns_per_worker: 1, max_retries_per_worker: 0 },
    work: [{ work_id: workId, title, goal: `Modify only ${fileGlob}.`, acceptance_criteria: ['The bounded change is present'], verification: ['git diff --check'], file_globs: [fileGlob] }]
  });
  const approved = await callTool(mcpClient, 'approve_goal', {
    goal_id: proposed.structuredContent.goal_id,
    expected_revision: proposed.structuredContent.revision,
    contract_fingerprint: proposed.structuredContent.contract_fingerprint,
    approval_key: `${goalKey}-approval`,
    confirm: true
  });
  const started = await callTool(mcpClient, 'start_goal', {
    goal_id: proposed.structuredContent.goal_id,
    expected_revision: approved.structuredContent.revision,
    start_key: `${goalKey}-start`
  });
  assert.equal(started.structuredContent.launched_run_count, 1);
  return waitForGoalWork(mcpClient, proposed.structuredContent.goal_id, workId, wanted);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
