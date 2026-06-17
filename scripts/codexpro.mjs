#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log(`CodexPro easy launcher

Usage:
  npm install -g codexpro
  codexpro setup
  codexpro start
  codexpro start --root /path/to/repo
  codexpro settings
  codexpro doctor
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro --root /path/to/repo
  codexpro ngrok --hostname your-domain.ngrok-free.dev
  codexpro stable --hostname codexpro.example.com --tunnel-name codexpro
  codexpro pro-bundle --root /path/to/repo --copy
  codexpro pro-apply --root /path/to/repo --file plan.md
  codexpro install-cloudflared
  npm run connect -- --root /path/to/repo
  node scripts/codexpro.mjs --root /path/to/repo --tunnel cloudflare

Options:
  --root <dir>              Workspace root. Default: current directory.
  --from-root <dir>         Copy saved settings from another workspace with settings use.
  --allow-root <dir>        Additional allowed root. Can be repeated.
  --allow-home              Allow opening any workspace under your home directory.
  --mode <agent|handoff|pro>
                             Default: agent.
                             agent = ChatGPT can read, write/edit files, search, and run safe bash.
                             handoff = ChatGPT writes .ai-bridge plans for a local implementation agent.
                             pro = export context for models that cannot call MCP tools.
  --agent                   Shortcut for --mode agent.
  --handoff                 Shortcut for --mode handoff.
  --pro-planning            Shortcut for --mode pro.
  --host <host>             Local bind host. Default: 127.0.0.1.
  --port <port>             Local port. Default: 8787.
  --bash <off|safe|full>    Bash mode. Default: safe.
  --write <off|handoff|workspace>
                             Write mode. Default: workspace in agent mode, handoff otherwise.
                             handoff = ChatGPT can write .ai-bridge only; Codex edits source.
  --tunnel <none|cloudflare|cloudflare-named|ngrok>
                             Expose local MCP. Default: cloudflare.
                             cloudflare = quick tunnel with a new URL each restart.
                             cloudflare-named = stable hostname using a named tunnel.
                             ngrok = stable ngrok dev-domain endpoint using --hostname/--url.
  --stable                  Shortcut for --tunnel cloudflare-named.
  --hostname <host>          Stable public hostname for cloudflare-named or ngrok.
  --url <url>                Alias for --hostname in ngrok/stable URL modes.
  --tunnel-name <name>       Existing Cloudflare named tunnel to run.
  --cloudflare-token <token> Cloudflare Tunnel token for a remotely managed tunnel.
  --cloudflare-token-file <path>
                             File containing a Cloudflare Tunnel token.
  --cloudflare-config <path> cloudflared YAML config for a named tunnel.
  --token <token>           Bearer token for HTTP MCP. Auto-generated for tunnels.
  --cloudflared <path>      cloudflared executable. Default: PATH, then ~/.codexpro/bin.
  --ngrok <path>            ngrok executable. Default: PATH.
  --ngrok-config <path>     Optional ngrok config file path.
  --no-profile              Do not load a saved ~/.codexpro workspace profile.
  --save-config             Save setup choices for this workspace when using setup.
  --no-save-config          Do not save setup choices when using setup.
  --yes                     Confirm settings delete/reset without prompting.
  --install-cloudflared     Install/reinstall cloudflared into ~/.codexpro/bin.
  --no-install-cloudflared  Do not auto-install cloudflared when missing.
  --copy-url                Copy the ChatGPT Server URL to clipboard. Default for public HTTPS URLs.
  --no-copy-url             Do not copy the Server URL.
  --open-chatgpt            Open ChatGPT connector settings after the URL is ready.
  --no-auth                 Disable bearer-token auth. Only allowed with --tunnel none.
  --log-requests            Print redacted HTTP request and tool-call logs from the local MCP server.
  --print-env               Print the environment used to launch the server.
  --help                    Show this message.

Execute handoff options:
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro execute-handoff --agent pi --model provider/model
  codexpro execute-handoff --agent custom --command "my-agent --task-file {{plan_file}}"
  --agent <opencode|pi|codex|custom>
                             Local implementation agent adapter.
  --model <provider/model>  Optional model name passed to the adapter.
  --command <template>      Custom command template. Supports {{model}}, {{plan_file}}, {{plan_text}}, {{root}}.
  --dry-run                 Print the command that would run without executing it.
  --timeout-ms <ms>         Execution timeout. Default: 600000.
  --max-output-bytes <n>    Max stdout/stderr excerpt bytes per stream. Default: 120000.
  --context-dir <dir>       Handoff directory. Default: .ai-bridge.
  --yes                     Run without interactive confirmation.

Default agent mode:
  codexpro start --root /path/to/repo

Guided setup:
  codexpro setup

Workspace settings:
  codexpro settings
  codexpro settings show
  codexpro settings list
  codexpro settings set --tunnel ngrok --hostname your-domain.ngrok-free.dev
  codexpro settings use
  codexpro settings delete --yes

Preflight diagnostics:
  codexpro doctor

Ngrok stable URL mode:
  codexpro ngrok --root /path/to/repo --hostname your-domain.ngrok-free.dev

Planning-only handoff mode:
  codexpro start --root /path/to/repo --mode handoff

Execute a local handoff after ChatGPT writes .ai-bridge/current-plan.md:
  codexpro execute-handoff --agent opencode --model provider/model
  codexpro execute-handoff --agent pi --model provider/model
  codexpro execute-handoff --agent custom --command "node ./agent.js --task-file {{plan_file}}" --yes

Stable URL mode after one-time Cloudflare tunnel setup:
  codexpro stable --root /path/to/repo --hostname codexpro.example.com --tunnel-name codexpro
`);
}

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function paint(style, text) {
  if (!colorEnabled) return text;
  return `${ansi[style] ?? ''}${text}${ansi.reset}`;
}

function termWidth(max = 78) {
  return Math.max(56, Math.min(max, process.stdout.columns || max));
}

function divider(label = '') {
  const width = termWidth();
  if (!label) return paint('dim', '-'.repeat(width));
  const text = ` ${label} `;
  return paint('dim', `${text}${'-'.repeat(Math.max(0, width - text.length))}`);
}

function printBox(title, lines) {
  const width = termWidth();
  const inner = width - 4;
  console.log(divider(title));
  for (const line of lines) {
    const chunks = wrapLine(line, inner);
    for (const chunk of chunks) console.log(`| ${chunk.padEnd(inner)} |`);
  }
  console.log(divider());
}

function wrapLine(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function labelValue(label, value) {
  return `${label.padEnd(12)} ${value}`;
}

function statusLine(status, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('cyan', '..');
  console.log(`${marker} ${detail}`);
}

function profileSummary(profile) {
  if (!profile?.tunnel) return '';
  if (profile.tunnel === 'ngrok' && profile.hostname) return `Saved ngrok URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare-named' && profile.hostname) return `Saved Cloudflare URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
  if (profile.tunnel === 'none') return 'Saved local-only setup';
  return '';
}

function profileOneLine(profile, index = 0) {
  const prefix = index ? `${index}. ` : '';
  const tunnel = profile.tunnel ?? 'cloudflare';
  const host = profile.hostname ? ` -> ${profile.hostname}` : '';
  const port = profile.port ? ` :${profile.port}` : '';
  return `${prefix}${profile.root}  ${tunnel}${host}${port}`;
}

function printSavedProfileHint(profile) {
  const summary = profileSummary(profile);
  if (!summary) return;
  printBox('Saved setup found', [
    summary,
    'From this folder, future launches only need: codexpro start',
    'Use codexpro setup when you want to change the port, mode, tunnel, hostname, or token.'
  ]);
}

function parseArgs(argv) {
  const out = { allowRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (key === 'help') out.help = true;
    else if (key === 'allow-home') out.allowHome = true;
    else if (key === 'no-auth') out.noAuth = true;
    else if (key === 'copy-url') out.copyUrl = true;
    else if (key === 'no-copy-url') out.noCopyUrl = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'open-chatgpt') out.openChatgpt = true;
    else if (key === 'no-profile') out.noProfile = true;
    else if (key === 'save-config') out.saveConfig = true;
    else if (key === 'no-save-config') out.noSaveConfig = true;
    else if (key === 'yes' || key === 'force') out.yes = true;
    else if (key === 'stable') out.tunnel = 'cloudflare-named';
    else if (key === 'install-cloudflared') out.installCloudflared = true;
    else if (key === 'no-install-cloudflared') out.noInstallCloudflared = true;
    else if (key === 'agent') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.agent = next;
        i += 1;
      } else {
        out.mode = 'agent';
      }
    }
    else if (key === 'handoff') out.mode = 'handoff';
    else if (key === 'pro-planning' || key === 'pro') out.mode = 'pro';
    else if (key === 'log-requests') out.logRequests = true;
    else if (key === 'print-env') out.printEnv = true;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      i += 1;
      if (key === 'allow-root') out.allowRoots.push(next);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
    }
  }
  return out;
}

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function isPathLike(command) {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

function resolveExecutablePath(command) {
  const expanded = expandHome(command);
  return path.resolve(expanded);
}

function executableFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  if (isPathLike(command)) return executableFileExists(resolveExecutablePath(command));
  return commandExists(command);
}

function commandAvailableFromRoot(command, root) {
  if (!isPathLike(command)) return commandExists(command);
  const expanded = expandHome(command);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return executableFileExists(resolved);
}

function codexProHome() {
  const customHome = process.env.CODEXPRO_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), '.codexpro');
}

function profileDir() {
  return path.join(codexProHome(), 'profiles');
}

function profileIdForRoot(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function loadWorkspaceProfile(root) {
  const profilePath = profilePathForRoot(root);
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  if (profile.root && profile.root !== root) return {};
  return { ...profile, profilePath };
}

function listWorkspaceProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const profilePath = path.join(dir, name);
      const profile = readJsonFile(profilePath);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.root) return null;
      return { ...profile, profilePath };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function deleteWorkspaceProfile(root) {
  const filePath = profilePathForRoot(root);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function saveWorkspaceProfile(root, profile) {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...profile
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

function sanitizedProfile(profile) {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: '<saved>' } : {}),
    ...(cloudflareToken ? { cloudflareToken: '<saved>' } : {})
  };
}

function reusableProfilePayload(profile, overrides = {}) {
  const {
    version,
    root,
    updatedAt,
    profilePath,
    ...rest
  } = profile || {};
  return {
    ...rest,
    ...overrides
  };
}

function optionValue(args, profile, field, envNames = [], fallback = undefined) {
  if (args[field] !== undefined) return args[field];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return profile[field];
  return fallback;
}

function stableToken(existing = '') {
  return existing || randomBytes(24).toString('hex');
}

function cloudflaredBinName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function localCloudflaredPath() {
  return path.join(codexProHome(), 'bin', cloudflaredBinName());
}

function cloudflaredReleaseAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: 'cloudflared-darwin-arm64.tgz', archive: true };
    if (arch === 'x64') return { file: 'cloudflared-darwin-amd64.tgz', archive: true };
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return { file: 'cloudflared-linux-arm64', archive: false };
    if (arch === 'arm') return { file: 'cloudflared-linux-arm', archive: false };
    if (arch === 'x64') return { file: 'cloudflared-linux-amd64', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-linux-386', archive: false };
  }

  if (platform === 'win32') {
    if (arch === 'x64') return { file: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-windows-386.exe', archive: false };
  }

  throw new Error(`Automatic cloudflared install is not supported on ${platform}/${arch}. Install cloudflared manually or pass --cloudflared <path>.`);
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'codexpro-launcher' }
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer, { mode: 0o755 });
}

function verifyCloudflared(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
  }
}

async function installCloudflaredLocal() {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = path.dirname(installPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codexpro-cloudflared-'));
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  console.error(`[codexpro] Installing cloudflared locally: ${installPath}`);
  console.error(`[codexpro] Downloading official Cloudflare release: ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = path.join(tmpRoot, asset.file);
      const extractDir = path.join(tmpRoot, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath);
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
      }
      const extracted = findFileByName(extractDir, 'cloudflared');
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      fs.copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary);
      fs.copyFileSync(tmpBinary, installPath);
    }

    if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
    verifyCloudflared(installPath);
    console.error('[codexpro] cloudflared installed successfully.');
    return installPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveCloudflared(args) {
  const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyCloudflared(resolved);
      return resolved;
    }
    throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
  }

  if (!args.installCloudflared && commandExists('cloudflared')) {
    try {
      verifyCloudflared('cloudflared');
      return 'cloudflared';
    } catch (error) {
      console.error(`[codexpro] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const localPath = localCloudflaredPath();
  if (!args.installCloudflared && executableFileExists(localPath)) {
    try {
      verifyCloudflared(localPath);
      return localPath;
    } catch (error) {
      if (args.noInstallCloudflared) return localPath;
      console.error(`[codexpro] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.noInstallCloudflared) return '';
  return installCloudflaredLocal();
}

function verifyNgrok(binaryPath) {
  const result = spawnSync(binaryPath, ['version'], {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`ngrok was found, but ${binaryPath} version failed. Run ngrok version to inspect it.`);
  }
}

function resolveNgrok(args) {
  const explicit = args.ngrok ?? process.env.NGROK_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyNgrok(resolved);
      return resolved;
    }
    throw new Error(`ngrok was not found at ${explicit}. Install ngrok, add it to PATH, or pass --ngrok <path>.`);
  }

  if (commandExists('ngrok')) {
    verifyNgrok('ngrok');
    return 'ngrok';
  }

  throw new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.');
}

function ngrokConfigPath(args) {
  const configPath = args.ngrokConfig ?? process.env.NGROK_CONFIG ?? process.env.CODEXPRO_NGROK_CONFIG ?? '';
  return configPath ? path.resolve(expandHome(configPath)) : '';
}

function runHelperScript(scriptName, args) {
  const scriptPath = path.join(projectRoot, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.json();
      lastError = `${res.status} ${await res.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function portInUseHelp(host, port) {
  return [
    `Local port ${port} is already in use on ${host}.`,
    '',
    'If you want two repositories running at the same time, each one needs its own local port.',
    '',
    'Example:',
    '  repo A: codexpro setup  -> port 8787 -> hostname A',
    '  repo B: codexpro setup  -> port 8788 -> hostname B',
    '',
    'For quick tunnels you can also start the second repo with:',
    '  codexpro start --port 8788',
    '',
    'Stable ngrok or Cloudflare hostnames also cannot be shared by two running repositories at once.'
  ].join('\n');
}

async function assertPortAvailable(host, port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(portInUseHelp(host, port)));
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(numericPort, host);
  });
}

const spawnedChildren = new Set();

function spawnLogged(name, command, args, options = {}) {
  const { verbose = false, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  const logLines = [];
  const record = (stream, chunk) => {
    const text = String(chunk);
    logLines.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    while (logLines.length > 120) logLines.shift();
    if (verbose) stream.write(`[${name}] ${text}`);
  };
  child.codexproLogTail = () => logLines.join('\n');
  spawnedChildren.add(child);
  child.stdout.on('data', (chunk) => record(process.stdout, chunk));
  child.stderr.on('data', (chunk) => record(process.stderr, chunk));
  child.on('exit', (code, signal) => {
    spawnedChildren.delete(child);
    if (verbose) console.error(`[${name}] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForCloudflareUrl(child, timeoutMs = 45000) {
  const re = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
    timer.unref();
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(re);
      if (match?.[0]) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
    });
  });
}

function killProcess(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function cleanupChildren() {
  for (const child of spawnedChildren) killProcess(child);
}

function endpointWithToken(endpoint, token) {
  if (!token) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set('codexpro_token', token);
  return url.toString();
}

function publicBaseFromHostname(hostname) {
  const raw = hostname.includes('://') ? hostname : `https://${hostname}`;
  const url = new URL(raw);
  if (url.pathname === '/mcp' || url.pathname.endsWith('/mcp')) {
    url.pathname = url.pathname.slice(0, -4) || '/';
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function readTokenFile(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  return fs.readFileSync(resolved, 'utf8').trim();
}

function normalizeMode(args) {
  const mode = args.mode ?? process.env.CODEXPRO_MODE ?? 'agent';
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }
  return mode;
}

function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'darwin') attempts.push(['pbcopy', []]);
  else if (process.platform === 'win32') attempts.push(['cmd', ['/c', 'clip']]);
  else {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  for (const [command, args] of attempts) {
    const exists = command === 'cmd' || commandExists(command);
    if (!exists) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false
    });
    if (result.status === 0) return { ok: true, command };
  }
  return { ok: false, command: '' };
}

function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const [bin, args] = command;
  if (bin !== 'cmd' && !commandExists(bin)) return false;
  const result = spawnSync(bin, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPublicHealth(publicBase, token, tunnelChild, tunnelLabel = 'tunnel') {
  const health = waitForHealth(`${publicBase}/healthz`, token, 60000);
  const exit = waitForProcessExit(tunnelChild).then(({ code, signal }) => {
    throw new Error(`${tunnelLabel} exited before ${publicBase}/healthz was reachable, code=${code} signal=${signal}`);
  });
  return Promise.race([health, exit]);
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function contextDirFromArgs(args) {
  return args.contextDir ?? process.env.CODEXPRO_CONTEXT_DIR ?? '.ai-bridge';
}

function resolveWorkspaceFile(root, relativePath) {
  const absPath = path.resolve(root, relativePath);
  if (!isSubpath(absPath, root)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }
  return absPath;
}

function readTextFileBounded(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
  const sample = fs.readFileSync(filePath, { encoding: null });
  if (sample.includes(0)) throw new Error(`Refusing to read binary file: ${filePath}`);
  return sample.toString('utf8');
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}

function redactForLog(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`|[A-Za-z0-9_./+=-]{20,})/gi, (match) => {
      const index = match.indexOf('=');
      return index < 0 ? '[REDACTED_SECRET]' : `${match.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
    });
}

function trimBytes(value, maxBytes) {
  const redacted = redactForLog(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: redacted, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[output truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}

function splitCommandTemplate(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next && (next === quote || next === '\\' || (!quote && /\s|["']/.test(next)))) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error('Custom command has an unterminated quote.');
  if (current) tokens.push(current);
  return tokens;
}

function applyCommandTemplate(value, replacements) {
  return String(value).replace(/\{\{\s*(model|plan_file|plan_text|root)\s*\}\}/g, (_, key) => replacements[key] ?? '');
}

function buildExecutorCommand(args, root, planPath, planText) {
  const agent = String(args.agent ?? 'opencode').trim().toLowerCase();
  const model = String(args.model ?? process.env.CODEXPRO_AGENT_MODEL ?? '').trim();
  const replacements = {
    model,
    plan_file: planPath,
    plan_text: planText,
    root
  };

  if (args.command) {
    const template = String(args.command);
    if (!/\{\{\s*(plan_file|plan_text)\s*\}\}/.test(template)) {
      throw new Error('Custom --command must include {{plan_file}} or {{plan_text}} so the agent receives the handoff.');
    }
    const parts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, replacements));
    const displayParts = splitCommandTemplate(template).map((part) => applyCommandTemplate(part, { ...replacements, plan_text: '<plan_text>' }));
    if (!parts.length) throw new Error('Custom --command is empty.');
    return { agent, model, command: parts[0], args: parts.slice(1), displayArgs: displayParts.slice(1), custom: true };
  }

  if (agent === 'opencode') {
    return {
      agent,
      model,
      command: 'opencode',
      args: ['run', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['run', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'pi') {
    return {
      agent,
      model,
      command: 'pi',
      args: [...(model ? ['--model', model] : []), '-p', planText],
      displayArgs: [...(model ? ['--model', model] : []), '-p', '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'codex') {
    return {
      agent,
      model,
      command: 'codex',
      args: ['exec', ...(model ? ['--model', model] : []), planText],
      displayArgs: ['exec', ...(model ? ['--model', model] : []), '<plan_text>'],
      custom: false
    };
  }
  if (agent === 'custom') {
    throw new Error('Custom agent execution requires --command.');
  }
  throw new Error(`Unsupported --agent ${agent}. Use opencode, pi, codex, or custom with --command.`);
}

function executorCommandPreview(commandInfo) {
  return shellCommandPreview([commandInfo.command, ...(commandInfo.displayArgs ?? commandInfo.args)]);
}

function runProcessCaptured(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1500).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > maxOutputBytes * 2) child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        signal: null,
        durationMs: Date.now() - started,
        timedOut,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        spawnError: true
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const out = trimBytes(stdout, maxOutputBytes);
      const err = trimBytes(`${stderr}${timedOut ? `\n[codexpro] Command timed out after ${timeoutMs} ms.` : ''}`, maxOutputBytes);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        spawnError: false
      });
    });
  });
}

function readGitDiff(root, maxBytes) {
  const result = spawnSync('git', ['diff', '--no-ext-diff', '--'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: Math.max(maxBytes * 2, 1_000_000),
    shell: false
  });
  if (result.status !== 0) {
    const reason = result.stderr || result.stdout || `git diff exited ${result.status}`;
    return `# git diff unavailable\n\n${redactForLog(reason).trim()}\n`;
  }
  const diff = result.stdout || '';
  if (!diff.trim()) return '';
  return trimBytes(diff, maxBytes).text;
}

function codeBlock(label, value) {
  return `## ${label}\n\n\`\`\`text\n${String(value || '').replace(/```/g, '`\\`\\`') || '(empty)'}\n\`\`\`\n`;
}

function writeExecutionOutputs(root, contextDir, commandInfo, result, diffText) {
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const statusPath = path.join(bridgeDir, 'agent-status.md');
  const diffPath = path.join(bridgeDir, 'implementation-diff.patch');
  const logPath = path.join(bridgeDir, 'execution-log.jsonl');
  const commandText = executorCommandPreview(commandInfo);
  const status = [
    '# Agent Execution Status',
    '',
    `Updated: ${new Date().toISOString()}`,
    `Agent: ${commandInfo.agent}`,
    commandInfo.model ? `Model: ${commandInfo.model}` : '',
    `Command: ${commandText}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.signal ? `Signal: ${result.signal}` : '',
    `Timed out: ${result.timedOut ? 'yes' : 'no'}`,
    `Duration: ${result.durationMs} ms`,
    `Diff path: ${path.posix.join(contextDir, 'implementation-diff.patch')}`,
    `Execution log: ${path.posix.join(contextDir, 'execution-log.jsonl')}`,
    '',
    codeBlock('Stdout excerpt', result.stdout),
    codeBlock('Stderr excerpt', result.stderr)
  ].filter(Boolean).join('\n');
  fs.writeFileSync(statusPath, status, { mode: 0o600 });
  fs.writeFileSync(diffPath, diffText || '', { mode: 0o600 });
  const logEvent = {
    ts: new Date().toISOString(),
    event: 'execute_handoff',
    agent: commandInfo.agent,
    model: commandInfo.model || undefined,
    command: commandText,
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout_excerpt: result.stdout,
    stderr_excerpt: result.stderr,
    diff_path: path.posix.join(contextDir, 'implementation-diff.patch'),
    status_path: path.posix.join(contextDir, 'agent-status.md')
  };
  fs.appendFileSync(logPath, `${JSON.stringify(logEvent)}\n`, { mode: 0o600 });
  return { statusPath, diffPath, logPath };
}

async function confirmLocalExecution(args, root, commandInfo) {
  if (args.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Use --yes to execute a local handoff in non-interactive shells, or use --dry-run to preview.');
  }
  printBox('Confirm local execution', [
    labelValue('Workspace', root),
    labelValue('Agent', commandInfo.agent),
    ...(commandInfo.model ? [labelValue('Model', commandInfo.model)] : []),
    labelValue('Command', executorCommandPreview(commandInfo)),
    'This runs a local process in the workspace. CodexPro will collect status, logs, and git diff into .ai-bridge.'
  ]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, 'Run this local agent now?', 'no');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function runExecuteHandoff(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const contextDir = contextDirFromArgs(args);
  const bridgeDir = resolveWorkspaceFile(root, contextDir);
  const planPath = path.join(bridgeDir, 'current-plan.md');
  const maxReadBytes = numberOption(process.env.CODEXPRO_MAX_READ_BYTES, 180_000, 4_000, 2_000_000);
  const maxOutputBytes = numberOption(args.maxOutputBytes ?? process.env.CODEXPRO_MAX_OUTPUT_BYTES, 120_000, 4_000, 2_000_000);
  const timeoutMs = numberOption(args.timeoutMs ?? args.timeout, 600_000, 1_000, 24 * 60 * 60_000);
  if (!fs.existsSync(planPath)) {
    throw new Error(`No handoff plan found at ${path.relative(root, planPath)}. Ask ChatGPT to call handoff_to_agent first.`);
  }
  const planText = readTextFileBounded(planPath, maxReadBytes);
  const commandInfo = buildExecutorCommand(args, root, planPath, planText);
  const commandText = executorCommandPreview(commandInfo);

  if (args.dryRun) {
    printBox('CodexPro execute-handoff dry run', [
      labelValue('Workspace', root),
      labelValue('Plan', path.relative(root, planPath)),
      labelValue('Agent', commandInfo.agent),
      ...(commandInfo.model ? [labelValue('Model', commandInfo.model)] : []),
      labelValue('Command', commandText),
      'No command was executed and no .ai-bridge result files were changed.'
    ]);
    return;
  }

  const confirmed = await confirmLocalExecution(args, root, commandInfo);
  if (!confirmed) {
    statusLine('warn', 'Execution cancelled.');
    return;
  }

  if (!commandAvailableFromRoot(commandInfo.command, root)) {
    throw new Error(`${commandInfo.command} was not found. Install it, add it to PATH, pass an absolute path, or use --command.`);
  }

  statusLine('wait', `Running ${commandInfo.agent}: ${commandText}`);
  const result = await runProcessCaptured(commandInfo.command, commandInfo.args, {
    cwd: root,
    timeoutMs,
    maxOutputBytes
  });
  const diffText = readGitDiff(root, maxOutputBytes);
  const outputs = writeExecutionOutputs(root, contextDir, commandInfo, result, diffText);
  statusLine(result.exitCode === 0 ? 'ok' : 'warn', `Agent exited with code ${result.exitCode ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`);
  console.log(`Status: ${path.relative(root, outputs.statusPath)}`);
  console.log(`Diff:   ${path.relative(root, outputs.diffPath)}`);
  console.log(`Log:    ${path.relative(root, outputs.logPath)}`);
  if (result.exitCode && result.exitCode !== 0) process.exitCode = result.exitCode;
}

function createConnectorDetails(endpoint, token, localBase = '') {
  const serverUrl = endpointWithToken(endpoint, token);
  return {
    endpoint,
    token,
    serverUrl,
    localStatusUrl: localBase ? endpointWithToken(`${localBase}/`, token) : '',
    chatgptSettingsUrl: 'https://chatgpt.com/#settings/Connectors'
  };
}

function printCreateAppFields(details) {
  console.log('Create App fields:');
  console.log('');
  console.log('  Name: CodexPro');
  console.log('  Description: Local coding workspace bridge for ChatGPT.');
  console.log('  Connection: Server URL');
  console.log(`  Server URL: ${details.serverUrl}`);
  console.log('  Authentication: No Authentication / None');
  console.log('');
  if (details.token) {
    console.log('If your ChatGPT UI supports custom headers instead, you can use:');
    console.log('');
    console.log(`  Authorization: Bearer ${details.token}`);
  } else {
    console.log('Authorization: disabled');
  }
}

function printConnectorBlock(endpoint, token, options = {}) {
  const details = createConnectorDetails(endpoint, token, options.localBase ?? '');
  const { serverUrl } = details;
  const publicHttps = serverUrl.startsWith('https://');
  const shouldCopy = options.copyUrl === true || (options.copyUrl !== false && publicHttps);
  const copied = shouldCopy ? copyToClipboard(serverUrl) : { ok: false, command: '' };
  const opened = options.openChatgpt ? openUrl(details.chatgptSettingsUrl) : false;

  const mode = options.mode ?? 'agent';
  const modeTitle = mode === 'agent' ? 'Agent' : mode === 'handoff' ? 'Handoff' : 'Pro planning';
  console.log('');
  console.log(paint('bold', 'CodexPro ready'));
  if (options.root) console.log(`  Workspace  ${options.root}`);
  console.log(`  Mode       ${modeTitle}  write=${options.write ?? 'workspace'}  bash=${options.bash ?? 'safe'}`);
  console.log(`  Connector  ${publicHttps ? 'public HTTPS' : 'local HTTP'}`);
  if (copied.ok) {
    console.log(`  URL        copied with ${copied.command}`);
  } else if (shouldCopy) {
    console.log('  URL        copy failed; copy manually:');
    console.log(serverUrl);
  } else if (options.copyUrl === false && publicHttps) {
    console.log('  URL        not copied; press c to copy or u to show');
  } else if (!publicHttps) {
    console.log('  URL        local HTTP only');
    console.log(serverUrl);
  }
  if (options.openChatgpt) {
    statusLine(opened ? 'ok' : 'warn', opened ? 'Opened ChatGPT connector settings' : 'Could not open ChatGPT automatically');
  }
  console.log('');
  console.log('Next: press Enter to open ChatGPT, paste the copied Server URL, choose Authentication: None.');
  console.log('Keys: Enter open | c copy | o status | h help | q quit');
  return { ...details, copied, opened, mode };
}

function printControlHelp() {
  console.log('');
  console.log('Controls');
  console.log('  Enter  open ChatGPT connector settings in your browser');
  console.log('  c      copy Server URL again');
  console.log('  u      print Server URL only');
  console.log('  o      open local setup/status page');
  console.log('  p      print Create App fields');
  console.log('  m      print mode help');
  console.log('  h      show controls');
  console.log('  q      stop CodexPro');
  console.log('');
}

function printModeHelp() {
  console.log('');
  console.log('Modes');
  console.log('  codexpro start                 agent mode: read/write/edit/search/bash');
  console.log('  codexpro start --mode handoff  planning-only .ai-bridge handoff');
  console.log('  codexpro start --mode pro      export context for models without MCP tools');
  console.log('');
}

function printStableUrlHelp() {
  console.log('');
  console.log('Stable URL setup');
  console.log('');
  console.log('Quick tunnels change every restart. ChatGPT apps should use a stable URL.');
  console.log('');
  console.log('One-time Cloudflare setup with your domain:');
  console.log('  codexpro install-cloudflared');
  console.log('  ~/.codexpro/bin/cloudflared tunnel login');
  console.log('  ~/.codexpro/bin/cloudflared tunnel create codexpro');
  console.log('  ~/.codexpro/bin/cloudflared tunnel route dns codexpro codexpro.example.com');
  console.log('');
  console.log('Daily start:');
  console.log('  codexpro stable --hostname codexpro.example.com --tunnel-name codexpro --token keep-this-stable-token');
  console.log('');
  console.log('Ngrok alternative with a reserved domain:');
  console.log('  ngrok config add-authtoken <your-ngrok-token>');
  console.log('  codexpro ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token');
  console.log('');
}

function compareMajorVersion(version, minimumMajor) {
  const major = Number(String(version).split('.')[0]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function browserOpenCommand() {
  if (process.platform === 'darwin') return commandExists('open') ? 'open' : '';
  if (process.platform === 'win32') return 'cmd start';
  return commandExists('xdg-open') ? 'xdg-open' : '';
}

function clipboardCommand() {
  if (process.platform === 'darwin') return commandExists('pbcopy') ? 'pbcopy' : '';
  if (process.platform === 'win32') return 'clip';
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    if (commandExists(command)) return command;
  }
  return '';
}

function localOrPathCommand(command, localPath) {
  if (command && commandAvailable(command)) return command;
  if (localPath && executableFileExists(localPath)) return localPath;
  return '';
}

function doctorLine(status, label, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('red', 'FAIL');
  console.log(`${marker} ${label.padEnd(18)} ${detail}`);
}

async function runDoctor(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  const host = optionValue(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
  const write = optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.CODEXPRO_PUBLIC_HOSTNAME
    ?? process.env.CODEXPRO_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  const serverPath = path.join(projectRoot, 'dist', 'server.js');
  const cloudflaredPath = localOrPathCommand(
    effectiveArgs.cloudflared ?? process.env.CLOUDFLARED_BIN ?? 'cloudflared',
    localCloudflaredPath()
  );
  const ngrokPath = localOrPathCommand(effectiveArgs.ngrok ?? process.env.NGROK_BIN ?? 'ngrok', '');
  const clipboard = clipboardCommand();
  const browser = browserOpenCommand();
  const checks = [];

  function record(status, label, detail) {
    checks.push(status);
    doctorLine(status, label, detail);
  }

  console.log('');
  printBox('CodexPro doctor', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  write=${write}  bash=${bash}`),
    labelValue('Tunnel', tunnel),
    ...(stableHostname ? [labelValue('Hostname', stableHostname)] : []),
    ...(profile.profilePath ? [labelValue('Profile', profile.profilePath)] : [])
  ]);

  record(compareMajorVersion(process.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${process.versions.node} (requires >=20)`);
  record(fs.existsSync(httpPath) && fs.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fs.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
  record(fs.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
  record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
  record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
  record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');

  try {
    await assertPortAvailable(host, port);
    record('ok', 'Local port', `${host}:${port} available`);
  } catch (error) {
    record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }

  if (tunnel === 'none') {
    record('ok', 'Tunnel', 'local-only mode');
  } else if (tunnel === 'cloudflare') {
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; codexpro start can auto-install unless --no-install-cloudflared is used');
  } else if (tunnel === 'cloudflare-named') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Cloudflare stable mode');
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; run codexpro install-cloudflared or pass --cloudflared');
    record(
      optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '') ||
        optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '') ||
        optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], '') ||
        optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '')
        ? 'ok'
        : 'fail',
      'Cloudflare setup',
      'needs tunnel name, config, token file, or tunnel token'
    );
  } else if (tunnel === 'ngrok') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for ngrok mode');
    record(ngrokPath ? 'ok' : 'fail', 'ngrok', ngrokPath || 'not found on PATH; install ngrok and run ngrok config add-authtoken <token>');
  } else {
    record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
  }

  const failures = checks.filter((status) => status === 'fail').length;
  const warnings = checks.filter((status) => status === 'warn').length;
  console.log('');
  if (failures) {
    statusLine('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
    return;
  }
  statusLine('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
}

function normalizeSetupChoice(value, allowed, fallback) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
  return match ?? fallback;
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` ${paint('dim', `[${fallback}]`)}` : '';
  const hint = fallback ? `${paint('dim', '> Enter to proceed with default')}\n` : '';
  const answer = await rl.question(`${paint('cyan', '?')} ${question}${suffix}\n${hint}> `);
  return answer.trim() || fallback;
}

function tunnelChoiceFromProfile(profile, fallback = 'cloudflare') {
  if (profile?.tunnel === 'ngrok') return 'ngrok';
  if (profile?.tunnel === 'cloudflare-named') return 'stable';
  if (profile?.tunnel === 'none') return 'local';
  if (profile?.tunnel === 'cloudflare') return 'cloudflare';
  return fallback;
}

function tunnelModeFromChoice(choice) {
  if (choice === 'quick' || choice === 'cloudflare') return 'cloudflare';
  if (choice === 'stable') return 'cloudflare-named';
  if (choice === 'local') return 'none';
  return choice;
}

function hasExplicitTunnelInput(args) {
  return Boolean(
    args.tunnel ||
    args.noProfile ||
    process.env.CODEXPRO_TUNNEL
  );
}

async function collectTunnelPreference(rl, defaults, profile, options = {}) {
  const defaultTunnel = options.defaultTunnel ?? tunnelChoiceFromProfile(profile, 'cloudflare');
  const tunnelAnswer = await ask(rl, 'Tunnel: cloudflare, ngrok, stable, or local?', defaultTunnel);
  const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['cloudflare', 'quick', 'ngrok', 'stable', 'local'], defaultTunnel);
  const tunnel = tunnelModeFromChoice(tunnelChoice);
  let hostname = '';
  let tunnelName = '';
  let ngrokConfig = '';
  let cloudflareConfig = '';
  let cloudflareTokenFile = '';

  if (tunnel === 'ngrok') {
    hostname = await ask(
      rl,
      'Ngrok domain or URL, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
    );
    if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
    ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
  } else if (tunnel === 'cloudflare-named') {
    hostname = await ask(
      rl,
      'Stable Cloudflare hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
    tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
    cloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
    cloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
  }

  return {
    tunnel,
    hostname,
    tunnelName,
    ngrokConfig,
    cloudflareConfig,
    cloudflareTokenFile
  };
}

function applyTunnelPreferenceToArgs(args, preference) {
  args.tunnel = preference.tunnel;
  if (preference.hostname) args.hostname = preference.hostname;
  if (preference.tunnelName) args.tunnelName = preference.tunnelName;
  if (preference.ngrokConfig) args.ngrokConfig = preference.ngrokConfig;
  if (preference.cloudflareConfig) args.cloudflareConfig = preference.cloudflareConfig;
  if (preference.cloudflareTokenFile) args.cloudflareTokenFile = preference.cloudflareTokenFile;
}

function profileFromPreference(root, args, profile, preference) {
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
  const write = optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], '');
  const existingToken = optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  const token = preference.tunnel === 'none' ? existingToken : stableToken(existingToken);
  return {
    port,
    mode,
    tunnel: preference.tunnel,
    ...(preference.hostname ? { hostname: preference.hostname } : {}),
    ...(preference.tunnelName ? { tunnelName: preference.tunnelName } : {}),
    ...(preference.ngrokConfig ? { ngrokConfig: preference.ngrokConfig } : {}),
    ...(preference.cloudflareConfig ? { cloudflareConfig: preference.cloudflareConfig } : {}),
    ...(preference.cloudflareTokenFile ? { cloudflareTokenFile: preference.cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(write ? { write } : {}),
    ...(args.noInstallCloudflared ? { noInstallCloudflared: true } : {}),
    root
  };
}

async function maybeConfigureFirstRun(root, args, profile) {
  if (profile.profilePath || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || hasExplicitTunnelInput(args)) {
    return profile;
  }

  const reusableProfiles = listWorkspaceProfiles().filter((item) => item.root !== root);
  if (reusableProfiles.length) {
    const shown = reusableProfiles.slice(0, 9);
    printBox('Saved setups', [
      'No saved settings exist for this workspace, but CodexPro found saved setups from other workspaces.',
      ...shown.map((item, index) => profileOneLine(item, index + 1)),
      'Use a number to reuse one here, or type new to choose a fresh tunnel.'
    ]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(rl, 'Use saved setup number, or new?', shown.length === 1 ? '1' : 'new');
      const normalized = answer.trim().toLowerCase();
      const selectedIndex = Number(normalized);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= shown.length) {
        const selected = shown[selectedIndex - 1];
        const payload = reusableProfilePayload(selected, {
          port: String(optionValue(args, selected, 'port', ['CODEXPRO_PORT'], selected.port ?? '8787')),
          mode: optionValue(args, selected, 'mode', ['CODEXPRO_MODE'], selected.mode ?? 'agent')
        });
        const savedPath = saveWorkspaceProfile(root, payload);
        statusLine('ok', `Saved workspace settings from ${selected.root}: ${savedPath}`);
        return loadWorkspaceProfile(root);
      }
    } finally {
      rl.close();
    }
  }

  printBox('First run setup', [
    'No saved tunnel preference exists for this workspace.',
    'Choose once now. CodexPro will reuse this choice on future codexpro start runs until you change or delete it with codexpro settings.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const preference = await collectTunnelPreference(rl, args, profile, { defaultTunnel: 'cloudflare' });
    applyTunnelPreferenceToArgs(args, preference);
    const saveAnswer = await ask(rl, 'Save this as the default for this workspace?', 'yes');
    if (!['n', 'no'].includes(saveAnswer.trim().toLowerCase())) {
      const savedPath = saveWorkspaceProfile(root, profileFromPreference(root, args, profile, preference));
      statusLine('ok', `Saved workspace settings: ${savedPath}`);
      return loadWorkspaceProfile(root);
    }
    return profileFromPreference(root, args, profile, preference);
  } finally {
    rl.close();
  }
}

function commandPreview(args) {
  return ['codexpro', ...args].map((part) => {
    if (/^[A-Za-z0-9_./:@=-]+$/.test(part)) return part;
    return JSON.stringify(part);
  }).join(' ');
}

async function runSetupWizard(argv) {
  if (!process.stdin.isTTY) {
    throw new Error('codexpro setup needs an interactive terminal. Use codexpro start --root /path/to/repo for non-interactive scripts.');
  }
  const defaults = parseArgs(argv);
  const defaultRoot = path.resolve(expandHome(defaults.root ?? process.env.CODEXPRO_ROOT ?? process.cwd()));

  printBox('CodexPro setup', [
    'This wizard prepares a ChatGPT connector for the folder you choose.',
    'Press Enter to accept defaults. Stable tunnel choices are saved per workspace under ~/.codexpro.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rootInput = await ask(rl, 'Where is your project located?', defaultRoot);
    const root = realDir(rootInput);
    const profile = defaults.noProfile ? {} : loadWorkspaceProfile(root);
    if (profile.profilePath) {
      statusLine('ok', `Loaded saved profile: ${profile.profilePath}`);
      printSavedProfileHint(profile);
    }

    const savedTunnel = optionValue(defaults, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
    const defaultTunnel = savedTunnel === 'cloudflare-named'
      ? 'stable'
      : savedTunnel === 'ngrok'
        ? 'ngrok'
        : savedTunnel === 'none'
          ? 'local'
          : 'quick';
    const defaultPort = String(optionValue(defaults, profile, 'port', ['CODEXPRO_PORT'], '8787'));
    const defaultMode = normalizeSetupChoice(optionValue(defaults, profile, 'mode', ['CODEXPRO_MODE'], 'agent'), ['agent', 'handoff', 'pro'], 'agent');

    const port = await ask(rl, 'Which local port should CodexPro use?', defaultPort);
    if (!/^\d+$/.test(port)) throw new Error('Port must be a number.');
    const modeAnswer = await ask(rl, 'Mode: agent, handoff, or pro?', defaultMode);
    const mode = normalizeSetupChoice(modeAnswer, ['agent', 'handoff', 'pro'], defaultMode);

    printBox('Public URL', [
      'ChatGPT needs an HTTPS URL it can reach.',
      'quick  = CodexPro creates a Cloudflare quick tunnel for demos and local work.',
      'stable = use your own domain with a Cloudflare named tunnel so the ChatGPT app URL does not change.',
      'ngrok  = use your ngrok free dev domain, for example https://name.ngrok-free.dev.',
      'local  = no tunnel, only useful for local MCP clients that can reach 127.0.0.1.'
    ]);

    const tunnelAnswer = await ask(rl, 'Public access: quick, stable, ngrok, or local?', defaultTunnel);
    const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['quick', 'stable', 'ngrok', 'local'], defaultTunnel);
    const args = ['start', '--root', root, '--port', port, '--mode', mode];
    const bash = optionValue(defaults, profile, 'bash', ['CODEXPRO_BASH_MODE'], '');
    const write = optionValue(defaults, profile, 'write', ['CODEXPRO_WRITE_MODE'], '');
    if (bash) args.push('--bash', bash);
    if (write) args.push('--write', write);
    if (defaults.noInstallCloudflared) args.push('--no-install-cloudflared');
    if (defaults.openChatgpt) args.push('--open-chatgpt');
    if (defaults.noCopyUrl) args.push('--no-copy-url');

    let profileTunnel = 'cloudflare';
    let profileHostname = '';
    let profileTunnelName = '';
    let profileNgrokConfig = '';
    let profileCloudflareConfig = '';
    let profileCloudflareTokenFile = '';
    let profileToken = optionValue(defaults, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');

    if (tunnelChoice === 'local') {
      profileTunnel = 'none';
      args.push('--tunnel', 'none');
    } else if (tunnelChoice === 'stable') {
      profileTunnel = 'cloudflare-named';
      const hostname = await ask(
        rl,
        'Stable Cloudflare hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example codexpro.yourdomain.com.');
      profileHostname = hostname;
      const tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['CODEXPRO_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'codexpro'));
      profileTunnelName = tunnelName;
      args.push('--tunnel', 'cloudflare-named', '--hostname', hostname, '--tunnel-name', tunnelName);
      profileCloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['CODEXPRO_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
      profileCloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
      if (profileCloudflareConfig) args.push('--cloudflare-config', profileCloudflareConfig);
      if (profileCloudflareTokenFile) args.push('--cloudflare-token-file', profileCloudflareTokenFile);
    } else if (tunnelChoice === 'ngrok') {
      profileTunnel = 'ngrok';
      const hostname = await ask(
        rl,
        'Ngrok domain or URL, without /mcp',
        optionValue(defaults, profile, 'hostname', ['CODEXPRO_PUBLIC_HOSTNAME', 'CODEXPRO_HOSTNAME', 'NGROK_DOMAIN'], '')
      );
      if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
      profileHostname = hostname;
      args.push('--tunnel', 'ngrok', '--hostname', hostname);
      const ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'CODEXPRO_NGROK_CONFIG'], '');
      if (ngrokConfig) {
        profileNgrokConfig = ngrokConfig;
        args.push('--ngrok-config', ngrokConfig);
      }
    } else {
      profileTunnel = 'cloudflare';
      args.push('--tunnel', 'cloudflare');
    }

    if (profileTunnel !== 'none') {
      profileToken = await ask(rl, 'CodexPro auth token for this workspace', stableToken(profileToken));
      if (profileToken) args.push('--token', profileToken);
    }

    const saveDefault = defaults.noSaveConfig ? 'no' : 'yes';
    const saveAnswer = await ask(rl, 'Save this setup for future runs from this workspace?', saveDefault);
    const shouldSave = !['n', 'no'].includes(saveAnswer.trim().toLowerCase());
    if (shouldSave) {
      const savedPath = saveWorkspaceProfile(root, {
        port,
        mode,
        tunnel: profileTunnel,
        ...(profileHostname ? { hostname: profileHostname } : {}),
        ...(profileTunnelName ? { tunnelName: profileTunnelName } : {}),
        ...(profileNgrokConfig ? { ngrokConfig: profileNgrokConfig } : {}),
        ...(profileCloudflareConfig ? { cloudflareConfig: profileCloudflareConfig } : {}),
        ...(profileCloudflareTokenFile ? { cloudflareTokenFile: profileCloudflareTokenFile } : {}),
        ...(profileToken ? { token: profileToken } : {}),
        ...(bash ? { bash } : {}),
        ...(write ? { write } : {}),
        ...(defaults.noInstallCloudflared ? { noInstallCloudflared: true } : {})
      });
      statusLine('ok', `Saved workspace profile: ${savedPath}`);
    }

    const startAnswer = await ask(rl, 'Start CodexPro now?', 'yes');
    const shouldStart = !['n', 'no'].includes(startAnswer.trim().toLowerCase());
    console.log('');
    console.log(paint('bold', 'Command'));
    console.log(`  ${commandPreview(args)}`);
    console.log('');
    if (!shouldStart) {
      console.log('Setup complete. Run the command above when you are ready.');
      return null;
    }
    return args;
  } finally {
    rl.close();
  }
}

function printProfile(root, profile) {
  if (!profile.profilePath) {
    printBox('CodexPro settings', [
      labelValue('Workspace', root),
      'No saved settings for this workspace.',
      'Run codexpro settings set or codexpro setup to save a tunnel preference.'
    ]);
    return;
  }
  const safe = sanitizedProfile(profile);
  printBox('CodexPro settings', [
    labelValue('Workspace', root),
    labelValue('Profile', profile.profilePath),
    labelValue('Tunnel', safe.tunnel ?? 'cloudflare'),
    ...(safe.hostname ? [labelValue('Hostname', safe.hostname)] : []),
    ...(safe.port ? [labelValue('Port', safe.port)] : []),
    ...(safe.mode ? [labelValue('Mode', safe.mode)] : []),
    ...(safe.token ? [labelValue('Token', safe.token)] : [])
  ]);
}

function printProfileList(profiles = listWorkspaceProfiles()) {
  if (!profiles.length) {
    printBox('CodexPro saved setups', [
      'No saved workspace settings found.',
      'Run codexpro setup or codexpro settings set to create one.'
    ]);
    return;
  }
  printBox('CodexPro saved setups', profiles.slice(0, 50).map((profile, index) => profileOneLine(profile, index + 1)));
}

function saveSettingsFromArgs(root, args, profile) {
  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], profile.tunnel ?? 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, or ngrok');
  }
  const hostname = args.hostname ?? args.url ?? profile.hostname ?? '';
  if ((tunnel === 'ngrok' || tunnel === 'cloudflare-named') && !hostname) {
    throw new Error('--hostname is required for ngrok and cloudflare-named settings.');
  }
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], profile.mode ?? 'agent');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], profile.port ?? '8787'));
  const token = tunnel === 'none'
    ? optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? '')
    : stableToken(optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], profile.token ?? ''));
  const savedPath = saveWorkspaceProfile(root, {
    port,
    mode,
    tunnel,
    ...(hostname ? { hostname } : {}),
    ...(args.tunnelName ?? profile.tunnelName ? { tunnelName: args.tunnelName ?? profile.tunnelName } : {}),
    ...(args.ngrokConfig ?? profile.ngrokConfig ? { ngrokConfig: args.ngrokConfig ?? profile.ngrokConfig } : {}),
    ...(args.cloudflareConfig ?? profile.cloudflareConfig ? { cloudflareConfig: args.cloudflareConfig ?? profile.cloudflareConfig } : {}),
    ...(args.cloudflareTokenFile ?? profile.cloudflareTokenFile ? { cloudflareTokenFile: args.cloudflareTokenFile ?? profile.cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(args.bash ?? profile.bash ? { bash: args.bash ?? profile.bash } : {}),
    ...(args.write ?? profile.write ? { write: args.write ?? profile.write } : {}),
    ...(args.noInstallCloudflared ?? profile.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  });
  statusLine('ok', `Saved workspace settings: ${savedPath}`);
  printProfile(root, loadWorkspaceProfile(root));
}

async function chooseReusableProfile(rl, currentRoot, profiles = listWorkspaceProfiles()) {
  const reusable = profiles.filter((item) => item.root !== currentRoot);
  if (!reusable.length) return null;
  printProfileList(reusable);
  const answer = await ask(rl, 'Use saved setup number?', reusable.length === 1 ? '1' : '');
  const selectedIndex = Number(answer.trim());
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > reusable.length) {
    throw new Error('Invalid saved setup number.');
  }
  return reusable[selectedIndex - 1];
}

async function runSettings(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const args = parseArgs(action ? argv.slice(1) : argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);

  if (action === 'list' || action === 'ls') {
    printProfileList();
    return;
  }

  if (action === 'show' || (!action && !process.stdin.isTTY)) {
    printProfile(root, profile);
    return;
  }

  if (action === 'delete' || action === 'reset' || action === 'remove') {
    if (!profile.profilePath) {
      statusLine('warn', 'No saved settings exist for this workspace.');
      return;
    }
    if (!args.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          statusLine('warn', 'Settings delete cancelled.');
          return;
        }
      } finally {
        rl.close();
      }
    } else if (!args.yes) {
      throw new Error('Use codexpro settings delete --yes in non-interactive shells.');
    }
    deleteWorkspaceProfile(root);
    statusLine('ok', 'Deleted saved settings for this workspace.');
    return;
  }

  if (action === 'set') {
    saveSettingsFromArgs(root, args, profile);
    return;
  }

  if (action === 'use' || action === 'copy') {
    const fromRoot = args.fromRoot ? realDir(args.fromRoot) : '';
    let source = fromRoot ? loadWorkspaceProfile(fromRoot) : null;
    if (fromRoot && !source.profilePath) {
      throw new Error(`No saved settings found for --from-root ${fromRoot}`);
    }
    if (!source) {
      if (!process.stdin.isTTY) throw new Error('Use --from-root in non-interactive shells.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        source = await chooseReusableProfile(rl, root);
      } finally {
        rl.close();
      }
    }
    if (!source) {
      statusLine('warn', 'No reusable saved settings found.');
      return;
    }
    const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
    statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
    return;
  }

  if (action && !['change', 'edit'].includes(action)) {
    throw new Error(`Unknown settings action: ${action}`);
  }

  if (!process.stdin.isTTY) {
    printProfile(root, profile);
    return;
  }

  printProfile(root, profile);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await ask(rl, 'Action: set, use, delete, show, list, or exit?', profile.profilePath ? 'show' : 'set');
    const normalized = normalizeSetupChoice(selected, ['set', 'use', 'delete', 'show', 'list', 'exit'], profile.profilePath ? 'show' : 'set');
    if (normalized === 'exit') return;
    if (normalized === 'list') {
      printProfileList();
      return;
    }
    if (normalized === 'show') {
      printProfile(root, profile);
      return;
    }
    if (normalized === 'use') {
      const source = await chooseReusableProfile(rl, root);
      if (!source) {
        statusLine('warn', 'No reusable saved settings found.');
        return;
      }
      const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
      statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
      printProfile(root, loadWorkspaceProfile(root));
      return;
    }
    if (normalized === 'delete') {
      if (!profile.profilePath) {
        statusLine('warn', 'No saved settings exist for this workspace.');
        return;
      }
      const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        statusLine('warn', 'Settings delete cancelled.');
        return;
      }
      deleteWorkspaceProfile(root);
      statusLine('ok', 'Deleted saved settings for this workspace.');
      return;
    }

    const preference = await collectTunnelPreference(rl, args, profile);
    const payload = profileFromPreference(root, args, profile, preference);
    const savedPath = saveWorkspaceProfile(root, payload);
    statusLine('ok', `Saved workspace settings: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
  } finally {
    rl.close();
  }
}

function writeControlPrompt() {
  process.stdout.write('codexpro> ');
}

function runControlPanel(details) {
  if (!process.stdin.isTTY) return new Promise(() => {});

  writeControlPrompt();

  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise(() => {
    process.stdin.on('data', (key) => {
      if (key === '\u0003') {
        console.log('\nStopping CodexPro...');
        cleanupChildren();
        process.exit(130);
      }
      const normalized = key.toLowerCase();
      if (key === '\r' || key === '\n') {
        const opened = openUrl(details.chatgptSettingsUrl);
        console.log(opened ? '\nOpened ChatGPT connector settings. The Server URL is already copied; paste it into Server URL.' : '\nCould not open ChatGPT automatically.');
        writeControlPrompt();
      } else if (normalized === 'c') {
        const copied = copyToClipboard(details.serverUrl);
        console.log(copied.ok ? `\nServer URL copied with ${copied.command}.` : '\nCould not copy automatically.');
        writeControlPrompt();
      } else if (normalized === 'u') {
        console.log(`\n${details.serverUrl}`);
        writeControlPrompt();
      } else if (normalized === 'o') {
        if (!details.localStatusUrl) {
          console.log('\nNo local status page URL is available for this run.');
        } else {
          const opened = openUrl(details.localStatusUrl);
          console.log(opened ? '\nOpened local CodexPro setup/status page.' : `\nCould not open automatically. Open this URL:\n${details.localStatusUrl}`);
        }
        writeControlPrompt();
      } else if (normalized === 'p') {
        console.log('');
        printCreateAppFields(details);
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'm') {
        printModeHelp();
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'h' || normalized === '?') {
        printControlHelp();
        writeControlPrompt();
      } else if (normalized === 'q') {
        console.log('\nStopping CodexPro...');
        cleanupChildren();
        process.exit(0);
      }
    });
  });
}

async function main() {
  let argv = process.argv.slice(2);
  let subcommand = argv[0];
  if (subcommand === 'stable-help') {
    printStableUrlHelp();
    return;
  }
  if (subcommand === 'setup' || subcommand === 'onboard') {
    if (argv.includes('--help') || argv[1] === 'help') {
      usage();
      return;
    }
    const setupArgs = await runSetupWizard(argv.slice(1));
    if (!setupArgs) return;
    argv = setupArgs;
    subcommand = argv[0];
  }
  if (subcommand === 'settings' || subcommand === 'config') {
    await runSettings(argv.slice(1));
    return;
  }
  if (subcommand === 'execute-handoff' || subcommand === 'execute' || subcommand === 'run-handoff') {
    await runExecuteHandoff(argv.slice(1));
    return;
  }
  if (subcommand === 'pro-bundle' || subcommand === 'bundle') {
    runHelperScript('pro-bundle.mjs', argv.slice(1));
  }
  if (subcommand === 'pro-apply' || subcommand === 'apply') {
    runHelperScript('pro-apply.mjs', argv.slice(1));
  }
  if (subcommand === 'install-cloudflared') {
    const installArgs = parseArgs(argv.slice(1));
    if (installArgs.help) {
      usage();
      return;
    }
    const installedCloudflared = await installCloudflaredLocal();
    console.log(`cloudflared ready: ${installedCloudflared}`);
    return;
  }
  if (subcommand === 'doctor') {
    await runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'stable') {
    argv.shift();
    argv.unshift('--tunnel', 'cloudflare-named');
  }
  if (argv[0] === 'ngrok') {
    argv.shift();
    argv.unshift('--tunnel', 'ngrok');
  }
  if (argv[0] === 'start' || argv[0] === 'connect') argv.shift();
  if (argv[0] === 'help') argv[0] = '--help';
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.CODEXPRO_ROOT ?? process.cwd());
  let profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  profile = await maybeConfigureFirstRun(root, args, profile);
  const effectiveArgs = { ...profile, ...args };
  if (profile.profilePath && !args.noProfile) {
    statusLine('ok', `Using saved profile: ${profile.profilePath}`);
    const summary = profileSummary(profile);
    if (summary) statusLine('ok', `${summary}. Future launches from this folder only need: codexpro start`);
  }

  const tunnel = optionValue(args, profile, 'tunnel', ['CODEXPRO_TUNNEL'], 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, or ngrok');
  }
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.CODEXPRO_PUBLIC_HOSTNAME
    ?? process.env.CODEXPRO_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  if (tunnel === 'cloudflare-named' && !stableHostname) {
    printStableUrlHelp();
    throw new Error('--hostname is required with stable URL mode.');
  }
  if (tunnel === 'ngrok' && !stableHostname) {
    throw new Error('--hostname is required with ngrok tunnel mode. Example: codexpro ngrok --hostname your-domain.ngrok-free.dev');
  }
  if (args.noAuth && tunnel !== 'none') {
    throw new Error('--no-auth is only allowed with --tunnel none. Public tunnels require CODEXPRO_HTTP_TOKEN.');
  }
  const mode = optionValue(args, profile, 'mode', ['CODEXPRO_MODE'], 'agent');
  if (!['agent', 'handoff', 'pro'].includes(mode)) {
    throw new Error('--mode must be agent, handoff, or pro');
  }

  const allowRoots = [root, ...(args.allowRoots ?? [])].map(realDir);
  const host = optionValue(args, profile, 'host', ['CODEXPRO_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['CODEXPRO_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['CODEXPRO_BASH_MODE'], 'safe');
  const write = optionValue(args, profile, 'write', ['CODEXPRO_WRITE_MODE'], mode === 'agent' ? 'workspace' : 'handoff');
  if (!['off', 'safe', 'full'].includes(bash)) throw new Error('--bash must be off, safe, or full');
  if (!['off', 'handoff', 'workspace'].includes(write)) throw new Error('--write must be off, handoff, or workspace');

  let token = args.noAuth ? '' : optionValue(args, profile, 'token', ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN'], '');
  if (!token && tunnel !== 'none') token = stableToken();

  const serverEnv = {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    CODEXPRO_HOST: host,
    CODEXPRO_PORT: port,
    CODEXPRO_BASH_MODE: bash,
    CODEXPRO_WRITE_MODE: write,
    CODEXPRO_MODE: mode,
    CODEXPRO_TUNNEL_MODE: tunnel === 'none' ? '0' : '1'
  };
  if (args.logRequests || process.env.CODEXPRO_LOG_REQUESTS === '1') serverEnv.CODEXPRO_LOG_REQUESTS = '1';
  if (args.allowHome) serverEnv.CODEXPRO_ALLOW_HOME = '1';
  if (token) serverEnv.CODEXPRO_HTTP_TOKEN = token;
  else delete serverEnv.CODEXPRO_HTTP_TOKEN;

  if (args.printEnv) {
    console.log(JSON.stringify({ ...serverEnv, CODEXPRO_HTTP_TOKEN: token ? '<redacted>' : undefined }, null, 2));
  }

  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  if (!fs.existsSync(httpPath)) {
    throw new Error(`Missing ${httpPath}. Run npm install && npm run build first.`);
  }

  await assertPortAvailable(host, port);

  printBox('CodexPro start', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  write=${write}  bash=${bash}`),
    labelValue('Local URL', `http://${host}:${port}/mcp`),
    labelValue(
      'Tunnel',
      tunnel === 'cloudflare'
        ? 'Cloudflare quick tunnel'
        : tunnel === 'cloudflare-named'
          ? `Cloudflare named tunnel for ${stableHostname}`
          : tunnel === 'ngrok'
            ? `ngrok endpoint for ${stableHostname}`
            : 'none'
    )
  ]);

  const verboseLogs = Boolean(args.logRequests || process.env.CODEXPRO_LOG_REQUESTS === '1');
  statusLine('wait', 'Starting local MCP server');
  const server = spawnLogged('codexpro', process.execPath, [httpPath], { cwd: projectRoot, env: serverEnv, verbose: verboseLogs });
  let cloudflared;
  const cleanup = cleanupChildren;
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const localBase = `http://${host}:${port}`;
  await waitForHealth(`${localBase}/healthz`, token);
  statusLine('ok', `Local MCP ready at ${localBase}/mcp`);

  if (tunnel === 'none') {
    if (effectiveArgs.installCloudflared) {
      const installedCloudflared = await resolveCloudflared(effectiveArgs);
      if (installedCloudflared) console.log(`cloudflared ready: ${installedCloudflared}`);
    }
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      copyUrl: args.copyUrl ? true : args.noCopyUrl ? false : undefined,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      root,
      write,
      bash
    });
    await runControlPanel(details);
    return;
  }

  if (tunnel === 'ngrok') {
    const ngrokPath = resolveNgrok(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const ngrokArgs = ['http', localBase, '--url', publicBase];
    const configPath = ngrokConfigPath(effectiveArgs);
    if (configPath) ngrokArgs.push('--config', configPath);
    statusLine('wait', `Opening ngrok endpoint for ${publicBase}`);
    cloudflared = spawnLogged('ngrok', ngrokPath, ngrokArgs, { cwd: root, env: process.env, verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, cloudflared, 'ngrok');
    } catch (error) {
      const tail = typeof cloudflared.codexproLogTail === 'function' ? cloudflared.codexproLogTail() : '';
      const hint = [
        '',
        'Ngrok stable domains need one-time setup before this can succeed:',
        '',
        '  ngrok config add-authtoken <your-ngrok-token>',
        '  find your free ngrok dev domain in the ngrok dashboard',
        '  codexpro ngrok --hostname your-domain.ngrok-free.dev --token keep-this-stable-token',
        '',
        'If the domain is already in use, stop the other ngrok process or choose another reserved domain.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent ngrok output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      root,
      write,
      bash
    });
    await runControlPanel(details);
    return;
  }

  const cloudflaredPath = await resolveCloudflared(effectiveArgs);
  if (!cloudflaredPath) {
    console.error('\ncloudflared was not found. The local MCP server is still running.');
    console.error('Install Cloudflare Tunnel, rerun without --no-install-cloudflared, or run with --tunnel none for local clients.');
    console.error('Downloads: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      copyUrl: args.copyUrl ? true : false,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      root,
      write,
      bash
    });
    await runControlPanel(details);
    return;
  }

  if (tunnel === 'cloudflare') {
    statusLine('wait', 'Opening Cloudflare quick tunnel');
    cloudflared = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase], { cwd: root, env: process.env, verbose: verboseLogs });
    const publicBase = await waitForCloudflareUrl(cloudflared);
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      root,
      write,
      bash
    });
    await runControlPanel(details);
    return;
  }

  const publicBase = publicBaseFromHostname(stableHostname);
  const tunnelName = optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'CODEXPRO_TUNNEL_NAME'], '');
  const cloudflareConfig = optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'CODEXPRO_CLOUDFLARE_CONFIG'], '');
  const cloudflareTokenFile = optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
  const cloudflareToken = optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'CODEXPRO_CLOUDFLARE_TUNNEL_TOKEN'], '');

  const cloudflaredArgs = ['tunnel'];
  if (cloudflareConfig) {
    cloudflaredArgs.push('--config', path.resolve(expandHome(cloudflareConfig)), 'run');
    if (tunnelName) cloudflaredArgs.push(tunnelName);
  } else {
    cloudflaredArgs.push('run', '--url', localBase);
    if (cloudflareTokenFile) {
      cloudflaredArgs.push('--token-file', path.resolve(expandHome(cloudflareTokenFile)));
    } else if (cloudflareToken) {
      // Passed to cloudflared through the child environment below.
    } else {
      if (!tunnelName) {
        throw new Error('--tunnel-name, --cloudflare-token, --cloudflare-token-file, or --cloudflare-config is required with --tunnel cloudflare-named.');
      }
      cloudflaredArgs.push(tunnelName);
    }
  }

  statusLine('wait', `Starting Cloudflare named tunnel for ${publicBase}`);
  const cloudflaredEnv = cloudflareToken && !cloudflareTokenFile
    ? { ...process.env, TUNNEL_TOKEN: cloudflareToken }
    : process.env;
  cloudflared = spawnLogged('cloudflared', cloudflaredPath, cloudflaredArgs, { cwd: root, env: cloudflaredEnv, verbose: verboseLogs });
  try {
    await waitForPublicHealth(publicBase, token, cloudflared);
  } catch (error) {
    const tail = typeof cloudflared.codexproLogTail === 'function' ? cloudflared.codexproLogTail() : '';
    const hint = [
      '',
      'Named Cloudflare tunnels need one-time setup before this can succeed:',
      '',
      '  cloudflared tunnel login',
      '  cloudflared tunnel create <tunnel-name>',
      '  cloudflared tunnel route dns <tunnel-name> <hostname>',
      '',
      'Or create a remotely managed tunnel in the Cloudflare dashboard and pass:',
      '',
      '  --cloudflare-token-file ~/.codexpro/cloudflare-tunnel-token',
      '',
      'Quick tunnels do not support a permanent hostname. Use --tunnel cloudflare only for demos.'
    ].join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent cloudflared output:\n${tail}` : ''}${hint}`);
  }
  const details = printConnectorBlock(`${publicBase}/mcp`, token, {
    localBase,
    copyUrl: args.noCopyUrl ? false : true,
    openChatgpt: Boolean(args.openChatgpt),
    mode,
    root,
    write,
    bash
  });
  await runControlPanel(details);
}

main().catch((error) => {
  cleanupChildren();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (process.env.CODEXPRO_DEBUG === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
