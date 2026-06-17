import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args, options = {}) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    ...options
  });
  return result;
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function quoteArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-execute-handoff-'));
await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Test plan\n\nAppend the implementation marker.\n', 'utf8');
await fs.writeFile(path.join(root, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(root, 'fake-agent.mjs'), `
import fs from 'node:fs';

const taskIndex = process.argv.indexOf('--task-file');
const modelIndex = process.argv.indexOf('--model');
if (taskIndex < 0) throw new Error('missing --task-file');
const plan = fs.readFileSync(process.argv[taskIndex + 1], 'utf8');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : '';
fs.appendFileSync('app.txt', \`implemented with \${model}: \${plan.includes('implementation marker') ? 'yes' : 'no'}\\n\`);
console.log('fake agent completed');
`, 'utf8');

requireSuccess(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }), 'git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: root, encoding: 'utf8' }), 'git add');

const dryRun = run([
  'execute-handoff',
  '--root',
  root,
  '--agent',
  'opencode',
  '--model',
  'provider/model',
  '--dry-run'
]);
requireSuccess(dryRun, 'execute-handoff dry-run');
if (!dryRun.stdout.includes('opencode run') || !dryRun.stdout.includes('provider/model')) {
  throw new Error(`dry-run output did not show adapter command\n${dryRun.stdout}`);
}

const missingPlaceholder = run([
  'execute-handoff',
  '--root',
  root,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} fake-agent.mjs`,
  '--yes'
]);
if (missingPlaceholder.status === 0 || !missingPlaceholder.stderr.includes('must include {{plan_file}} or {{plan_text}}')) {
  throw new Error(`custom command without plan placeholder should fail\nstdout:\n${missingPlaceholder.stdout}\nstderr:\n${missingPlaceholder.stderr}`);
}

const executed = run([
  'execute-handoff',
  '--root',
  root,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} fake-agent.mjs --model {{model}} --task-file {{plan_file}}`,
  '--model',
  'local/test-model',
  '--yes'
]);
requireSuccess(executed, 'execute-handoff custom');

const status = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
const diff = await fs.readFile(path.join(root, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
const log = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
const app = await fs.readFile(path.join(root, 'app.txt'), 'utf8');

for (const expected of ['Agent Execution Status', 'Agent: custom', 'Exit code: 0', 'fake agent completed']) {
  if (!status.includes(expected)) throw new Error(`status missing ${expected}\n${status}`);
}
if (!diff.includes('implemented with local/test-model')) {
  throw new Error(`diff did not include implementation marker\n${diff}`);
}
if (!log.includes('"event":"execute_handoff"') || !log.includes('"agent":"custom"')) {
  throw new Error(`execution log missing structured event\n${log}`);
}
if (!app.includes('implemented with local/test-model: yes')) {
  throw new Error(`fake agent did not edit app.txt\n${app}`);
}

const watchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-watch-handoff-'));
await fs.mkdir(path.join(watchRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(watchRoot, '.ai-bridge', 'current-plan.md'), '# Current Plan\n\nNo plan written yet.\n', 'utf8');
await fs.writeFile(path.join(watchRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(watchRoot, 'watch-agent.mjs'), `
import fs from 'node:fs';

const taskIndex = process.argv.indexOf('--task-file');
if (taskIndex < 0) throw new Error('missing --task-file');
const plan = fs.readFileSync(process.argv[taskIndex + 1], 'utf8');
fs.appendFileSync('app.txt', \`watch implemented: \${plan.split('\\n')[0]}\\n\`);
console.log('watch agent completed');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: watchRoot, encoding: 'utf8' }), 'watch git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: watchRoot, encoding: 'utf8' }), 'watch git add');

const watchCommand = [
  'watch-handoff',
  '--root',
  watchRoot,
  '--agent',
  'custom',
  '--command',
  `${process.execPath} watch-agent.mjs --task-file {{plan_file}}`,
  '--once',
  '--yes',
  '--debounce-ms',
  '0'
];

requireSuccess(run(watchCommand), 'watch-handoff scaffold skip');
let watchApp = await fs.readFile(path.join(watchRoot, 'app.txt'), 'utf8');
if (watchApp !== 'start\n') {
  throw new Error(`watch executed scaffolded empty plan\n${watchApp}`);
}

await fs.writeFile(path.join(watchRoot, '.ai-bridge', 'current-plan.md'), '# Watch plan 1\n\nAppend watch marker.\n', 'utf8');
requireSuccess(run(watchCommand), 'watch-handoff first run');
watchApp = await fs.readFile(path.join(watchRoot, 'app.txt'), 'utf8');
if ((watchApp.match(/watch implemented/g) ?? []).length !== 1) {
  throw new Error(`watch first run did not execute exactly once\n${watchApp}`);
}

requireSuccess(run(watchCommand), 'watch-handoff duplicate skip');
watchApp = await fs.readFile(path.join(watchRoot, 'app.txt'), 'utf8');
if ((watchApp.match(/watch implemented/g) ?? []).length !== 1) {
  throw new Error(`watch duplicate plan was executed again\n${watchApp}`);
}

await fs.writeFile(path.join(watchRoot, '.ai-bridge', 'current-plan.md'), '# Watch plan 2\n\nAppend second watch marker.\n', 'utf8');
requireSuccess(run(watchCommand), 'watch-handoff changed plan');
watchApp = await fs.readFile(path.join(watchRoot, 'app.txt'), 'utf8');
if ((watchApp.match(/watch implemented/g) ?? []).length !== 2 || !watchApp.includes('# Watch plan 2')) {
  throw new Error(`watch changed plan did not execute\n${watchApp}`);
}

const watchState = await fs.readFile(path.join(watchRoot, '.ai-bridge', 'watch-handoff-state.json'), 'utf8');
const watchLog = await fs.readFile(path.join(watchRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!watchState.includes('lastPlanHash') || !watchLog.includes('"event":"watch_handoff_started"') || !watchLog.includes('"event":"watch_handoff_finished"')) {
  throw new Error(`watch did not write state/log\nstate:\n${watchState}\nlog:\n${watchLog}`);
}

console.log('✓ execute-handoff and watch-handoff smoke test passed');
