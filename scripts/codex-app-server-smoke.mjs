import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-app-server-'));
const worktree = path.join(tmp, 'worktree');
const fakeBinary = path.join(tmp, 'fake-codex');
const logPath = path.join(tmp, 'fake-events.jsonl');

const fakeSource = `#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO || 'normal';
const logPath = process.env.FAKE_LOG;
let buffer = '';
let threadId = '019fa000-0000-7000-8000-000000000001';
const sessionId = '019fa000-0000-7000-8000-000000000099';
const turnId = '019fa000-0000-7000-8000-000000000002';
let approvalDeclined = !scenario.startsWith('approval');
let steered = scenario !== 'normal';
let completed = false;

function log(event) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(event) + '\\n');
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function thread() {
  return { id: threadId, sessionId, ephemeral: false, turns: [], status: { type: 'idle' } };
}

function turn(status = 'inProgress', items = [], error = null) {
  return { id: turnId, items, itemsView: 'full', status, error, startedAt: 1, completedAt: status === 'inProgress' ? null : 2, durationMs: status === 'inProgress' ? null : 1 };
}

function maybeComplete() {
  if (completed || !approvalDeclined || !steered) return;
  completed = true;
  const item = { type: 'agentMessage', id: 'agent-1', text: 'item authoritative sk-1234567890ABCDEF', phase: 'final_answer', memoryCitation: null };
  const finalItem = { ...item, text: 'turn authoritative sk-1234567890ZYXWVU' };
  send({ method: 'item/completed', params: { threadId, turnId, item, completedAtMs: 2 } });
  send({ method: 'turn/completed', params: { threadId, turn: turn('completed', [finalItem]) } });
}

function handle(message) {
  log({ type: 'message', message });
  if (message.method === 'initialize') {
    if (scenario === 'malformed') {
      process.stdout.write('{not-json\\n');
      return;
    }
    if (scenario === 'oversized') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { payload: 'x'.repeat(4096) } }) + '\\n');
      return;
    }
    send({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: thread(), model: message.params.model, modelProvider: 'openai', serviceTier: null, cwd: message.params.cwd, instructionSources: [], approvalPolicy: message.params.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, reasoningEffort: 'high' } });
    return;
  }
  if (message.method === 'thread/resume') {
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: thread(), model: message.params.model, modelProvider: 'openai', serviceTier: null, cwd: message.params.cwd, instructionSources: [], approvalPolicy: message.params.approvalPolicy, approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, reasoningEffort: 'high' } });
    return;
  }
  if (message.method === 'turn/start') {
    if (scenario === 'timeout' || scenario === 'abort') {
      send({ id: message.id, result: { turn: turn() } });
      return;
    }
    send({ id: message.id, result: { turn: turn() } });
    if (scenario === 'approval-inline') {
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd-1' } });
      return;
    }
    setTimeout(() => {
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'agent-1', delta: 'stream sk-1234567890STREAM' } });
      send({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: 'do it', plan: [{ step: 'edit', status: 'inProgress' }] } });
      send({ method: 'turn/diff/updated', params: { threadId, turnId, diff: 'diff --git a/a b/a\\n+secret sk-1234567890DIFF' } });
      if (scenario === 'approval') {
        send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'cmd-1' } });
      }
      maybeComplete();
    }, 15);
    return;
  }
  if (message.method === 'turn/steer') {
    steered = true;
    send({ id: message.id, result: { turnId } });
    maybeComplete();
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId, turn: turn('interrupted') } });
    return;
  }
  if (message.id === 'approval-1') {
    approvalDeclined = message.result?.decision === 'decline';
    log({ type: 'approval', declined: approvalDeclined });
  }
}

log({
  type: 'start',
  args,
  scenario,
  envProbe: {
    parentSecret: process.env.CODEXPRO_ENV_TEST_PARENT_SECRET ?? null,
    allowed: process.env.CODEXPRO_ENV_TEST_ALLOWED ?? null,
    keys: Object.keys(process.env).filter((key) => key.startsWith('CODEXPRO_ENV_TEST_')).sort()
  }
});
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.on('SIGTERM', () => {
  log({ type: 'signal', signal: 'SIGTERM' });
  process.exit(0);
});
`;

await fs.mkdir(worktree, { recursive: true });
await fs.writeFile(fakeBinary, fakeSource, { encoding: 'utf8', mode: 0o755 });

try {
  const { CodexAppServerClient, executeCodexAppServerTurn, CodexAppServerProtocolError } = await import(
    pathToFileURL(path.join(projectRoot, 'dist', 'codexAppServerClient.js')).href
  );
  const events = [];
  const client = new CodexAppServerClient({
    codexBinary: fakeBinary,
    cwd: worktree,
    env: { FAKE_LOG: logPath, FAKE_SCENARIO: 'normal' },
    requestTimeoutMs: 2_000,
    turnTimeoutMs: 2_000,
    idleShutdownMs: 25,
    shutdownGraceMs: 500,
    onEvent: (event) => events.push(event)
  });
  const identity = await client.startOrResumeThread();
  assert.equal(identity.resumed, false);
  assert.equal(identity.model, 'gpt-5.6-sol');
  assert.equal(identity.effort, 'high');
  assert.equal(identity.cwd, await fs.realpath(worktree));

  const run = client.runTurn({ prompt: 'normal collaboration' });
  await waitFor(() => events.some((event) => event.type === 'agent_delta'));
  await client.steer('include the verification result');
  const result = await run;
  assert.equal(result.threadId, identity.threadId);
  assert.equal(result.sessionId, identity.sessionId);
  assert.equal(result.status, 'completed');
  assert.equal(result.finalText, 'turn authoritative [REDACTED_SECRET]');
  assert.equal(result.latestPlan?.steps[0]?.step, 'edit');
  assert.match(result.latestDiff, /\[REDACTED_SECRET\]/);
  assert(events.some((event) => event.type === 'turn_started' && event.turnId === result.turnId));
  assert(events.some((event) => event.type === 'plan'));
  assert(events.some((event) => event.type === 'diff'));
  assert(events.some((event) => event.type === 'item_completed'));
  assert(!JSON.stringify(events).includes('sk-1234567890'));
  await waitFor(async () => (await readLog()).some((entry) => entry.type === 'signal'));

  const log = await readLog();
  const start = log.find((entry) => entry.type === 'start');
  assert.deepEqual(start?.args, ['app-server', '--listen', 'stdio://']);
  const initialize = findRequest(log, 'initialize');
  assert.equal(initialize.params.clientInfo.name, 'codexpro');
  assert.equal(initialize.params.capabilities.experimentalApi, false);
  assert.equal(initialize.params.capabilities.requestAttestation, false);
  const threadStart = findRequest(log, 'thread/start');
  assert.equal(threadStart.params.ephemeral, false);
  assert.equal(threadStart.params.sandbox, 'workspace-write');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  const turnStart = findRequest(log, 'turn/start');
  assert.equal(turnStart.params.model, 'gpt-5.6-sol');
  assert.equal(turnStart.params.effort, 'high');
  assert.equal(turnStart.params.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(turnStart.params.sandboxPolicy.writableRoots, [await fs.realpath(worktree)]);
  assert.equal(turnStart.params.sandboxPolicy.networkAccess, false);

  const resumed = await executeCodexAppServerTurn({
    codexBinary: fakeBinary,
    cwd: worktree,
    env: { FAKE_LOG: logPath, FAKE_SCENARIO: 'resume' },
    threadId: identity.threadId,
    prompt: 'resume collaboration',
    requestTimeoutMs: 2_000,
    timeoutMs: 2_000
  });
  assert.equal(resumed.threadId, identity.threadId);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sessionId, identity.sessionId);
  const resumedLog = await readLog();
  const resumeRequest = [...resumedLog].reverse().find((entry) => entry.type === 'message' && entry.message?.method === 'thread/resume')?.message;
  assert.equal(resumeRequest?.params.threadId, identity.threadId);

  const previousParentSecret = process.env.CODEXPRO_ENV_TEST_PARENT_SECRET;
  process.env.CODEXPRO_ENV_TEST_PARENT_SECRET = 'must-not-reach-child';
  try {
    const isolated = await executeCodexAppServerTurn({
      codexBinary: fakeBinary,
      cwd: worktree,
      inheritEnv: false,
      env: {
        PATH: process.env.PATH,
        FAKE_LOG: logPath,
        FAKE_SCENARIO: 'env-check',
        CODEXPRO_ENV_TEST_ALLOWED: 'visible'
      },
      prompt: 'isolated environment',
      requestTimeoutMs: 2_000,
      timeoutMs: 2_000
    });
    assert.equal(isolated.status, 'completed');
  } finally {
    if (previousParentSecret === undefined) delete process.env.CODEXPRO_ENV_TEST_PARENT_SECRET;
    else process.env.CODEXPRO_ENV_TEST_PARENT_SECRET = previousParentSecret;
  }
  const isolatedStart = [...(await readLog())].reverse().find((entry) => entry.type === 'start' && entry.scenario === 'env-check');
  assert(isolatedStart, 'missing isolated environment child start');
  assert.equal(isolatedStart.envProbe.parentSecret, null);
  assert.equal(isolatedStart.envProbe.allowed, 'visible');
  assert.deepEqual(isolatedStart.envProbe.keys, ['CODEXPRO_ENV_TEST_ALLOWED']);

  const approvalEvents = [];
  const approvalResult = await executeCodexAppServerTurn({
    codexBinary: fakeBinary,
    cwd: worktree,
    env: { FAKE_LOG: logPath, FAKE_SCENARIO: 'approval-inline' },
    prompt: 'must fail closed',
    requestTimeoutMs: 2_000,
    timeoutMs: 2_000,
    interruptGraceMs: 1_000,
    onEvent: (event) => approvalEvents.push(event)
  });
  assert.equal(approvalResult.status, 'interrupted');
  assert(approvalResult.errors.some((error) => error.includes('Declined server request')));
  assert(approvalEvents.some((event) => event.type === 'server_request_declined' && event.method === 'item/commandExecution/requestApproval'));
  assert((await readLog()).some((entry) => entry.type === 'approval' && entry.declined === true));

  const timedOut = await executeCodexAppServerTurn({
    codexBinary: fakeBinary,
    cwd: worktree,
    env: { FAKE_LOG: logPath, FAKE_SCENARIO: 'timeout' },
    prompt: 'timeout',
    requestTimeoutMs: 2_000,
    timeoutMs: 30,
    interruptGraceMs: 1_000
  });
  assert.equal(timedOut.status, 'interrupted');
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.aborted, false);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const aborted = await executeCodexAppServerTurn({
    codexBinary: fakeBinary,
    cwd: worktree,
    env: { FAKE_LOG: logPath, FAKE_SCENARIO: 'abort' },
    prompt: 'abort',
    signal: controller.signal,
    requestTimeoutMs: 2_000,
    timeoutMs: 2_000,
    interruptGraceMs: 1_000
  });
  assert.equal(aborted.status, 'interrupted');
  assert.equal(aborted.aborted, true);

  await assert.rejects(
    executeCodexAppServerTurn({
      codexBinary: fakeBinary,
      cwd: worktree,
      env: { FAKE_SCENARIO: 'malformed' },
      prompt: 'malformed',
      requestTimeoutMs: 1_000
    }),
    (error) => error instanceof CodexAppServerProtocolError && /Malformed JSON/.test(error.message)
  );

  await assert.rejects(
    executeCodexAppServerTurn({
      codexBinary: fakeBinary,
      cwd: worktree,
      env: { FAKE_SCENARIO: 'oversized' },
      prompt: 'oversized',
      requestTimeoutMs: 1_000,
      limits: { maxLineBytes: 1_024, maxMessageBytes: 1_024 }
    }),
    (error) => error instanceof CodexAppServerProtocolError && /size limit|line exceeds/.test(error.message)
  );

  console.log('codex app-server smoke: ok');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

async function readLog() {
  try {
    return (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function findRequest(log, method) {
  const request = log.find((entry) => entry.type === 'message' && entry.message?.method === method)?.message;
  assert(request, `missing ${method} request`);
  return request;
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for fake app-server state');
}
