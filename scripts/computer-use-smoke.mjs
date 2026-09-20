import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => port ? resolve(port) : reject(new Error('no free port')));
    });
    server.on('error', reject);
  });
}

async function withServer(mode, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-computer-smoke-'));
  const port = await freePort();
  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_COMPUTER_USE: mode,
      CODEXPRO_COMPUTER_USE_APPS: 'com.microsoft.Word'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timeout\n${stderr}`)), 15000);
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', code => reject(new Error(`server exited ${code}\n${stderr}`)));
  });
  try {
    await listening;
    const client = new Client({ name: 'computer-use-smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try { await fn(client); } finally { await client.close(); }
  } finally {
    child.kill('SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) throw new Error(`codexpro ${args.join(' ')} failed\n${output}`);
  return output;
}

function runCliExpectFailure(args, env) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) throw new Error(`codexpro ${args.join(' ')} unexpectedly passed\n${output}`);
  return output;
}

function waitForLauncherReady(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`launcher timeout\n${output}`)), 15000);
    timer.unref();
    const onData = (chunk) => {
      output += String(chunk);
      if (output.includes('CODEXPRO_READY ')) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`launcher exited before ready: code=${code} signal=${signal}\n${output}`));
    });
  });
}

async function withCliServer({ root, home, port, args = [] }, fn) {
  const child = spawn(process.execPath, [
    'scripts/codexpro.mjs',
    'start',
    '--root',
    root,
    '--port',
    String(port),
    '--tunnel',
    'none',
    '--headless',
    '--no-auth',
    ...args
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let closed = false;
  const closedPromise = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  try {
    await waitForLauncherReady(child);
    const client = new Client({ name: 'computer-use-cli-smoke', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  } finally {
    if (!closed) child.kill('SIGTERM');
    await closedPromise;
  }
}

function assertToolSurface(names, mode) {
  const readPresent = mode !== 'off';
  const interactPresent = mode === 'interact';
  for (const name of readTools) {
    if (names.includes(name) !== readPresent) throw new Error(`${mode} unexpected ${name} surface`);
  }
  for (const name of writeTools) {
    if (names.includes(name) !== interactPresent) throw new Error(`${mode} unexpected ${name} surface`);
  }
}

const readTools = ['computer_list_apps', 'computer_get_state', 'computer_screenshot'];
const writeTools = ['computer_click', 'computer_press_key'];

const help = runCli(['--help'], { ...process.env });
for (const expected of ['--computer-use <off|observe|interact>', '--computer-use-apps <bundle-id,...>']) {
  if (!help.includes(expected)) throw new Error(`CLI help missing ${expected}`);
}

await withServer('off', async client => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assertToolSurface(names, 'off');
});

await withServer('observe', async client => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assertToolSurface(names, 'observe');
  const config = await client.callTool({ name: 'server_config', arguments: {} });
  const state = config.structuredContent?.computerUse;
  if (state?.mode !== 'observe' || state.allowlist_configured !== true || state.minimum_macos !== '14.0') {
    throw new Error('server_config missing observe computerUse state');
  }
  if (process.platform === 'darwin') {
    const denied = await client.callTool({ name: 'computer_get_state', arguments: { app_id: 'com.apple.finder' } });
    const text = denied.content?.find?.((part) => part.type === 'text')?.text ?? '';
    if (!denied.isError || !text.includes('computer_use_app_not_allowed')) throw new Error('allowlist rejection was not enforced');
  }
});

await withServer('interact', async client => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assertToolSurface(names, 'interact');
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-computer-cli-root-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-computer-cli-home-'));
const port = await freePort();
const settingsOutput = runCli([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'none',
  '--port',
  String(port),
  '--mode',
  'agent',
  '--tool-mode',
  'full',
  '--computer-use',
  'interact',
  '--computer-use-apps',
  'com.microsoft.Word,com.apple.TextEdit'
], { ...process.env, CODEXPRO_HOME: home });
if (!settingsOutput.includes('Saved workspace settings')) throw new Error('settings did not save Computer Use profile');
const profileId = createHash('sha256').update(await fs.realpath(root)).digest('hex').slice(0, 24);
const profile = JSON.parse(await fs.readFile(path.join(home, 'profiles', `${profileId}.json`), 'utf8'));
if (profile.computerUse !== 'interact' || JSON.stringify(profile.computerUseApps) !== JSON.stringify(['com.microsoft.Word', 'com.apple.TextEdit'])) {
  throw new Error(`saved Computer Use profile mismatch: ${JSON.stringify({ computerUse: profile.computerUse, computerUseApps: profile.computerUseApps })}`);
}

const incompatibleSettings = runCliExpectFailure([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'none',
  '--tool-mode',
  'standard',
  '--computer-use',
  'observe',
  '--computer-use-apps',
  'com.microsoft.Word'
], { ...process.env, CODEXPRO_HOME: home });
if (!incompatibleSettings.includes('requires --tool-mode full')) throw new Error('settings accepted Computer Use without full tool mode');

const incompatibleStart = runCliExpectFailure([
  'start',
  '--root',
  root,
  '--port',
  String(await freePort()),
  '--tunnel',
  'none',
  '--headless',
  '--no-auth',
  '--tool-mode',
  'standard',
  '--computer-use',
  'observe',
  '--computer-use-apps',
  'com.microsoft.Word'
], { ...process.env, CODEXPRO_HOME: home });
if (!incompatibleStart.includes('requires --tool-mode full')) throw new Error('start accepted Computer Use without full tool mode');

await withCliServer({ root, home, port }, async client => {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assertToolSurface(names, 'interact');
  const config = await client.callTool({ name: 'server_config', arguments: {} });
  const state = config.structuredContent?.computerUse;
  if (state?.mode !== 'interact' || JSON.stringify(state.allowed_apps) !== JSON.stringify(profile.computerUseApps)) {
    throw new Error(`CLI profile did not reach server: ${JSON.stringify(state)}`);
  }
});

const doctorPort = await freePort();
const doctorArgs = [
  'doctor',
  '--root',
  root,
  '--port',
  String(doctorPort),
  '--tunnel',
  'none',
  '--tool-mode',
  'full',
  ...(process.platform === 'darwin' ? ['--computer-use', 'observe', '--computer-use-apps', 'com.microsoft.Word'] : [])
];
const doctor = runCli(doctorArgs, { ...process.env, CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-computer-doctor-home-')) });
for (const expected of ['Computer Use', process.platform === 'darwin' ? 'observe' : 'computer_use=off']) {
  if (!doctor.includes(expected)) throw new Error(`doctor output missing ${expected}\n${doctor}`);
}

console.log('computer-use smoke passed');
