import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-doctor-smoke-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-doctor-home-'));
const port = await getFreePort();
const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'));
for (const args of [['--version'], ['-v'], ['version'], ['start', '--version']]) {
  const version = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_HOME: home },
    encoding: 'utf8'
  });
  if (version.status !== 0 || version.stdout.trim() !== packageJson.version) {
    throw new Error(`codexpro ${args.join(' ')} did not print version ${packageJson.version}\nstdout:\n${version.stdout}\nstderr:\n${version.stderr}`);
  }
}
const result = spawnSync(process.execPath, [
  'scripts/codexpro.mjs',
  'doctor',
  '--root',
  root,
  '--port',
  String(port),
  '--tunnel',
  'none'
], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_HOME: home },
  encoding: 'utf8'
});

if (result.status !== 0) {
  throw new Error(`doctor failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const output = `${result.stdout}\n${result.stderr}`;
for (const expected of ['CodexPro doctor', 'Node', 'Build artifacts', 'Local port', 'Ready']) {
  if (!output.includes(expected)) {
    throw new Error(`doctor output missing ${expected}\n${output}`);
  }
}

console.log('✓ doctor smoke test passed');
