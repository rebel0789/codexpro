import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-pro-smoke-'));
await fs.writeFile(path.join(root, 'README.md'), '# Demo\n', 'utf8');
await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\nbeta\n', 'utf8');

run(['scripts/pro-bundle.mjs', '--root', root, '--path', 'demo.txt', '--max-files', '4', '--max-total-bytes', '80000']);
const proContext = await fs.readFile(path.join(root, '.ai-bridge', 'pro-context.md'), 'utf8');
if (!proContext.includes('CodexPro Context Bundle') || !proContext.includes('demo.txt')) {
  throw new Error('pro context bundle did not include expected content');
}
run([
  'scripts/pro-bundle.mjs',
  '--root', root,
  '--path', 'demo.txt',
  '--no-important-files',
  '--no-changed-files',
  '--no-diff',
  '--no-ai-bridge',
  '--max-files', '4',
  '--max-total-bytes', '80000'
]);
const exactProContext = await fs.readFile(path.join(root, '.ai-bridge', 'pro-context.md'), 'utf8');
if (!exactProContext.includes('Auto-include important root files: no') || !exactProContext.includes('Auto-include changed files: no')) {
  throw new Error('selected-only pro context did not record disabled auto-inclusion settings');
}
if (!exactProContext.includes('### demo.txt') || exactProContext.includes('### README.md')) {
  throw new Error('selected-only pro context did not include exactly the requested file');
}

const planFile = path.join(root, 'plan.md');
await fs.writeFile(planFile, 'Inspect demo.txt and keep changes narrow.\n', 'utf8');
run(['scripts/pro-apply.mjs', '--root', root, '--file', planFile, '--title', 'Smoke Pro Plan']);
const currentPlan = await fs.readFile(path.join(root, '.ai-bridge', 'current-plan.md'), 'utf8');
if (!currentPlan.includes('Smoke Pro Plan') || !currentPlan.includes('Inspect demo.txt')) {
  throw new Error('pro apply did not write expected current-plan content');
}
const executionLog = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!executionLog.includes('"event":"pro_apply"')) {
  throw new Error('pro apply did not append execution-log event');
}

console.log('✓ pro CLI smoke test passed');
