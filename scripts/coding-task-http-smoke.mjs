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
const useRealCodex = process.env.CODEXPRO_REAL_CODEX_E2E === '1';
const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task-http-e2e-')));
const sourceRoot = path.join(fixture, 'source');
const taskDataRoot = path.join(fixture, 'private-task-state');
const jobDataRoot = path.join(fixture, 'private-job-state');
const codexHome = path.join(fixture, 'private-codex-home');
const remoteRoot = path.join(fixture, 'remote.git');
const fakeCodex = path.join(fixture, 'fake-codex');
const passiveLaunchMarker = path.join(fixture, 'passive-codex-launch.marker');
const token = 'codexpro-coding-task-http-smoke-token';
const blockedEnvSentinel = 'BLOCKED_ENV_SENTINEL_never_return';
const blockedPemSentinel = 'BLOCKED_PEM_SENTINEL_never_return';
const blockedPemBody = `-----BEGIN PRIVATE KEY-----\n${blockedPemSentinel}\n-----END PRIVATE KEY-----\n`;
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const mcpUrl = `${baseUrl}/mcp`;
let server;
let client;

try {
  await Promise.all([
    fs.mkdir(sourceRoot),
    fs.mkdir(taskDataRoot, { mode: 0o700 }),
    fs.mkdir(jobDataRoot, { mode: 0o700 }),
    fs.mkdir(codexHome, { mode: 0o700 })
  ]);
  git(fixture, ['init', '--bare', remoteRoot]);
  git(sourceRoot, ['init']);
  git(sourceRoot, ['config', 'user.email', 'http-smoke@example.test']);
  git(sourceRoot, ['config', 'user.name', 'CodingTask HTTP Smoke']);
  await fs.writeFile(path.join(sourceRoot, 'shared.txt'), 'base\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, '.env'), 'TRACKED_ENV_BASE=placeholder\n', 'utf8');
  git(sourceRoot, ['add', 'shared.txt', '.env']);
  git(sourceRoot, ['commit', '-m', 'base']);
  git(sourceRoot, ['remote', 'add', 'origin', remoteRoot]);
  git(sourceRoot, ['push', '-u', 'origin', 'HEAD:refs/heads/main']);

  const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  const sourceStatusBefore = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const sourceRefsBefore = git(sourceRoot, ['show-ref']);
  const sourceCommitsBefore = git(sourceRoot, ['rev-list', '--all', '--objects']);
  const remoteRefsBefore = git(remoteRoot, ['show-ref']);
  const sourceTextBefore = await fs.readFile(path.join(sourceRoot, 'shared.txt'), 'utf8');

  let codexBinary;
  if (useRealCodex) {
    codexBinary = resolveRealCodexBinary();
    console.log(`coding task HTTP smoke: using real Codex at ${codexBinary}`);
  } else {
    await fs.writeFile(fakeCodex, fakeCodexSource(passiveLaunchMarker), { mode: 0o755 });
    codexBinary = fakeCodex;
  }

  const serverEnv = cleanServerEnv({
    CODEXPRO_ROOT: sourceRoot,
    CODEXPRO_ALLOWED_ROOTS: sourceRoot,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'full',
    CODEXPRO_WRITE_MODE: 'workspace',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TASK_DIR: taskDataRoot,
    CODEXPRO_JOB_DIR: jobDataRoot,
    CODEXPRO_CODEX_DIR: useRealCodex
      ? path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
      : codexHome,
    CODEXPRO_CODEX_BIN: codexBinary,
    CODEXPRO_CODEX_MODEL: process.env.CODEXPRO_REAL_CODEX_MODEL || 'gpt-5.6-sol',
    CODEXPRO_CODEX_REASONING_EFFORT: process.env.CODEXPRO_REAL_CODEX_EFFORT || 'high',
    CODEXPRO_CODING_TASK_TIMEOUT_MS: useRealCodex ? '600000' : '30000',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_INHERIT_ENV: '0'
  });

  server = await startServer(serverEnv);
  const connected = await connectClient(mcpUrl, token);
  client = connected.client;
  const transport = connected.transport;

  const opened = await callTool(client, 'open_current_workspace', { include_tree: false });
  const sourceWorkspaceId = opened.structuredContent.workspace_id;
  assert.equal(opened.structuredContent.root, sourceRoot);

  const created = await callTool(client, 'create_coding_task', {
    workspace_id: sourceWorkspaceId,
    task_key: 'http-primary-lifecycle',
    title: 'HTTP primary CodingTask lifecycle',
    goal: 'Exercise direct and Codex ownership through the real HTTP MCP entry point.',
    executor: 'direct',
    base_sha: baseSha
  });
  const taskId = created.structuredContent.task_id;
  const taskWorkspaceId = created.structuredContent.workspace_id;
  const worktreeRoot = created.structuredContent.worktree_root;
  assert.match(taskId, /^task_[a-f0-9]{24}$/);
  assert.equal(taskWorkspaceId, `taskws_${taskId.slice(5)}`);
  assert.equal(created.structuredContent.executor, 'direct');
  assert.equal(created.structuredContent.base_sha, baseSha);
  assert.equal((await fs.stat(taskDataRoot)).mode & 0o077, 0, 'task data root must remain private');
  assert.equal(git(worktreeRoot, ['rev-parse', 'HEAD']), baseSha);

  const originalTaskStatePath = path.join(taskDataRoot, 'tasks', taskId, 'state.json');
  const originalTaskState = JSON.parse(await fs.readFile(originalTaskStatePath, 'utf8'));
  const hiddenSourceRoot = path.join(fixture, 'not-allowed-source');
  const hiddenTaskIds = [];
  for (let index = 0; index < 25; index += 1) {
    const hiddenTaskId = `task_${(0xbcd000 + index).toString(16).padStart(24, '0')}`;
    hiddenTaskIds.push(hiddenTaskId);
    const hiddenTaskDir = path.join(taskDataRoot, 'tasks', hiddenTaskId);
    await fs.mkdir(hiddenTaskDir, { mode: 0o700 });
    const hiddenState = {
      ...originalTaskState,
      taskId: hiddenTaskId,
      taskKey: `newer-hidden-task-${index}`,
      workspaceId: `taskws_${hiddenTaskId.slice(5)}`,
      title: `Newer hidden CodingTask ${index}`,
      sourceRoot: hiddenSourceRoot,
      worktreeRoot: path.join(taskDataRoot, 'worktrees', hiddenTaskId),
      updatedAt: new Date(Date.now() + index + 1).toISOString()
    };
    await fs.writeFile(path.join(hiddenTaskDir, 'state.json'), `${JSON.stringify(hiddenState)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const limitedAllowedTasks = await callTool(client, 'list_coding_tasks', { limit: 1 });
  assert.equal(limitedAllowedTasks.structuredContent.task_count, 1, 'newer disallowed CodingTasks must not consume the requested list limit');
  assert.equal(limitedAllowedTasks.structuredContent.tasks[0]?.taskId, taskId, 'list_coding_tasks must filter allowed source roots before applying limit');
  assert.equal(hiddenTaskIds.some((hiddenTaskId) => JSON.stringify(limitedAllowedTasks.structuredContent).includes(hiddenTaskId)), false);

  const directWrite = await callTool(client, 'write', {
    workspace_id: taskWorkspaceId,
    path: 'shared.txt',
    content: 'direct-before\n',
    expected_sha256: (await callTool(client, 'read', {
      workspace_id: taskWorkspaceId,
      path: 'shared.txt'
    })).structuredContent.sha256
  });
  assert.equal(directWrite.structuredContent.workspace_id, taskWorkspaceId);
  const directRead = await callTool(client, 'read', { workspace_id: taskWorkspaceId, path: 'shared.txt' });
  assert.match(directRead.structuredContent.text, /direct-before/);
  assert.equal(await fs.readFile(path.join(worktreeRoot, 'shared.txt'), 'utf8'), 'direct-before\n');

  // These fixture mutations happen while Direct owns the isolated worktree. They
  // deliberately bypass MCP writes because normal workspace tools must reject the
  // blocked paths; review may report their paths but must never expose content.
  await fs.writeFile(path.join(worktreeRoot, '.env'), `TRACKED_ENV_BASE=placeholder\n${blockedEnvSentinel}=secret\n`, 'utf8');
  await fs.writeFile(path.join(worktreeRoot, 'private-key.pem'), blockedPemBody, 'utf8');
  const blockedEnvRead = await callToolResult(client, 'read', { workspace_id: taskWorkspaceId, path: '.env' });
  const blockedPemRead = await callToolResult(client, 'read', { workspace_id: taskWorkspaceId, path: 'private-key.pem' });
  assert.equal(blockedEnvRead.isError, true, 'tracked blocked files must remain unreadable through the normal task workspace');
  assert.equal(blockedPemRead.isError, true, 'untracked blocked key files must remain unreadable through the normal task workspace');
  assert.doesNotMatch(toolText(blockedEnvRead), new RegExp(blockedEnvSentinel));
  assert.doesNotMatch(toolText(blockedPemRead), new RegExp(blockedPemSentinel));

  const toCodex = await callTool(client, 'transition_coding_task', {
    task_id: taskId,
    to: 'codex',
    expected_revision: directWrite.structuredContent.revision,
    transition_key: 'direct-to-codex'
  });
  assert.equal(toCodex.structuredContent.executor, 'codex');

  // Keep this near the public 160-character limit. Runner log metadata hashes
  // long IDs, so get_coding_task must recover runs from immutable definitions,
  // never by parsing a display log name.
  const operationId = `http-primary-run-${'x'.repeat(140)}`;
  const primaryPrompt = useRealCodex
    ? 'In this task worktree only, create codex-live.txt with the exact content "codex live primary\\n" and append the exact line "codex-first" to shared.txt. Do not commit, merge, push, or delete the worktree. Report the files changed.'
    : 'Apply the deterministic HTTP smoke edit, then wait for follow-up guidance.';
  await callTool(client, 'run_coding_task', {
    task_id: taskId,
    operation_id: operationId,
    prompt: primaryPrompt,
    expected_revision: toCodex.structuredContent.revision,
    timeout_ms: useRealCodex ? 600000 : 30000
  });

  if (!useRealCodex) {
    await waitForTask(client, taskId, (value) =>
      value.structuredContent.executor === 'codex' &&
      value.structuredContent.task.codexTurnActive === true &&
      value.structuredContent.run?.status === 'running',
    15000, operationId);
  }

  const rejectedWrite = await callToolResult(client, 'write', {
    workspace_id: taskWorkspaceId,
    path: 'forbidden-while-codex.txt',
    content: 'must not exist\n'
  });
  assert.equal(rejectedWrite.isError, true, 'direct write must fail while Codex owns the task');
  assert.match(toolText(rejectedWrite), /expected direct|owned by codex|executor.*codex|active codex_run/i);
  await assert.rejects(fs.stat(path.join(worktreeRoot, 'forbidden-while-codex.txt')), { code: 'ENOENT' });

  const rejectedJob = await callToolResult(client, 'start_background_job', {
    workspace_id: taskWorkspaceId,
    job_key: 'forbidden-task-job',
    command: 'printf forbidden'
  });
  assert.equal(rejectedJob.isError, true, 'durable jobs must fail inside CodingTask worktrees');
  assert.match(toolText(rejectedJob), /not supported inside CodingTask worktrees/i);

  let terminal;
  if (useRealCodex) {
    terminal = await waitForTask(client, taskId, isWaitingReview, 600000, operationId);
    const inferredPrimary = await callTool(client, 'get_coding_task', { task_id: taskId });
    assert.equal(inferredPrimary.structuredContent.run?.operationId, operationId);
    const followup = await callTool(client, 'followup_coding_task', {
      task_id: taskId,
      request_key: 'http-idle-followup',
      prompt: 'Resume this same thread. Append the exact line "codex-followup" to shared.txt. Do not commit, merge, push, or delete the worktree. Report completion.',
      expected_revision: terminal.structuredContent.revision,
      timeout_ms: 600000
    });
    assert.equal(followup.structuredContent.run?.threadId ?? followup.structuredContent.thread_id, terminal.structuredContent.thread_id);
    terminal = await waitForTask(client, taskId, isWaitingReview, 600000, 'followup:http-idle-followup');
  } else {
    const followup = await callTool(client, 'followup_coding_task', {
      task_id: taskId,
      request_key: 'http-active-steer',
      prompt: 'Append the deterministic follow-up line and finish.'
    });
    assert.equal(followup.structuredContent.followup?.mode, 'steer');
    assert.equal(followup.structuredContent.followup?.steer?.status, 'queued');
    terminal = await waitForTask(client, taskId, isWaitingReview, 30000, operationId);
    assert.equal(terminal.structuredContent.run.finalText, 'fake Codex completed primary edit and active steer');
    const inferredPrimary = await callTool(client, 'get_coding_task', { task_id: taskId });
    assert.equal(
      inferredPrimary.structuredContent.run?.operationId,
      operationId,
      'terminal get without operation_id must restore the long ID from immutable run definitions'
    );
  }

  assert.equal(terminal.structuredContent.executor, 'codex');
  assert.equal(terminal.structuredContent.lifecycle, 'waiting_review');
  assert.equal(terminal.structuredContent.run.status, 'waiting_review');
  assert.equal(terminal.structuredContent.run.runnerAlive, false);
  assert.equal(terminal.structuredContent.git_observation.dirty, true);
  assert.equal(terminal.structuredContent.git_observation.headSha, baseSha);
  assert.match(terminal.structuredContent.run.finalText, useRealCodex ? /codex|changed|shared/i : /active steer/);

  const codexRead = await callTool(client, 'read', { workspace_id: taskWorkspaceId, path: 'shared.txt' });
  assert.match(codexRead.structuredContent.text, /direct-before[\s\S]*codex-first[\s\S]*codex-followup/);
  assert.equal(await fs.readFile(path.join(worktreeRoot, 'shared.txt'), 'utf8'), 'direct-before\ncodex-first\ncodex-followup\n');
  if (useRealCodex) {
    const liveRead = await callTool(client, 'read', { workspace_id: taskWorkspaceId, path: 'codex-live.txt' });
    assert.match(liveRead.structuredContent.text, /codex live primary/);
    assert.equal(await fs.readFile(path.join(worktreeRoot, 'codex-live.txt'), 'utf8'), 'codex live primary\n');
  }
  const review = await callTool(client, 'review_coding_task', { task_id: taskId });
  assert.equal(review.structuredContent.review.dirty, true);
  assert.equal(review.structuredContent.review.headSha, baseSha);
  assert.match(review.structuredContent.review.status, /shared\.txt/);
  assert.match(review.structuredContent.review.diff, /codex-followup/);
  assert.equal(review.structuredContent.review.contentComplete, false);
  assert.equal(review.structuredContent.review.omittedPathCount, 2);
  assert.deepEqual(review.structuredContent.review.omittedPaths, ['.env', 'private-key.pem']);
  assert.equal(review.structuredContent.content_complete, false);
  assert.equal(review.structuredContent.omitted_path_count, 2);
  assert.deepEqual(review.structuredContent.omitted_paths, ['.env', 'private-key.pem']);
  assert.doesNotMatch(review.structuredContent.review.diff, new RegExp(blockedEnvSentinel));
  assert.doesNotMatch(review.structuredContent.review.diff, new RegExp(blockedPemSentinel));
  assert.doesNotMatch(toolText(review), new RegExp(`${blockedEnvSentinel}|${blockedPemSentinel}`));
  const reviewJson = JSON.stringify(review.structuredContent);
  assert.doesNotMatch(reviewJson, new RegExp(`${blockedEnvSentinel}|${blockedPemSentinel}`));
  assert.ok(!reviewJson.includes(blockedPemBody), 'structured review JSON must not expose the PEM body');

  const backToDirect = await callTool(client, 'transition_coding_task', {
    task_id: taskId,
    to: 'direct',
    expected_revision: terminal.structuredContent.revision,
    transition_key: 'codex-to-direct'
  });
  assert.equal(backToDirect.structuredContent.executor, 'direct');
  const finalEdit = await callTool(client, 'edit', {
    workspace_id: taskWorkspaceId,
    path: 'shared.txt',
    old_text: 'codex-followup\n',
    new_text: 'codex-followup\ndirect-after\n',
    expected_replacements: 1,
    expected_sha256: codexRead.structuredContent.sha256
  });
  assert.equal(finalEdit.structuredContent.executor, 'direct');

  const staleSessionId = transport.sessionId;
  assert.ok(staleSessionId, 'HTTP MCP transport must receive a session id');
  await stopServer(server);
  server = undefined;
  server = await startServer(serverEnv);

  const recoveredTask = await postToolCall(baseUrl, token, staleSessionId, 'get_coding_task', {
    task_id: taskId
  });
  assert.equal(recoveredTask.task_id, taskId);
  assert.equal(recoveredTask.workspace_id, taskWorkspaceId);
  assert.equal(recoveredTask.executor, 'direct');
  assert.equal(recoveredTask.git_observation.dirty, true);
  assert.ok(recoveredTask.run?.finalText, 'persisted final Codex result must survive server restart');
  assert.equal(
    recoveredTask.run?.operationId,
    useRealCodex ? 'followup:http-idle-followup' : operationId,
    'latest run recovery must use immutable run definitions rather than hashed log metadata'
  );

  const recoveredRead = await postToolCall(baseUrl, token, staleSessionId, 'read', {
    workspace_id: taskWorkspaceId,
    path: 'shared.txt'
  });
  assert.equal(recoveredRead.workspace_id, taskWorkspaceId);
  assert.match(recoveredRead.text, /direct-before[\s\S]*codex-first[\s\S]*codex-followup[\s\S]*direct-after/);
  assert.equal(await fs.readFile(path.join(worktreeRoot, 'shared.txt'), 'utf8'), 'direct-before\ncodex-first\ncodex-followup\ndirect-after\n');

  assert.equal(git(sourceRoot, ['rev-parse', 'HEAD']), baseSha, 'source HEAD must not move');
  assert.equal(git(worktreeRoot, ['rev-parse', 'HEAD']), baseSha, 'task flow must not auto-commit or merge');
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatusBefore, 'source worktree must stay untouched');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'shared.txt'), 'utf8'), sourceTextBefore);
  assert.equal(git(sourceRoot, ['show-ref']), sourceRefsBefore, 'local refs must not move');
  assert.equal(git(sourceRoot, ['rev-list', '--all', '--objects']), sourceCommitsBefore, 'no commit may be created');
  assert.equal(git(remoteRoot, ['show-ref']), remoteRefsBefore, 'remote refs must not move');
  assert.match(git(sourceRoot, ['worktree', 'list', '--porcelain']), new RegExp(escapeRegExp(worktreeRoot)), 'task worktree must not be deleted');
  await fs.stat(path.join(taskDataRoot, 'tasks', taskId, 'state.json'));

  // Dedicated passive-recovery regression. Persist a valid queued run with no
  // runner, then observe and cancel it only through a newly started off-mode
  // HTTP server. A launch marker in the fake binary proves no App Server child
  // was spawned by either endpoint.
  await client.close();
  client = undefined;
  await stopServer(server);
  server = undefined;
  await fs.writeFile(fakeCodex, fakeCodexSource(passiveLaunchMarker), { mode: 0o755 });
  await fs.unlink(passiveLaunchMarker).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  const restrictedPath = path.join(fixture, 'passive-path-without-codex');
  await fs.mkdir(restrictedPath, { mode: 0o700 });
  await fs.symlink(resolveExecutable('git'), path.join(restrictedPath, 'git'));
  const passive = await createQueuedOrphanFixture({
    sourceRoot,
    taskDataRoot,
    baseSha,
    fakeCodex
  });
  const deadRunning = await createDeadRunningFixture({
    sourceRoot,
    taskDataRoot,
    baseSha,
    fakeCodex
  });
  const passiveEnv = {
    ...serverEnv,
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_BASH_MODE: 'off',
    PATH: restrictedPath
  };
  delete passiveEnv.CODEXPRO_CODEX_BIN;
  server = await startServer(passiveEnv);
  const passiveConnected = await connectClient(mcpUrl, token);
  client = passiveConnected.client;
  const passiveConfig = await callTool(client, 'server_config');
  assert.equal(passiveConfig.structuredContent.codexBin, null, 'off-mode recovery server must have no configured Codex executable');
  await assert.rejects(fs.stat(path.join(restrictedPath, 'codex')), { code: 'ENOENT' });
  const taskBytesBeforeGet = await fs.readFile(passive.taskStatePath);
  const definitionBytesBeforeGet = await fs.readFile(passive.definitionPath);
  const runBytesBeforeGet = await fs.readFile(passive.runStatePath);
  const passiveGet = await callTool(client, 'get_coding_task', {
    task_id: passive.taskId,
    operation_id: passive.operationId
  });
  assert.equal(passiveGet.structuredContent.run?.status, 'queued');
  assert.equal(passiveGet.structuredContent.run?.runnerAlive, false);
  assert.equal(passiveGet.structuredContent.runner_alive, false);
  assert.equal(passiveGet.structuredContent.stranded, true);
  assert.equal(passiveGet.structuredContent.recovery_needed, true);
  assert.match(passiveGet.structuredContent.recovery_action, /Enable writeMode=workspace and bashMode=full/);
  assert.deepEqual(await fs.readFile(passive.taskStatePath), taskBytesBeforeGet, 'read-only get must not mutate task state');
  assert.deepEqual(await fs.readFile(passive.definitionPath), definitionBytesBeforeGet, 'read-only get must not mutate run definition');
  assert.deepEqual(await fs.readFile(passive.runStatePath), runBytesBeforeGet, 'read-only get must not reconcile queued run state');
  await assert.rejects(fs.stat(passiveLaunchMarker), { code: 'ENOENT' });

  const passiveCancel = await callTool(client, 'cancel_coding_task', {
    task_id: passive.taskId,
    operation_id: passive.operationId,
    reason: 'HTTP off-mode queued orphan cancellation'
  });
  assert.equal(passiveCancel.structuredContent.run?.status, 'canceled');
  assert.equal(passiveCancel.structuredContent.run?.runnerAlive, false);
  assert.equal(passiveCancel.structuredContent.cancellation?.status, 'canceled');
  assert.equal(passiveCancel.structuredContent.cancellation?.before_launch, true);
  assert.deepEqual(await fs.readFile(passive.taskStatePath), taskBytesBeforeGet, 'queued cancellation must preserve task lease/state');
  assert.deepEqual(await fs.readFile(passive.definitionPath), definitionBytesBeforeGet, 'queued cancellation must preserve immutable definition');
  const canceledRun = JSON.parse(await fs.readFile(passive.runStatePath, 'utf8'));
  assert.equal(canceledRun.status, 'canceled');
  assert.equal(canceledRun.operationId, passive.operationId);
  assert.equal(canceledRun.fingerprint, passive.fingerprint);
  assert.equal(canceledRun.runnerPid, undefined);
  await assert.rejects(fs.stat(passiveLaunchMarker), { code: 'ENOENT' });

  const deadRunningBefore = JSON.parse(await fs.readFile(deadRunning.taskStatePath, 'utf8'));
  assert.equal(deadRunningBefore.activeOperation?.operationId, deadRunning.operationId);
  const deadRunningCancel = await callTool(client, 'cancel_coding_task', {
    task_id: deadRunning.taskId,
    operation_id: deadRunning.operationId,
    reason: deadRunning.cancelReason
  });
  assert.equal(deadRunningCancel.structuredContent.lifecycle, 'canceled');
  assert.equal(deadRunningCancel.structuredContent.active_operation, null);
  assert.equal(deadRunningCancel.structuredContent.cancellation?.operationId, deadRunning.operationId);
  const deadRunningTaskAfter = JSON.parse(await fs.readFile(deadRunning.taskStatePath, 'utf8'));
  const deadRunningRunAfter = JSON.parse(await fs.readFile(deadRunning.runStatePath, 'utf8'));
  assert.equal(deadRunningTaskAfter.lifecycle, 'canceled');
  assert.equal(deadRunningTaskAfter.activeOperation, undefined);
  assert.equal(deadRunningTaskAfter.codexTurnActive, false);
  assert.equal(deadRunningTaskAfter.codexRunnerPid, undefined);
  assert.equal(deadRunningTaskAfter.cancelRequestedAt, undefined);
  assert.equal(deadRunningTaskAfter.lastCompletedOperation?.operationId, deadRunning.operationId);
  assert.equal(deadRunningTaskAfter.lastCompletedOperation?.lifecycle, 'canceled');
  assert.equal(deadRunningRunAfter.status, 'canceled');
  assert.equal(deadRunningRunAfter.operationId, deadRunning.operationId);
  assert.equal(deadRunningRunAfter.fingerprint, deadRunning.fingerprint);
  assert.equal(deadRunningRunAfter.runnerPid, 999999, 'dead PID remains historical evidence, never a live launch');
  assert.equal(deadRunningRunAfter.error, undefined, 'durable cancellation must dominate dead-run failure reconciliation');
  await assert.rejects(fs.stat(passiveLaunchMarker), { code: 'ENOENT' });

  const deadRunningTaskBytes = await fs.readFile(deadRunning.taskStatePath);
  const deadRunningRunBytes = await fs.readFile(deadRunning.runStatePath);
  const repeatedDeadCancel = await callTool(client, 'cancel_coding_task', {
    task_id: deadRunning.taskId,
    operation_id: deadRunning.operationId,
    reason: deadRunning.cancelReason
  });
  assert.equal(repeatedDeadCancel.structuredContent.lifecycle, 'canceled');
  assert.equal(repeatedDeadCancel.structuredContent.active_operation, null);
  assert.deepEqual(await fs.readFile(deadRunning.taskStatePath), deadRunningTaskBytes, 'repeated cancellation must not rewrite terminal task state');
  assert.deepEqual(await fs.readFile(deadRunning.runStatePath), deadRunningRunBytes, 'repeated cancellation must not rewrite terminal run state');
  await assert.rejects(fs.stat(passiveLaunchMarker), { code: 'ENOENT' });

  console.log(`coding task HTTP smoke: ok (${useRealCodex ? 'real Codex' : 'deterministic fake App Server'})`);
  console.log(`  task=${taskId} workspace=${taskWorkspaceId} base=${baseSha.slice(0, 12)}`);
  console.log('  verified: HTTP lifecycle, detached runner, follow-up, persisted result/Git observation, stateless restart recovery');
  console.log('  verified: ownership/job rejection, source isolation, and no commit/merge/push/worktree deletion');
  console.log('  verified: blocked .env/PEM reads, review content omission, visible allowed diff, and long-ID latest-run recovery');
  console.log('  verified: off-mode queued-orphan inspection is passive and exact cancellation never launches Codex');
  console.log('  verified: off-mode dead-running cancellation dominates failure, clears the active lease, and is idempotent');
} finally {
  await client?.close().catch(() => undefined);
  if (server) await stopServer(server).catch(() => undefined);
  await fs.rm(fixture, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function resolveExecutable(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`required executable not found: ${name}`);
  return result.stdout.trim();
}

async function createQueuedOrphanFixture({ sourceRoot, taskDataRoot, baseSha, fakeCodex }) {
  const taskId = 'task_fedcba9876543210fedcba98';
  const workspaceId = 'taskws_fedcba9876543210fedcba98';
  const taskDir = path.join(taskDataRoot, 'tasks', taskId);
  const worktreeRoot = path.join(taskDataRoot, 'worktrees', taskId);
  git(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, baseSha]);
  const commonDirRaw = git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sourceGitCommonDir = await fs.realpath(path.resolve(sourceRoot, commonDirRaw));
  const now = new Date().toISOString();
  const operationId = 'http-off-mode-queued-orphan';
  const leaseId = 'lease-http-passive';
  const task = {
    version: 1,
    taskId,
    taskKey: 'http-passive-recovery',
    createFingerprint: 'd'.repeat(64),
    title: 'HTTP passive recovery',
    goal: 'Prove off-mode reads and queued cancellation never relaunch Codex.',
    executor: 'codex',
    lifecycle: 'ready',
    baseSha,
    sourceRoot,
    sourceGitCommonDir,
    sourceUncommittedChangesIncluded: false,
    sourceDirtyAtCreation: false,
    sourceStatusEntryCountAtCreation: 0,
    worktreeRoot,
    workspaceId,
    revision: 1,
    executorLease: { owner: 'codex', epoch: 1, leaseId, acquiredAt: now },
    codexTurnActive: false,
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, kind: 'created', executor: 'codex', epoch: 1 }],
    logs: []
  };
  const token = `run_${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`;
  const runDir = path.join(taskDir, 'runs', token);
  const taskStatePath = path.join(taskDir, 'state.json');
  const definitionPath = path.join(runDir, 'definition.json');
  const runStatePath = path.join(runDir, 'state.json');
  const definition = {
    version: 1,
    taskId,
    operationId,
    prompt: 'queued orphan must stay passive',
    expectedRevision: 1,
    executorEpoch: 1,
    leaseId,
    worktreeRoot,
    codexBinary: fakeCodex,
    model: 'gpt-5.6-sol',
    effort: 'high',
    timeoutMs: 30000,
    maxLogBytes: 64 * 1024,
    createdAt: now
  };
  const fingerprint = runDefinitionFingerprint(definition);
  definition.fingerprint = fingerprint;
  const run = {
    version: 1,
    taskId,
    operationId,
    fingerprint,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    events: []
  };
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(taskStatePath, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 }),
    fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, { mode: 0o600 }),
    fs.writeFile(runStatePath, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
  ]);
  return { taskId, operationId, fingerprint, taskStatePath, definitionPath, runStatePath };
}

async function createDeadRunningFixture({ sourceRoot, taskDataRoot, baseSha, fakeCodex }) {
  const taskId = 'task_aaaaaaaaaaaaaaaaaaaaaaaa';
  const workspaceId = 'taskws_aaaaaaaaaaaaaaaaaaaaaaaa';
  const taskDir = path.join(taskDataRoot, 'tasks', taskId);
  const worktreeRoot = path.join(taskDataRoot, 'worktrees', taskId);
  git(sourceRoot, ['worktree', 'add', '--detach', worktreeRoot, baseSha]);
  const commonDirRaw = git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const sourceGitCommonDir = await fs.realpath(path.resolve(sourceRoot, commonDirRaw));
  const old = new Date(Date.now() - 60_000).toISOString();
  const operationId = 'http-off-mode-dead-running';
  const leaseId = 'lease-http-dead-running';
  const requestFingerprint = createHash('sha256').update(JSON.stringify({
    executor: 'codex',
    operationId,
    codexThreadId: null,
    codexSessionId: null,
    codexTurnId: null
  })).digest('hex');
  const task = {
    version: 1,
    taskId,
    taskKey: 'http-dead-running',
    createFingerprint: 'a'.repeat(64),
    title: 'HTTP dead running cancellation',
    goal: 'Prove cancellation dominates dead-run reconciliation without a Codex executable.',
    executor: 'codex',
    lifecycle: 'running',
    baseSha,
    sourceRoot,
    sourceGitCommonDir,
    sourceUncommittedChangesIncluded: false,
    sourceDirtyAtCreation: false,
    sourceStatusEntryCountAtCreation: 0,
    worktreeRoot,
    workspaceId,
    revision: 2,
    executorLease: { owner: 'codex', epoch: 1, leaseId, acquiredAt: old },
    activeOperation: {
      operationId,
      executor: 'codex',
      kind: 'codex_run',
      startedAt: old,
      heartbeatAt: old,
      pid: 999999,
      requestFingerprint
    },
    codexTurnActive: false,
    codexRunnerPid: 999999,
    codexHeartbeatAt: old,
    createdAt: old,
    updatedAt: old,
    startedAt: old,
    events: [
      { at: old, kind: 'created', executor: 'codex', epoch: 1 },
      { at: old, kind: 'codex_turn_started', executor: 'codex', epoch: 1, message: `Operation ${operationId} started.` }
    ],
    logs: []
  };
  const token = `run_${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`;
  const runDir = path.join(taskDir, 'runs', token);
  const taskStatePath = path.join(taskDir, 'state.json');
  const definitionPath = path.join(runDir, 'definition.json');
  const runStatePath = path.join(runDir, 'state.json');
  const definition = {
    version: 1,
    taskId,
    operationId,
    prompt: 'dead running operation',
    expectedRevision: 1,
    executorEpoch: 1,
    leaseId,
    worktreeRoot,
    codexBinary: fakeCodex,
    model: 'gpt-5.6-sol',
    effort: 'high',
    timeoutMs: 30000,
    maxLogBytes: 64 * 1024,
    createdAt: old
  };
  const fingerprint = runDefinitionFingerprint(definition);
  definition.fingerprint = fingerprint;
  const run = {
    version: 1,
    taskId,
    operationId,
    fingerprint,
    status: 'running',
    createdAt: old,
    updatedAt: old,
    startedAt: old,
    heartbeatAt: old,
    runnerPid: 999999,
    events: []
  };
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(taskStatePath, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 }),
    fs.writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, { mode: 0o600 }),
    fs.writeFile(runStatePath, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 })
  ]);
  return {
    taskId,
    operationId,
    fingerprint,
    cancelReason: 'HTTP off-mode dead-running cancellation',
    taskStatePath,
    definitionPath,
    runStatePath
  };
}

function runDefinitionFingerprint(definition) {
  return createHash('sha256').update(JSON.stringify({
    schema: 'codexpro-coding-task-run-v1',
    taskId: definition.taskId,
    operationId: definition.operationId,
    prompt: definition.prompt,
    revision: definition.expectedRevision,
    epoch: definition.executorEpoch,
    leaseId: definition.leaseId,
    threadId: definition.threadId ?? null,
    expectedSessionId: definition.expectedSessionId ?? null,
    continuationFingerprint: definition.continuationFingerprint ?? null,
    model: definition.model,
    effort: definition.effort,
    timeoutMs: definition.timeoutMs,
    worktreeRoot: definition.worktreeRoot,
    codexBinary: definition.codexBinary,
    maxLogBytes: definition.maxLogBytes,
    createdAt: definition.createdAt
  })).digest('hex');
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      listener.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port')));
    });
    listener.on('error', reject);
  });
}

function cleanServerEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CODEXPRO_') || key.startsWith('CODEBASE_BRIDGE_')) delete env[key];
  }
  return { ...env, ...overrides };
}

async function startServer(env) {
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for HTTP server\n${stderr}`)), 20000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening (${code ?? signal})\n${stderr}`));
    });
  });
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function connectClient(url, authToken) {
  const connectedClient = new Client({ name: 'codexpro-coding-task-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${authToken}` } }
  });
  await connectedClient.connect(transport);
  return { client: connectedClient, transport };
}

async function callToolResult(mcpClient, name, args = {}) {
  return mcpClient.callTool({ name, arguments: args });
}

async function callTool(mcpClient, name, args = {}) {
  const result = await callToolResult(mcpClient, name, args);
  if (result.isError) throw new Error(`${name} failed: ${toolText(result)}`);
  return result;
}

function toolText(result) {
  return result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
}

async function waitForTask(mcpClient, taskId, predicate, timeoutMs, operationId) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await callTool(mcpClient, 'get_coding_task', {
      task_id: taskId,
      operation_id: operationId,
      include_run: true
    });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for CodingTask ${taskId}: ${JSON.stringify(last?.structuredContent)}`);
}

function isWaitingReview(value) {
  return value.structuredContent.lifecycle === 'waiting_review' && value.structuredContent.run?.status === 'waiting_review';
}

async function postToolCall(url, authToken, sessionId, name, args) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await response.json();
  if (response.status !== 200 || body.result?.isError || !body.result?.structuredContent) {
    throw new Error(`stateless ${name} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body.result.structuredContent;
}

function resolveRealCodexBinary() {
  if (process.env.CODEXPRO_REAL_CODEX_BIN) return path.resolve(process.env.CODEXPRO_REAL_CODEX_BIN);
  const found = spawnSync('which', ['codex'], { encoding: 'utf8', windowsHide: true });
  if (found.status !== 0 || !found.stdout.trim()) {
    throw new Error('CODEXPRO_REAL_CODEX_E2E=1 requires codex on PATH or CODEXPRO_REAL_CODEX_BIN.');
  }
  return found.stdout.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fakeCodexSource(launchMarker) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(${JSON.stringify(launchMarker)}, 'launched\\n');
let buffer = '';
let activeTurnId;
let timeout;
const threadId = 'thread-http-smoke';
const sessionId = 'session-http-smoke';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function fail(message) { process.stderr.write(message + '\\n'); process.exit(2); }
function complete() {
  clearTimeout(timeout);
  const item = { type: 'agentMessage', id: 'final-http', text: 'fake Codex completed primary edit and active steer', phase: 'final_answer' };
  send({ method: 'item/completed', params: { threadId, turnId: activeTurnId, item } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurnId, status: 'completed', error: null, items: [item] } } });
}
function handle(message) {
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.model !== 'gpt-5.6-sol' || message.params.approvalPolicy !== 'never' || message.params.cwd !== process.cwd()) fail('invalid thread contract');
    return send({ id: message.id, result: { thread: { id: message.params.threadId || threadId, sessionId, ephemeral: false } } });
  }
  if (message.method === 'turn/start') {
    if (message.params.model !== 'gpt-5.6-sol' || message.params.effort !== 'high' || message.params.approvalPolicy !== 'never') fail('invalid turn policy');
    if (message.params.cwd !== process.cwd() || message.params.sandboxPolicy?.type !== 'workspaceWrite' || message.params.sandboxPolicy?.networkAccess !== false) fail('invalid worktree sandbox');
    if (message.params.sandboxPolicy?.writableRoots?.length !== 1 || path.resolve(message.params.sandboxPolicy.writableRoots[0]) !== process.cwd()) fail('invalid writable roots');
    activeTurnId = 'turn-http-smoke';
    fs.appendFileSync(path.join(process.cwd(), 'shared.txt'), 'codex-first\\n');
    send({ id: message.id, result: { turn: { id: activeTurnId, status: 'inProgress', error: null, items: [] } } });
    timeout = setTimeout(() => fail('active steer was not delivered'), 20000);
    return;
  }
  if (message.method === 'turn/steer') {
    if (message.params.expectedTurnId !== activeTurnId || message.params.threadId !== threadId) fail('invalid steer identity');
    fs.appendFileSync(path.join(process.cwd(), 'shared.txt'), 'codex-followup\\n');
    send({ id: message.id, result: { turnId: activeTurnId } });
    setTimeout(complete, 20);
    return;
  }
  if (message.method === 'turn/interrupt') {
    clearTimeout(timeout);
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId, turn: { id: activeTurnId, status: 'interrupted', error: null, items: [] } } });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;
}
