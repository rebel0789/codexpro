import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(root, jobDir, bashMode = 'full') {
    this.child = spawn('node', ['dist/stdio.js', '--root', root, '--allow-root', root, '--bash', bashMode, '--tool-mode', 'full'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_JOB_DIR: jobDir,
        CODEXPRO_BACKGROUND_JOB_TIMEOUT_MS: '10000',
        CODEXPRO_BACKGROUND_JOB_MAX_LOG_BYTES: '65536'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.on('exit', (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code ?? signal}\n${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 20000) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}\n${this.stderr}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codexpro-background-job-smoke', version: '0.1.0' }
    });
    this.notify('notifications/initialized');
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

async function expectToolError(client, name, args, pattern) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (!result.isError) throw new Error(`${name} unexpectedly succeeded`);
  const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
  if (!pattern.test(text)) throw new Error(`${name} error did not match ${pattern}: ${text}`);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for HTTP server: ${lastError}`);
}

function startHttpServer(workspace, jobDir, port, token) {
  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: workspace,
      CODEXPRO_ALLOWED_ROOTS: workspace,
      CODEXPRO_JOB_DIR: jobDir,
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_HTTP_TOKEN: token,
      CODEXPRO_BASH_MODE: 'full',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_BACKGROUND_JOB_TIMEOUT_MS: '10000',
      CODEXPRO_BACKGROUND_JOB_MAX_LOG_BYTES: '65536'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return { child, stderr: () => stderr };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-background-job-workspace-'));
const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-background-job-state-'));
await fs.writeFile(path.join(workspace, 'README.md'), '# background job smoke\n', 'utf8');
for (const args of [
  ['init'],
  ['add', 'README.md'],
  ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'background job fixture']
]) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}
const gitHeadResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
if (gitHeadResult.status !== 0) throw new Error(`git rev-parse HEAD failed: ${gitHeadResult.stderr}`);
const gitHead = gitHeadResult.stdout.trim();
let client;
let httpRuntime;
let httpClient;

try {
  const inWorkspaceState = path.join(workspace, '.durable-jobs');
  const unsafeConfig = spawnSync('node', ['dist/stdio.js', '--root', workspace, '--allow-root', workspace], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: workspace,
      CODEXPRO_ALLOWED_ROOTS: workspace,
      CODEXPRO_JOB_DIR: inWorkspaceState
    },
    encoding: 'utf8'
  });
  if (unsafeConfig.status === 0 || !unsafeConfig.stderr.includes('must stay outside every allowed workspace')) {
    throw new Error(`workspace-local durable job state was not rejected: ${unsafeConfig.stderr || unsafeConfig.stdout}`);
  }

  client = new McpStdioClient(workspace, jobDir);
  await client.initialize();
  const tools = await client.request('tools/list', {});
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of ['start_background_job', 'get_background_job', 'list_background_jobs', 'wait_for_background_job', 'cancel_background_job']) {
    if (!toolNames.has(expected)) throw new Error(`missing durable job tool: ${expected}`);
  }
  const startTool = tools.tools.find((tool) => tool.name === 'start_background_job');
  if (!startTool?.inputSchema?.properties?.expected_git_head || !startTool?.inputSchema?.properties?.require_clean_worktree) {
    throw new Error(`start_background_job did not advertise Git identity guards: ${JSON.stringify(startTool?.inputSchema)}`);
  }

  await expectToolError(client, 'start_background_job', {
    job_key: 'smoke:wrong-head',
    command: `node -e "console.log('must-not-run')"`,
    expected_git_head: '0000000000000000000000000000000000000000',
    require_clean_worktree: true
  }, /expected HEAD .* observed .* No command was started/i);

  await fs.writeFile(path.join(workspace, 'dirty.txt'), 'dirty\n', 'utf8');
  await expectToolError(client, 'start_background_job', {
    job_key: 'smoke:dirty-worktree',
    command: `node -e "console.log('must-not-run')"`,
    expected_git_head: gitHead,
    require_clean_worktree: true
  }, /worktree is not clean .* No command was started/i);
  await fs.unlink(path.join(workspace, 'dirty.txt'));

  const startedAt = Date.now();
  const started = await callTool(client, 'start_background_job', {
    job_key: 'smoke:survive-restart',
    command: `node -e "setTimeout(() => { console.log('durable-ok'); console.error('durable-err'); }, 1200)"`,
    timeout_ms: 10000,
    expected_git_head: gitHead,
    require_clean_worktree: true
  });
  if (Date.now() - startedAt > 4000 || started.structuredContent.job?.terminal) {
    throw new Error(`start_background_job did not return promptly with a live job: ${JSON.stringify(started.structuredContent.job)}`);
  }
  const durableJobId = started.structuredContent.job?.job_id;
  if (!/^job_[a-f0-9]{24}$/.test(durableJobId ?? '')) throw new Error(`invalid job id: ${durableJobId}`);

  await client.close();
  client = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1600));

  client = new McpStdioClient(workspace, jobDir);
  await client.initialize();
  const recovered = await callTool(client, 'wait_for_background_job', {
    job_id: durableJobId,
    wait_ms: 5000,
    tail_bytes: 10000
  });
  const recoveredJob = recovered.structuredContent.job;
  if (
    recoveredJob?.status !== 'succeeded' ||
    recoveredJob.exit_code !== 0 ||
    recoveredJob.git_guard?.expected_head !== gitHead ||
    recoveredJob.git_guard?.verified_head !== gitHead ||
    recoveredJob.git_guard?.verified_clean !== true ||
    !recoveredJob.git_guard?.verified_at ||
    !recoveredJob.stdout_tail.includes('durable-ok') ||
    !recoveredJob.stderr_tail.includes('durable-err')
  ) {
    throw new Error(`durable job did not survive server restart: ${JSON.stringify(recoveredJob)}`);
  }

  const httpPort = await getFreePort();
  const httpToken = 'background-job-smoke-token-0123456789abcdef';
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  httpRuntime = startHttpServer(workspace, jobDir, httpPort, httpToken);
  const health = await waitForHealth(`${baseUrl}/healthz`, httpToken);
  if (health.backgroundJobs !== 'durable-runner-v1') {
    throw new Error(`HTTP health did not advertise durable jobs: ${JSON.stringify(health)}`);
  }
  httpClient = new Client({ name: 'codexpro-background-job-http-smoke', version: '0.1.0' });
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${httpToken}` } }
  });
  await httpClient.connect(httpTransport);
  const httpStarted = await httpClient.callTool({
    name: 'start_background_job',
    arguments: {
      job_key: 'smoke:http-restart',
      command: `node -e "setTimeout(() => console.log('http-durable-ok'), 1200)"`,
      timeout_ms: 10000
    }
  });
  if (httpStarted.isError || !httpStarted.structuredContent?.job?.job_id) {
    throw new Error(`HTTP durable start failed: ${JSON.stringify(httpStarted)}`);
  }
  const staleSessionId = httpTransport.sessionId;
  if (!staleSessionId) throw new Error('HTTP durable start did not establish an MCP session id');
  await stopChild(httpRuntime.child);
  httpRuntime = undefined;
  await new Promise((resolve) => setTimeout(resolve, 1600));

  httpRuntime = startHttpServer(workspace, jobDir, httpPort, httpToken);
  await waitForHealth(`${baseUrl}/healthz`, httpToken);
  const recoveredHttpResponse = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${httpToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': staleSessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 91,
      method: 'tools/call',
      params: {
        name: 'wait_for_background_job',
        arguments: { job_key: 'smoke:http-restart', wait_ms: 5000, tail_bytes: 10000 }
      }
    })
  });
  const recoveredHttp = await recoveredHttpResponse.json();
  if (
    recoveredHttpResponse.status !== 200 ||
    recoveredHttp.result?.isError ||
    recoveredHttp.result?.structuredContent?.job?.status !== 'succeeded' ||
    !recoveredHttp.result?.structuredContent?.job?.stdout_tail?.includes('http-durable-ok')
  ) {
    throw new Error(`stale HTTP session did not recover the durable job: ${recoveredHttpResponse.status} ${JSON.stringify(recoveredHttp)}`);
  }
  await httpClient.close().catch(() => undefined);
  httpClient = undefined;
  await stopChild(httpRuntime.child);
  httpRuntime = undefined;

  const reused = await callTool(client, 'start_background_job', {
    job_key: 'smoke:survive-restart',
    command: `node -e "setTimeout(() => { console.log('durable-ok'); console.error('durable-err'); }, 1200)"`,
    timeout_ms: 10000,
    expected_git_head: gitHead,
    require_clean_worktree: true
  });
  if (reused.structuredContent.job?.job_id !== durableJobId || reused.structuredContent.job?.reused !== true) {
    throw new Error(`idempotent start did not reuse the existing job: ${JSON.stringify(reused.structuredContent.job)}`);
  }
  await expectToolError(client, 'start_background_job', {
    job_key: 'smoke:survive-restart',
    command: `node -e "setTimeout(() => { console.log('durable-ok'); console.error('durable-err'); }, 1200)"`,
    timeout_ms: 10000
  }, /already bound to a different command or execution contract/i);
  await expectToolError(client, 'start_background_job', {
    job_key: 'smoke:survive-restart',
    command: `node -e "console.log('different-command')"`,
    timeout_ms: 10000
  }, /already bound to a different command/i);

  const timeoutStarted = await callTool(client, 'start_background_job', {
    job_key: 'smoke:timeout',
    command: `node -e "setInterval(() => {}, 1000)"`,
    timeout_ms: 1000
  });
  const timedOut = await callTool(client, 'wait_for_background_job', {
    job_id: timeoutStarted.structuredContent.job.job_id,
    wait_ms: 8000
  });
  if (timedOut.structuredContent.job?.status !== 'timed_out' || !timedOut.structuredContent.job?.timed_out) {
    throw new Error(`background job timeout was not authoritative: ${JSON.stringify(timedOut.structuredContent.job)}`);
  }

  const cancelStarted = await callTool(client, 'start_background_job', {
    job_key: 'smoke:cancel',
    command: `node -e "setInterval(() => console.log('still-running'), 250)"`,
    timeout_ms: 10000
  });
  const canceled = await callTool(client, 'cancel_background_job', {
    job_id: cancelStarted.structuredContent.job.job_id,
    reason: 'smoke cancellation',
    wait_ms: 8000
  });
  if (canceled.structuredContent.job?.status !== 'canceled' || canceled.structuredContent.job?.child_alive) {
    throw new Error(`background job cancellation was not authoritative: ${JSON.stringify(canceled.structuredContent.job)}`);
  }

  const listed = await callTool(client, 'list_background_jobs', { limit: 10 });
  const listedIds = new Set(listed.structuredContent.jobs?.map((job) => job.job_id));
  for (const expectedId of [durableJobId, timeoutStarted.structuredContent.job.job_id, cancelStarted.structuredContent.job.job_id]) {
    if (!listedIds.has(expectedId)) throw new Error(`list_background_jobs omitted ${expectedId}`);
  }

  const workspaceFiles = await fs.readdir(workspace);
  if (workspaceFiles.some((name) => name.includes('job') && name !== 'README.md')) {
    throw new Error(`durable job state leaked into workspace: ${workspaceFiles.join(', ')}`);
  }

  const safeClient = new McpStdioClient(workspace, jobDir, 'safe');
  await safeClient.initialize();
  await expectToolError(safeClient, 'start_background_job', {
    job_key: 'smoke:safe-block',
    command: `node -e "console.log('not-allowlisted')"`
  }, /safe bash allowlist/i);
  await safeClient.close();

  const offClient = new McpStdioClient(workspace, jobDir, 'off');
  await offClient.initialize();
  const offTools = await offClient.request('tools/list', {});
  const offNames = new Set(offTools.tools.map((tool) => tool.name));
  if (offNames.has('start_background_job')) throw new Error('start_background_job remained visible with bash mode off');
  for (const expected of ['get_background_job', 'list_background_jobs', 'wait_for_background_job', 'cancel_background_job']) {
    if (!offNames.has(expected)) throw new Error(`${expected} was hidden with bash mode off`);
  }
  const offRead = await callTool(offClient, 'get_background_job', { job_id: durableJobId });
  if (offRead.structuredContent.job?.status !== 'succeeded') throw new Error('bash-off server could not inspect an existing job');
  await offClient.close();

  console.log('✓ background job smoke test passed');
} finally {
  await httpClient?.close().catch(() => undefined);
  if (httpRuntime) await stopChild(httpRuntime.child).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(jobDir, { recursive: true, force: true });
}
