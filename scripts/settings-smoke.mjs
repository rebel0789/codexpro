import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function run(args, env) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`codexpro ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function runFail(args, env, pattern) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    throw new Error(`codexpro ${args.join(' ')} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (pattern && !pattern.test(output)) {
    throw new Error(`codexpro ${args.join(' ')} failed for the wrong reason\n${output}`);
  }
  return output;
}

async function readProfile(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return JSON.parse(await fs.readFile(path.join(home, 'profiles', `${id}.json`), 'utf8'));
}

async function runtimeStatusPath(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return path.join(home, 'runtime', `${id}.json`);
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

async function waitForJson(filePath, predicate, label) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (predicate(data)) return data;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? 'predicate not met'}`);
}

async function withStartedCodexPro(args, env, fn) {
  const child = spawn(process.execPath, ['scripts/codexpro.mjs', 'start', ...args], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let closed = false;
  const closedPromise = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await fn();
  } catch (error) {
    throw new Error(`${error.message}\nstart output:\n${output}`);
  } finally {
    if (!closed) child.kill('SIGTERM');
    await closedPromise;
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-root-'));
const reuseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-reuse-'));
const policyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-policy-'));
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-runtime-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-home-'));
const env = { ...process.env, CODEXPRO_HOME: home };

const empty = run(['settings', 'show', '--root', root], env);
if (!empty.includes('No saved settings')) {
  throw new Error(`expected empty settings output, got:\n${empty}`);
}

const saved = run([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--port',
  '19087',
  '--mode',
  'agent',
  '--tool-mode',
  'full',
  '--bash-transcript',
  'full',
  '--widget-domain',
  'https://widgets.codexpro.test',
  '--tool-cards',
  'on',
  '--token',
  'codexpro-settings-token'
], env);
if (!saved.includes('Saved workspace settings')) {
  throw new Error(`expected settings save output, got:\n${saved}`);
}

const shown = run(['settings', 'show', '--root', root], env);
for (const expected of ['Tunnel', 'ngrok', 'codexpro-test.ngrok-free.app', '19087', 'Tool cards', 'on', 'Bash transcript', 'full', '<saved>']) {
  if (!shown.includes(expected)) {
    throw new Error(`settings show missing ${expected}\n${shown}`);
  }
}
if (shown.includes('codexpro-settings-token')) {
  throw new Error(`settings show leaked token\n${shown}`);
}
const profile = await readProfile(root, home);
if (profile.toolMode !== 'full' || profile.toolCards !== true || profile.bashTranscript !== 'full' || profile.widgetDomain !== 'https://widgets.codexpro.test') {
  throw new Error(`settings profile did not persist tool/widget options: ${JSON.stringify(profile)}`);
}

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro.example.com',
  '--cloudflare-token',
  'raw-cloudflare-token'
], env, /does not save raw --cloudflare-token/i);

run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'policy.ngrok-free.app',
  '--mode',
  'handoff',
  '--write',
  'workspace',
  '--ngrok-config',
  'ngrok.yml'
], env);
const policyProfile = await readProfile(policyRoot, home);
const realPolicyRoot = await fs.realpath(policyRoot);
if (policyProfile.write !== 'handoff' || policyProfile.ngrokConfig !== path.join(realPolicyRoot, 'ngrok.yml')) {
  throw new Error(`settings policy profile did not normalize write/path values: ${JSON.stringify(policyProfile)}`);
}

runFail([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--require-bash-session'
], env, /requires --bash-session/i);

const guarded = run([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--bash-session',
  'guarded-main',
  '--require-bash-session'
], env);
if (!guarded.includes('Bash session') || !guarded.includes('guarded-main required')) {
  throw new Error(`settings save did not display guarded bash session\n${guarded}`);
}
const guardedProfile = await readProfile(root, home);
if (guardedProfile.bashSession !== 'guarded-main' || guardedProfile.requireBashSession !== true) {
  throw new Error(`settings profile did not persist bash session guard: ${JSON.stringify(guardedProfile)}`);
}

const runtimePort = await getFreePort();
const runtimePath = await runtimeStatusPath(runtimeRoot, home);
run([
  'settings',
  'set',
  '--root',
  runtimeRoot,
  '--tunnel',
  'none',
  '--port',
  String(runtimePort),
  '--tool-cards',
  'on'
], env);
await withStartedCodexPro([
  '--root',
  runtimeRoot
], env, async () => {
  const runtime = await waitForJson(runtimePath, (data) => data.toolCards === true, 'tool-cards runtime status');
  if (runtime.toolCards !== true) {
    throw new Error(`runtime status did not persist toolCards: ${JSON.stringify(runtime)}`);
  }
});

const listed = run(['settings', 'list'], env);
if (!listed.includes(root) || !listed.includes('codexpro-test.ngrok-free.app')) {
  throw new Error(`settings list missing saved profile\n${listed}`);
}

const reused = run(['settings', 'use', '--root', reuseRoot, '--from-root', root], env);
if (!reused.includes('Saved workspace settings from')) {
  throw new Error(`settings use did not save profile\n${reused}`);
}

const reusedShown = run(['settings', 'show', '--root', reuseRoot], env);
for (const expected of ['ngrok', 'codexpro-test.ngrok-free.app', '<saved>']) {
  if (!reusedShown.includes(expected)) {
    throw new Error(`reused settings show missing ${expected}\n${reusedShown}`);
  }
}

const deleted = run(['settings', 'delete', '--root', root, '--yes'], env);
if (!deleted.includes('Deleted saved settings')) {
  throw new Error(`expected settings delete output, got:\n${deleted}`);
}

run(['settings', 'delete', '--root', reuseRoot, '--yes'], env);

const afterDelete = run(['settings', 'show', '--root', root], env);
if (!afterDelete.includes('No saved settings')) {
  throw new Error(`expected empty settings after delete, got:\n${afterDelete}`);
}

console.log('✓ settings smoke test passed');
