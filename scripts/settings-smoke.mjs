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
    await fn(child);
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
const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-stale-'));
const ngrokRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-ngrok-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-home-'));
const env = { ...process.env, CODEXPRO_HOME: home };

const empty = run(['settings', 'show', '--root', root], env);
if (!empty.includes('No saved settings')) {
  throw new Error(`expected empty settings output, got:\n${empty}`);
}
const emptyEquals = run([`settings`, `show`, `--root=${root}`], env);
if (!emptyEquals.includes('No saved settings')) {
  throw new Error(`expected --root= settings output, got:\n${emptyEquals}`);
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

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'http://policy.ngrok-free.app'
], env, /hostname must use https/i);

run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'https://policy.ngrok-free.app/mcp',
  '--mode',
  'handoff',
  '--write',
  'workspace',
  '--ngrok-config',
  'ngrok.yml'
], env);
const policyProfile = await readProfile(policyRoot, home);
const realPolicyRoot = await fs.realpath(policyRoot);
if (policyProfile.write !== 'handoff' || policyProfile.hostname !== 'policy.ngrok-free.app' || policyProfile.ngrokConfig !== path.join(realPolicyRoot, 'ngrok.yml')) {
  throw new Error(`settings policy profile did not normalize write/path values: ${JSON.stringify(policyProfile)}`);
}
run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none'
], env);
const localPolicyProfile = await readProfile(policyRoot, home);
if (localPolicyProfile.tunnel !== 'none' || localPolicyProfile.hostname || localPolicyProfile.ngrokConfig) {
  throw new Error(`settings local-only profile kept stale ngrok values: ${JSON.stringify(localPolicyProfile)}`);
}

run([
  'settings',
  'set',
  '--root',
  staleRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro-stale.example.com',
  '--tunnel-name',
  'stale-tunnel',
  '--cloudflare-config',
  'cloudflared.yml',
  '--cloudflare-token-file',
  'cloudflare-token'
], env);
run([
  'settings',
  'set',
  '--root',
  staleRoot,
  '--tunnel',
  'cloudflare'
], env);
const quickProfile = await readProfile(staleRoot, home);
if (quickProfile.tunnel !== 'cloudflare' || quickProfile.hostname || quickProfile.tunnelName || quickProfile.cloudflareConfig || quickProfile.cloudflareTokenFile) {
  throw new Error(`settings quick tunnel profile kept stale named-tunnel values: ${JSON.stringify(quickProfile)}`);
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

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--bash',
  'banana'
], env, /--bash must be off, safe, or full/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--tool-mode',
  'banana'
], env, /--tool-mode must be minimal, standard, or full/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--port',
  'abc'
], env, /Invalid port: abc/i);

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
], env, async (child) => {
  const runtime = await waitForJson(runtimePath, (data) => data.toolCards === true && data.pid === child.pid, 'tool-cards runtime status');
  if (runtime.toolCards !== true || runtime.pid !== child.pid) {
    throw new Error(`runtime status did not persist toolCards: ${JSON.stringify(runtime)}`);
  }
});
try {
  await fs.access(runtimePath);
  throw new Error('runtime status was not cleared after launcher SIGTERM');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const cloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-'));
const cloudflarePort = await getFreePort();
const cloudflarePath = await runtimeStatusPath(cloudflareRoot, home);
const fakeCloudflared = path.join(home, 'fake-cloudflared.mjs');
await fs.writeFile(fakeCloudflared, [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "console.error('https://api.trycloudflare.com/tunnel');",
  "setTimeout(() => console.error('https://real-codexpro.trycloudflare.com'), 100);",
  'setInterval(() => {}, 1000);',
  ''
].join('\n'), { mode: 0o700 });
await withStartedCodexPro([
  '--root',
  cloudflareRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeCloudflared,
  '--port',
  String(cloudflarePort),
  '--token',
  'codexpro-cloudflare-token',
  '--no-copy-url'
], env, async () => {
  const runtime = await waitForJson(cloudflarePath, (data) => data.endpoint?.includes('trycloudflare.com'), 'cloudflare runtime status');
  if (runtime.endpoint.includes('api.trycloudflare.com') || !runtime.endpoint.startsWith('https://real-codexpro.trycloudflare.com/mcp')) {
    throw new Error(`quick tunnel saved the wrong endpoint: ${JSON.stringify(runtime)}`);
	}
});

const namedCloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-named-'));
const namedCloudflarePort = await getFreePort();
const fakeNamedCloudflared = path.join(home, 'fake-cloudflared-named.mjs');
const cloudflareRawToken = 'cf_audit_secret_1234567890TOKEN';
await fs.writeFile(fakeNamedCloudflared, [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "console.error('fake tunnel saw TUNNEL_TOKEN=' + process.env.TUNNEL_TOKEN);",
  'process.exit(2);',
  ''
].join('\n'), { mode: 0o700 });
const namedFailure = runFail([
  'start',
  '--root',
  namedCloudflareRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro-audit.example.com',
  '--cloudflare-token',
  cloudflareRawToken,
  '--cloudflared',
  fakeNamedCloudflared,
  '--port',
  String(namedCloudflarePort),
  '--token',
  'codexpro-named-http-token',
  '--no-copy-url'
], env, /Recent cloudflared output/);
if (namedFailure.includes(cloudflareRawToken) || !namedFailure.includes('TUNNEL_TOKEN= [REDACTED_SECRET]')) {
  throw new Error(`named tunnel failure leaked or failed to redact Cloudflare token\n${namedFailure}`);
}

const fakeNgrok = path.join(home, 'fake-ngrok.mjs');
await fs.writeFile(fakeNgrok, [
  '#!/usr/bin/env node',
  "if (process.argv.includes('version')) { console.log('ngrok version 3.0.0'); process.exit(0); }",
  "console.error('NGROK_ARGS=' + process.argv.slice(2).join('|'));",
  'process.exit(2);',
  ''
].join('\n'), { mode: 0o700 });
run([
  'settings',
  'set',
  '--root',
  ngrokRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-env.ngrok-free.app',
  '--ngrok-config',
  'old-ngrok.yml'
], env);
const ngrokPort = await getFreePort();
const ngrokFailure = runFail([
  'start',
  '--root',
  ngrokRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-env.ngrok-free.app',
  '--ngrok',
  fakeNgrok,
  '--port',
  String(ngrokPort),
  '--token',
  'codexpro-ngrok-env-token',
  '--no-copy-url'
], { ...env, NGROK_CONFIG: 'new-ngrok.yml' }, /Recent ngrok output/);
const realNgrokRoot = await fs.realpath(ngrokRoot);
if (!ngrokFailure.includes(`--config|${path.join(realNgrokRoot, 'new-ngrok.yml')}`) || ngrokFailure.includes('old-ngrok.yml')) {
  throw new Error(`ngrok start did not let env config override saved profile\n${ngrokFailure}`);
}

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
