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

function findPythonForPty() {
  if (process.platform === 'win32') return '';
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['-c', 'import pty, select, subprocess'], { stdio: 'ignore' });
    if (result.status === 0) return command;
  }
  return '';
}

function runInteractiveQuit(args, env) {
  const python = findPythonForPty();
  if (!python) return false;
  const payload = JSON.stringify({
    cmd: process.execPath,
    args: ['scripts/codexpro.mjs', 'start', ...args],
    cwd: path.resolve('.')
  });
  const code = `
import json, os, pty, select, subprocess, sys, time
payload = json.loads(sys.argv[1])
master, slave = pty.openpty()
proc = subprocess.Popen([payload["cmd"]] + payload["args"], cwd=payload["cwd"], env=os.environ.copy(), stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = bytearray()
sent = False
deadline = time.time() + 20
while time.time() < deadline:
    if proc.poll() is not None:
        break
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out.extend(chunk)
    if not sent and b"codexpro> " in out:
        os.write(master, b"q")
        sent = True
if proc.poll() is None:
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    sys.stderr.write(out.decode(errors="replace"))
    raise SystemExit(124)
while True:
    ready, _, _ = select.select([master], [], [], 0)
    if not ready:
        break
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out.extend(chunk)
os.close(master)
sys.stdout.write(out.decode(errors="replace"))
if not sent:
    sys.stderr.write("control prompt was not reached\\n")
    raise SystemExit(125)
raise SystemExit(proc.returncode or 0)
`;
  const result = spawnSync(python, ['-c', code, payload], {
    cwd: path.resolve('.'),
    env: { ...env, NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`interactive quit failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return true;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-root-'));
const reuseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-reuse-'));
const policyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-policy-'));
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-runtime-'));
const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-stale-'));
const ngrokRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-ngrok-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-home-'));
const env = { ...process.env, CODEXPRO_HOME: home };
function withoutProxyEnv(input) {
  const next = { ...input };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) delete next[key];
  return next;
}

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
  policyRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'https://codexpro-test.tailnet.ts.net/mcp'
], env);
const tailscalePolicyProfile = await readProfile(policyRoot, home);
if (tailscalePolicyProfile.tunnel !== 'tailscale' || tailscalePolicyProfile.hostname !== 'codexpro-test.tailnet.ts.net' || tailscalePolicyProfile.ngrokConfig) {
  throw new Error(`settings tailscale profile did not normalize/clear stale tunnel values: ${JSON.stringify(tailscalePolicyProfile)}`);
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

const quitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-quit-'));
const quitPort = await getFreePort();
const quitRuntimePath = await runtimeStatusPath(quitRoot, home);
if (runInteractiveQuit([
  '--root',
  quitRoot,
  '--tunnel',
  'none',
  '--port',
  String(quitPort),
  '--no-copy-url'
], env)) {
  try {
    await fs.access(quitRuntimePath);
    throw new Error('runtime status was not cleared after interactive q exit');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
], withoutProxyEnv(env), async () => {
  const runtime = await waitForJson(cloudflarePath, (data) => data.endpoint?.includes('trycloudflare.com'), 'cloudflare runtime status');
  if (runtime.endpoint.includes('api.trycloudflare.com') || !runtime.endpoint.startsWith('https://real-codexpro.trycloudflare.com/mcp')) {
    throw new Error(`quick tunnel saved the wrong endpoint: ${JSON.stringify(runtime)}`);
  }
});

const proxyCloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-proxy-'));
const proxyCloudflarePort = await getFreePort();
const proxyCloudflarePath = await runtimeStatusPath(proxyCloudflareRoot, home);
const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-fake-bin-'));
const fakeCurl = path.join(fakeBin, 'curl');
const curlArgsPath = path.join(home, 'fake-curl-args.json');
const cloudflaredArgsPath = path.join(home, 'fake-cloudflared-proxy-args.json');
const fakeProxyCloudflared = path.join(home, 'fake-cloudflared-proxy.mjs');
await fs.writeFile(fakeCurl, [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "fs.writeFileSync(process.env.CODEXPRO_FAKE_CURL_ARGS, JSON.stringify(process.argv.slice(2)));",
  "console.log(JSON.stringify({ success: true, result: { id: 'proxy-tunnel-id', hostname: 'proxy-codexpro.trycloudflare.com', account_tag: 'account-tag', secret: 'proxy-secret-1234567890' } }));",
  ''
].join('\n'), { mode: 0o700 });
await fs.writeFile(fakeProxyCloudflared, [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "const args = process.argv.slice(2);",
  "fs.writeFileSync(process.env.CODEXPRO_FAKE_CLOUDFLARED_ARGS, JSON.stringify(args));",
  "const credentialsPath = args[args.indexOf('--credentials-file') + 1];",
  "const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));",
  "if (credentials.TunnelID !== 'proxy-tunnel-id' || credentials.AccountTag !== 'account-tag' || credentials.TunnelSecret !== 'proxy-secret-1234567890') process.exit(4);",
  "setInterval(() => {}, 1000);",
  ''
].join('\n'), { mode: 0o700 });
await withStartedCodexPro([
  '--root',
  proxyCloudflareRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeProxyCloudflared,
  '--port',
  String(proxyCloudflarePort),
  '--token',
  'codexpro-cloudflare-proxy-token',
  '--no-copy-url'
], {
  ...env,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  CODEXPRO_FAKE_CURL_ARGS: curlArgsPath,
  CODEXPRO_FAKE_CLOUDFLARED_ARGS: cloudflaredArgsPath
}, async () => {
  const runtime = await waitForJson(proxyCloudflarePath, (data) => data.endpoint?.includes('proxy-codexpro.trycloudflare.com'), 'proxy cloudflare runtime status');
  if (!runtime.endpoint.startsWith('https://proxy-codexpro.trycloudflare.com/mcp')) {
    throw new Error(`proxy quick tunnel saved the wrong endpoint: ${JSON.stringify(runtime)}`);
  }
});
const curlArgs = JSON.parse(await fs.readFile(curlArgsPath, 'utf8'));
if (!curlArgs.includes('--proxy') || !curlArgs.includes('http://proxy.example.test:8080') || !curlArgs.includes('https://api.trycloudflare.com/tunnel')) {
  throw new Error(`proxy quick tunnel did not call curl through proxy: ${JSON.stringify(curlArgs)}`);
}
const cloudflaredArgs = JSON.parse(await fs.readFile(cloudflaredArgsPath, 'utf8'));
if (!cloudflaredArgs.includes('--credentials-file') || !cloudflaredArgs.includes('run') || !cloudflaredArgs.includes('proxy-tunnel-id')) {
  throw new Error(`proxy quick tunnel did not run cloudflared with credentials: ${JSON.stringify(cloudflaredArgs)}`);
}
const credentialsPath = cloudflaredArgs[cloudflaredArgs.indexOf('--credentials-file') + 1];
try {
  await fs.access(credentialsPath);
  throw new Error(`proxy quick tunnel credentials were not cleaned up: ${credentialsPath}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const proxyCloudflareFailRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-proxy-fail-'));
const proxyCloudflareFailPort = await getFreePort();
const fakeFailingProxyCloudflared = path.join(home, 'fake-cloudflared-proxy-fail.mjs');
await fs.writeFile(fakeFailingProxyCloudflared, [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "console.error('proxy tunnel startup failed');",
  'process.exit(7);',
  ''
].join('\n'), { mode: 0o700 });
const proxyFailure = runFail([
  'start',
  '--root',
  proxyCloudflareFailRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeFailingProxyCloudflared,
  '--port',
  String(proxyCloudflareFailPort),
  '--token',
  'codexpro-cloudflare-proxy-token',
  '--no-copy-url'
], {
  ...env,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  CODEXPRO_FAKE_CURL_ARGS: path.join(home, 'fake-curl-fail-args.json')
}, /exited before startup completed/);
if (!proxyFailure.includes('proxy tunnel startup failed')) {
  throw new Error(`proxy quick tunnel did not include cloudflared startup failure output\n${proxyFailure}`);
}

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

const fakeTailscale = path.join(home, 'fake-tailscale.mjs');
await fs.writeFile(fakeTailscale, [
  '#!/usr/bin/env node',
  "if (process.argv.includes('version')) { console.log('1.80.0'); process.exit(0); }",
  "console.error('TAILSCALE_ARGS=' + process.argv.slice(2).join('|'));",
  'process.exit(2);',
  ''
].join('\n'), { mode: 0o700 });
const tailscaleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-tailscale-'));
const tailscalePort = await getFreePort();
const tailscaleFailure = runFail([
  'start',
  '--root',
  tailscaleRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'codexpro-env.tailnet.ts.net',
  '--tailscale',
  fakeTailscale,
  '--port',
  String(tailscalePort),
  '--token',
  'codexpro-tailscale-token',
  '--no-copy-url'
], env, /Recent tailscale output/);
if (!tailscaleFailure.includes(`funnel|http://127.0.0.1:${tailscalePort}`)) {
  throw new Error(`tailscale start did not invoke Funnel against the local server\n${tailscaleFailure}`);
}
const tailscalePortRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-tailscale-port-'));
const tailscalePort8443 = await getFreePort();
const tailscalePortFailure = runFail([
  'start',
  '--root',
  tailscalePortRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'codexpro-env.tailnet.ts.net:8443',
  '--tailscale',
  fakeTailscale,
  '--port',
  String(tailscalePort8443),
  '--token',
  'codexpro-tailscale-token',
  '--no-copy-url'
], env, /Recent tailscale output/);
if (!tailscalePortFailure.includes(`funnel|--https=8443|http://127.0.0.1:${tailscalePort8443}`)) {
  throw new Error(`tailscale start did not map hostname port to Funnel HTTPS port\n${tailscalePortFailure}`);
}

const listed = run(['settings', 'list'], env);
if (!listed.includes(root) || !listed.includes('codexpro-test.ngrok-free.app') || !listed.includes('codexpro-test.tailnet.ts.net')) {
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
