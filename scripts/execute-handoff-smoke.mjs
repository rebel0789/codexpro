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

await fs.writeFile(path.join(root, 'empty-arg-agent.mjs'), `
const emptyIndex = process.argv.indexOf('--empty');
if (emptyIndex < 0 || process.argv[emptyIndex + 1] !== '') {
  console.error(\`EMPTY_ARG=\${JSON.stringify(process.argv[emptyIndex + 1])}\`);
  process.exit(7);
}
`, 'utf8');
const emptyArg = run([
  'execute-handoff',
  '--root',
  root,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} empty-arg-agent.mjs --empty "" --task-file {{plan_file}}`,
  '--yes'
]);
requireSuccess(emptyArg, 'execute-handoff empty quoted arg');

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

const runStateRaw = await fs.readFile(path.join(root, '.ai-bridge', 'handoff-run-state.json'), 'utf8');
const runState = JSON.parse(runStateRaw);
if (runState.state !== 'completed') {
  throw new Error(`handoff-run-state did not record completion\n${runStateRaw}`);
}
if (runState.exit_code !== 0 || runState.timed_out !== false || runState.executor !== 'custom') {
  throw new Error(`handoff-run-state missing expected run fields\n${runStateRaw}`);
}
if (!runState.plan_hash || !runState.started_at || !runState.finished_at || runState.status_file !== '.ai-bridge/agent-status.md') {
  throw new Error(`handoff-run-state missing lifecycle fields\n${runStateRaw}`);
}

const executeStagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-execute-staged-untracked-'));
await fs.mkdir(path.join(executeStagedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(executeStagedRoot, '.ai-bridge', 'current-plan.md'), '# Staged plan\n\nStage one edit and create one file.\n', 'utf8');
await fs.writeFile(path.join(executeStagedRoot, 'app.txt'), 'base\n', 'utf8');
await fs.writeFile(path.join(executeStagedRoot, 'stage-agent.mjs'), `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'staged change\\n');
spawnSync('git', ['add', 'app.txt'], { stdio: 'inherit' });
fs.writeFileSync('new-feature.txt', 'new feature\\n');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: executeStagedRoot, encoding: 'utf8' }), 'execute staged git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: executeStagedRoot, encoding: 'utf8' }), 'execute staged git add');
requireSuccess(run([
  'execute-handoff',
  '--root',
  executeStagedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} stage-agent.mjs --task-file {{plan_file}}`,
  '--yes'
]), 'execute-handoff staged/untracked diff');
const executeStagedDiff = await fs.readFile(path.join(executeStagedRoot, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
if (!executeStagedDiff.includes('# Staged diff') || !executeStagedDiff.includes('staged change') || !executeStagedDiff.includes('# Untracked files') || !executeStagedDiff.includes('new-feature.txt')) {
  throw new Error(`execute-handoff diff missed staged or untracked changes\n${executeStagedDiff}`);
}

const timeoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-execute-timeout-'));
await fs.mkdir(path.join(timeoutRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(timeoutRoot, '.ai-bridge', 'current-plan.md'), '# Timeout plan\n\nSleep too long.\n', 'utf8');
await fs.writeFile(path.join(timeoutRoot, 'slow-agent.mjs'), `setTimeout(() => {}, 5000);\n`, 'utf8');
const timeoutRun = run([
  'execute-handoff',
  '--root',
  timeoutRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} slow-agent.mjs --task-file {{plan_file}}`,
  '--timeout-ms',
  '50',
  '--yes'
]);
if (timeoutRun.status === 0) {
  throw new Error(`execute-handoff timeout exited successfully\nstdout:\n${timeoutRun.stdout}\nstderr:\n${timeoutRun.stderr}`);
}
const timeoutState = await fs.readFile(path.join(timeoutRoot, '.ai-bridge', 'handoff-run-state.json'), 'utf8');
if (!timeoutState.includes('"state": "timed_out"') || !timeoutState.includes('"exit_code": null')) {
  throw new Error(`execute-handoff timeout state was wrong\n${timeoutState}`);
}

const noisyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-execute-noisy-'));
await fs.mkdir(path.join(noisyRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(noisyRoot, '.ai-bridge', 'current-plan.md'), '# Noisy plan\n\nPrint a lot, then edit.\n', 'utf8');
await fs.writeFile(path.join(noisyRoot, 'app.txt'), 'base\n', 'utf8');
await fs.writeFile(path.join(noisyRoot, 'noisy-agent.mjs'), `
import fs from 'node:fs';
console.log('x'.repeat(200000));
fs.appendFileSync('app.txt', 'after noisy output\\n');
`, 'utf8');
requireSuccess(run([
  'execute-handoff',
  '--root',
  noisyRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} noisy-agent.mjs --task-file {{plan_file}}`,
  '--max-output-bytes',
  '2048',
  '--yes'
]), 'execute-handoff noisy output');
const noisyApp = await fs.readFile(path.join(noisyRoot, 'app.txt'), 'utf8');
const noisyStatus = await fs.readFile(path.join(noisyRoot, '.ai-bridge', 'agent-status.md'), 'utf8');
if (!noisyApp.includes('after noisy output') || !noisyStatus.includes('[output truncated to 4000 bytes]')) {
  throw new Error(`execute-handoff output cap killed or failed to truncate\napp:\n${noisyApp}\nstatus:\n${noisyStatus}`);
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

const watchTimeoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-watch-timeout-'));
await fs.mkdir(path.join(watchTimeoutRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(watchTimeoutRoot, '.ai-bridge', 'current-plan.md'), '# Watch timeout\n\nSleep too long.\n', 'utf8');
await fs.writeFile(path.join(watchTimeoutRoot, 'slow-agent.mjs'), `setTimeout(() => {}, 5000);\n`, 'utf8');
const watchTimeoutRun = run([
  'watch-handoff',
  '--root',
  watchTimeoutRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} slow-agent.mjs --task-file {{plan_file}}`,
  '--once',
  '--timeout-ms',
  '50',
  '--yes',
  '--debounce-ms',
  '0'
]);
if (watchTimeoutRun.status === 0) {
  throw new Error(`watch-handoff timeout exited successfully\nstdout:\n${watchTimeoutRun.stdout}\nstderr:\n${watchTimeoutRun.stderr}`);
}
const watchTimeoutState = await fs.readFile(path.join(watchTimeoutRoot, '.ai-bridge', 'handoff-run-state.json'), 'utf8');
if (!watchTimeoutState.includes('"state": "timed_out"') || !watchTimeoutState.includes('"exit_code": null')) {
  throw new Error(`watch-handoff timeout state was wrong\n${watchTimeoutState}`);
}

const loopRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-handoff-'));
await fs.mkdir(path.join(loopRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(loopRoot, '.ai-bridge', 'current-plan.md'), '# Loop plan 1\n\nAppend loop first marker.\n', 'utf8');
await fs.writeFile(path.join(loopRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(loopRoot, 'loop-agent.mjs'), `
import fs from 'node:fs';

const taskIndex = process.argv.indexOf('--task-file');
if (taskIndex < 0) throw new Error('missing --task-file');
const plan = fs.readFileSync(process.argv[taskIndex + 1], 'utf8');
const marker = plan.includes('Loop fix plan') ? 'fix' : 'first';
fs.appendFileSync('app.txt', \`loop \${marker}\\n\`);
console.log(\`loop agent completed \${marker}\`);
`, 'utf8');
await fs.writeFile(path.join(loopRoot, 'loop-reviewer.mjs'), `
import fs from 'node:fs';

const planIndex = process.argv.indexOf('--plan-file');
const statusIndex = process.argv.indexOf('--status');
const diffIndex = process.argv.indexOf('--diff');
if (planIndex < 0 || statusIndex < 0 || diffIndex < 0) throw new Error('missing review artifacts');
const planPath = process.argv[planIndex + 1];
const plan = fs.readFileSync(planPath, 'utf8');
fs.readFileSync(process.argv[statusIndex + 1], 'utf8');
fs.readFileSync(process.argv[diffIndex + 1], 'utf8');
if (!plan.includes('Loop fix plan')) {
  fs.writeFileSync(planPath, '# Loop fix plan\\n\\nAppend loop fix marker.\\n');
  console.log('CODEXPRO_REVIEW=FAIL');
} else {
  console.log('CODEXPRO_REVIEW=PASS');
}
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: loopRoot, encoding: 'utf8' }), 'loop git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: loopRoot, encoding: 'utf8' }), 'loop git add');

const loopRun = run([
  'loop-handoff',
  '--root',
  loopRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} loop-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} loop-reviewer.mjs --status {{status_file}} --diff {{diff_file}} --log {{log_file}} --plan-file {{plan_file}}`,
  '--max-iters',
  '3',
  '--stop-if-no-files-changed',
  '--stop-if-same-diff',
  '--yes'
]);
requireSuccess(loopRun, 'loop-handoff custom');

const loopApp = await fs.readFile(path.join(loopRoot, 'app.txt'), 'utf8');
const loopReview = await fs.readFile(path.join(loopRoot, '.ai-bridge', 'loop-review.md'), 'utf8');
const loopState = await fs.readFile(path.join(loopRoot, '.ai-bridge', 'loop-handoff-state.json'), 'utf8');
const loopLog = await fs.readFile(path.join(loopRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');

if (!loopApp.includes('loop first') || !loopApp.includes('loop fix')) {
  throw new Error(`loop did not execute first and fix iterations\n${loopApp}`);
}
if (!loopReview.includes('Verdict: PASS')) {
  throw new Error(`loop review did not record PASS\n${loopReview}`);
}
if (!loopState.includes('"iteration": 2') || !loopLog.includes('"event":"loop_handoff_iteration_started"') || !loopLog.includes('"event":"loop_handoff_finished"')) {
  throw new Error(`loop did not write state/log\nstate:\n${loopState}\nlog:\n${loopLog}`);
}

const failedExecutorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-failed-executor-'));
await fs.mkdir(path.join(failedExecutorRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(failedExecutorRoot, '.ai-bridge', 'current-plan.md'), '# Failed executor plan\n\nAppend marker and fail.\n', 'utf8');
await fs.writeFile(path.join(failedExecutorRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(failedExecutorRoot, 'fail-agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed before failure\\n');
console.log('agent changed file then failed');
process.exit(2);
`, 'utf8');
await fs.writeFile(path.join(failedExecutorRoot, 'pass-reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: failedExecutorRoot, encoding: 'utf8' }), 'failed executor git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: failedExecutorRoot, encoding: 'utf8' }), 'failed executor git add');

const failedExecutorRun = run([
  'loop-handoff',
  '--root',
  failedExecutorRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} fail-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} pass-reviewer.mjs --plan-file {{plan_file}}`,
  '--yes'
]);
if (failedExecutorRun.status === 0) {
  throw new Error(`loop accepted reviewer PASS after failed executor\nstdout:\n${failedExecutorRun.stdout}\nstderr:\n${failedExecutorRun.stderr}`);
}

const failedExecutorState = await fs.readFile(path.join(failedExecutorRoot, '.ai-bridge', 'loop-handoff-state.json'), 'utf8');
const failedExecutorLog = await fs.readFile(path.join(failedExecutorRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!failedExecutorState.includes('"verdict": "FAIL"') || !failedExecutorState.includes('"rejectedPassReason": "executor_failed"') || !failedExecutorLog.includes('"stop_reason":"executor_failed"')) {
  throw new Error(`loop did not reject reviewer PASS after failed executor\nstate:\n${failedExecutorState}\nlog:\n${failedExecutorLog}`);
}

const failedReviewerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-failed-reviewer-'));
await fs.mkdir(path.join(failedReviewerRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(failedReviewerRoot, '.ai-bridge', 'current-plan.md'), '# Failed reviewer plan\n\nAppend marker.\n', 'utf8');
await fs.writeFile(path.join(failedReviewerRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(failedReviewerRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed before failed reviewer\\n');
console.log('agent changed file');
`, 'utf8');
await fs.writeFile(path.join(failedReviewerRoot, 'failed-reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
process.exit(3);
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: failedReviewerRoot, encoding: 'utf8' }), 'failed reviewer git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: failedReviewerRoot, encoding: 'utf8' }), 'failed reviewer git add');

const failedReviewerRun = run([
  'loop-handoff',
  '--root',
  failedReviewerRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} failed-reviewer.mjs --plan-file {{plan_file}}`,
  '--yes'
]);
if (failedReviewerRun.status === 0) {
  throw new Error(`loop accepted reviewer PASS after failed reviewer process\nstdout:\n${failedReviewerRun.stdout}\nstderr:\n${failedReviewerRun.stderr}`);
}
const failedReviewerState = await fs.readFile(path.join(failedReviewerRoot, '.ai-bridge', 'loop-handoff-state.json'), 'utf8');
const failedReviewerLog = await fs.readFile(path.join(failedReviewerRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!failedReviewerState.includes('"rejectedPassReason": "reviewer_failed"') || !failedReviewerLog.includes('"stop_reason":"reviewer_error"')) {
  throw new Error(`loop did not reject reviewer PASS after failed reviewer process\nstate:\n${failedReviewerState}\nlog:\n${failedReviewerLog}`);
}

const barePassRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-bare-pass-'));
await fs.mkdir(path.join(barePassRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(barePassRoot, '.ai-bridge', 'current-plan.md'), '# Bare pass plan\n\nAppend marker.\n', 'utf8');
await fs.writeFile(path.join(barePassRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(barePassRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed before bare pass\\n');
`, 'utf8');
await fs.writeFile(path.join(barePassRoot, 'bare-reviewer.mjs'), `
console.log('PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: barePassRoot, encoding: 'utf8' }), 'bare pass git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: barePassRoot, encoding: 'utf8' }), 'bare pass git add');

const barePassRun = run([
  'loop-handoff',
  '--root',
  barePassRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} bare-reviewer.mjs --plan-file {{plan_file}}`,
  '--yes'
]);
if (barePassRun.status === 0) {
  throw new Error(`loop accepted bare PASS reviewer output\nstdout:\n${barePassRun.stdout}\nstderr:\n${barePassRun.stderr}`);
}
const barePassLog = await fs.readFile(path.join(barePassRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!barePassLog.includes('"stop_reason":"unknown_verdict"')) {
  throw new Error(`loop did not reject bare PASS as unknown verdict\nlog:\n${barePassLog}`);
}

const loopStagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-staged-change-'));
await fs.mkdir(path.join(loopStagedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(loopStagedRoot, '.ai-bridge', 'current-plan.md'), '# Staged plan\n\nStage a change.\n', 'utf8');
await fs.writeFile(path.join(loopStagedRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(loopStagedRoot, 'stage-agent.mjs'), `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync('app.txt', 'staged change\\n');
const result = spawnSync('git', ['add', 'app.txt'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, 'utf8');
await fs.writeFile(path.join(loopStagedRoot, 'reviewer.mjs'), `
import fs from 'node:fs';
const diffPath = process.argv[process.argv.indexOf('--diff') + 1];
const diff = fs.readFileSync(diffPath, 'utf8');
if (!diff.includes('# Staged diff') || !diff.includes('staged change')) process.exit(4);
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: loopStagedRoot, encoding: 'utf8' }), 'staged git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: loopStagedRoot, encoding: 'utf8' }), 'staged git add');

const stagedRun = run([
  'loop-handoff',
  '--root',
  loopStagedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} stage-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --diff {{diff_file}} --plan-file {{plan_file}}`,
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(stagedRun, 'loop-handoff staged-only change');

const untrackedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-untracked-change-'));
await fs.mkdir(path.join(untrackedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(untrackedRoot, '.ai-bridge', 'current-plan.md'), '# Untracked plan\n\nCreate a new file.\n', 'utf8');
await fs.writeFile(path.join(untrackedRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(untrackedRoot, 'untracked-agent.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('new-feature.txt', 'new feature\\n');
`, 'utf8');
await fs.writeFile(path.join(untrackedRoot, 'reviewer.mjs'), `
import fs from 'node:fs';
const diffPath = process.argv[process.argv.indexOf('--diff') + 1];
const diff = fs.readFileSync(diffPath, 'utf8');
if (!diff.includes('# Untracked files') || !diff.includes('new-feature.txt')) process.exit(5);
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: untrackedRoot, encoding: 'utf8' }), 'untracked git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: untrackedRoot, encoding: 'utf8' }), 'untracked git add');

const untrackedRun = run([
  'loop-handoff',
  '--root',
  untrackedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} untracked-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --diff {{diff_file}} --plan-file {{plan_file}}`,
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(untrackedRun, 'loop-handoff untracked file change');

const boundedUntrackedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-bounded-untracked-'));
await fs.mkdir(path.join(boundedUntrackedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(boundedUntrackedRoot, '.ai-bridge', 'current-plan.md'), '# Bounded untracked plan\n\nCreate symlink and large untracked files.\n', 'utf8');
await fs.writeFile(path.join(boundedUntrackedRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(boundedUntrackedRoot, 'bounded-agent.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('large-artifact.bin', Buffer.alloc(96 * 1024, 'a'));
fs.symlinkSync('app.txt', 'app-link.txt');
`, 'utf8');
await fs.writeFile(path.join(boundedUntrackedRoot, 'reviewer.mjs'), `
import fs from 'node:fs';
const diffPath = process.argv[process.argv.indexOf('--diff') + 1];
const diff = fs.readFileSync(diffPath, 'utf8');
const linkLine = diff.split(/\\r?\\n/).find((line) => line.includes('app-link.txt'));
if (!linkLine || !linkLine.includes('(symlink, target=app.txt') || linkLine.includes('sha256')) process.exit(6);
if (!diff.includes('large-artifact.bin') || !diff.includes('sha256_first_65536=') || !diff.includes('fingerprint_truncated=true')) process.exit(7);
if (Buffer.byteLength(diff, 'utf8') > 4500) process.exit(8);
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: boundedUntrackedRoot, encoding: 'utf8' }), 'bounded untracked git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: boundedUntrackedRoot, encoding: 'utf8' }), 'bounded untracked git add');

const boundedUntrackedRun = run([
  'loop-handoff',
  '--root',
  boundedUntrackedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} bounded-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --diff {{diff_file}} --plan-file {{plan_file}}`,
  '--max-output-bytes',
  '4000',
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(boundedUntrackedRun, 'loop-handoff bounded untracked fingerprints');

const dirtyBaselineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-dirty-baseline-'));
await fs.mkdir(path.join(dirtyBaselineRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(dirtyBaselineRoot, '.ai-bridge', 'current-plan.md'), '# Dirty baseline plan\n\nDo nothing.\n', 'utf8');
await fs.writeFile(path.join(dirtyBaselineRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(dirtyBaselineRoot, 'noop-agent.mjs'), `
console.log('noop agent');
`, 'utf8');
await fs.writeFile(path.join(dirtyBaselineRoot, 'reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: dirtyBaselineRoot, encoding: 'utf8' }), 'dirty baseline git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: dirtyBaselineRoot, encoding: 'utf8' }), 'dirty baseline git add');
await fs.appendFile(path.join(dirtyBaselineRoot, 'app.txt'), 'preexisting dirty change\\n', 'utf8');

const dirtyBaselineRun = run([
  'loop-handoff',
  '--root',
  dirtyBaselineRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} noop-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--stop-if-no-files-changed',
  '--yes'
]);
if (dirtyBaselineRun.status === 0) {
  throw new Error(`loop accepted preexisting dirty baseline as executor changes\nstdout:\n${dirtyBaselineRun.stdout}\nstderr:\n${dirtyBaselineRun.stderr}`);
}
const dirtyBaselineLog = await fs.readFile(path.join(dirtyBaselineRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!dirtyBaselineLog.includes('"stop_reason":"no_files_changed"')) {
  throw new Error(`loop did not stop no-op executor against dirty baseline\nlog:\n${dirtyBaselineLog}`);
}

const repeatedSameRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-repeated-same-'));
await fs.mkdir(path.join(repeatedSameRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(repeatedSameRoot, '.ai-bridge', 'current-plan.md'), '# Repeated same plan\n\nWrite final content.\n', 'utf8');
await fs.writeFile(path.join(repeatedSameRoot, 'app.txt'), 'base\n', 'utf8');
await fs.writeFile(path.join(repeatedSameRoot, 'same-agent.mjs'), `
import fs from 'node:fs';
const markerPath = '.ai-bridge/rewrite-count.txt';
const count = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf8')) : 0;
fs.writeFileSync('app.txt', 'same final content\\n');
const stamp = new Date(1700000000000 + (count + 1) * 1000);
fs.utimesSync('app.txt', stamp, stamp);
fs.writeFileSync(markerPath, String(count + 1));
`, 'utf8');
await fs.writeFile(path.join(repeatedSameRoot, 'reviewer.mjs'), `
import fs from 'node:fs';
const planPath = process.argv[process.argv.indexOf('--plan-file') + 1];
const plan = fs.readFileSync(planPath, 'utf8');
if (plan.includes('Repeated same plan')) {
  fs.writeFileSync(planPath, '# Repeated same follow-up\\n\\nRewrite identical content.\\n');
  console.log('CODEXPRO_REVIEW=FAIL');
} else {
  console.log('CODEXPRO_REVIEW=PASS');
}
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: repeatedSameRoot, encoding: 'utf8' }), 'repeated same git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: repeatedSameRoot, encoding: 'utf8' }), 'repeated same git add');

const repeatedSameRun = run([
  'loop-handoff',
  '--root',
  repeatedSameRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} same-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--max-iters',
  '3',
  '--stop-if-no-files-changed',
  '--yes'
]);
if (repeatedSameRun.status === 0) {
  throw new Error(`loop treated repeated identical content writes as new changes\nstdout:\n${repeatedSameRun.stdout}\nstderr:\n${repeatedSameRun.stderr}`);
}
const repeatedSameLog = await fs.readFile(path.join(repeatedSameRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!repeatedSameLog.includes('"stop_reason":"no_files_changed"')) {
  throw new Error(`loop did not stop on repeated identical content write\nlog:\n${repeatedSameLog}`);
}

const subdirRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-subdir-repo-'));
const subdirRoot = path.join(subdirRepoRoot, 'packages', 'demo');
await fs.mkdir(path.join(subdirRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(subdirRoot, '.ai-bridge', 'current-plan.md'), '# Subdir plan\n\nAppend the first marker.\n', 'utf8');
await fs.writeFile(path.join(subdirRoot, 'app.txt'), 'base\n', 'utf8');
await fs.writeFile(path.join(subdirRoot, 'agent.mjs'), `
import fs from 'node:fs';
const planPath = process.argv[process.argv.indexOf('--task-file') + 1];
const plan = fs.readFileSync(planPath, 'utf8');
fs.appendFileSync('app.txt', plan.includes('second marker') ? 'second subdir change\\n' : 'first subdir change\\n');
`, 'utf8');
await fs.writeFile(path.join(subdirRoot, 'reviewer.mjs'), `
import fs from 'node:fs';
const planPath = process.argv[process.argv.indexOf('--plan-file') + 1];
const app = fs.readFileSync('app.txt', 'utf8');
if (app.includes('second subdir change')) {
  console.log('CODEXPRO_REVIEW=PASS');
} else if (app.includes('first subdir change')) {
  fs.writeFileSync(planPath, '# Subdir follow-up\\n\\nAppend the second marker.\\n');
  console.log('CODEXPRO_REVIEW=FAIL');
} else {
  process.exit(9);
}
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: subdirRepoRoot, encoding: 'utf8' }), 'subdir repo git init');
requireSuccess(spawnSync('git', ['add', 'packages/demo/app.txt', 'packages/demo/agent.mjs', 'packages/demo/reviewer.mjs'], { cwd: subdirRepoRoot, encoding: 'utf8' }), 'subdir repo git add');
requireSuccess(spawnSync('git', ['-c', 'user.email=codexpro@example.invalid', '-c', 'user.name=CodexPro Smoke', 'commit', '-m', 'init'], { cwd: subdirRepoRoot, encoding: 'utf8' }), 'subdir repo git commit');

const subdirRun = run([
  'loop-handoff',
  '--root',
  subdirRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--max-iters',
  '2',
  '--require-clean-git-start',
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(subdirRun, 'loop-handoff workspace nested below git top-level');

const subdirUntrackedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-subdir-untracked-'));
const subdirUntrackedRoot = path.join(subdirUntrackedRepoRoot, 'packages', 'demo');
await fs.mkdir(path.join(subdirUntrackedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(subdirUntrackedRoot, '.ai-bridge', 'current-plan.md'), '# Untracked subdir plan\n\nShould not start.\n', 'utf8');
await fs.writeFile(path.join(subdirUntrackedRoot, 'app.txt'), 'untracked workspace file\n', 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: subdirUntrackedRepoRoot, encoding: 'utf8' }), 'subdir untracked repo git init');

const subdirUntrackedRun = run([
  'loop-handoff',
  '--root',
  subdirUntrackedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} -e "process.exit(0)" --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} -e "console.log('CODEXPRO_REVIEW=PASS')" --plan-file {{plan_file}}`,
  '--require-clean-git-start',
  '--yes'
]);
if (subdirUntrackedRun.status === 0) {
  throw new Error(`loop accepted untracked files under a nested workspace as clean\nstdout:\n${subdirUntrackedRun.stdout}\nstderr:\n${subdirUntrackedRun.stderr}`);
}
if (!subdirUntrackedRun.stderr.includes('--require-clean-git-start refused') || !subdirUntrackedRun.stderr.includes('app.txt')) {
  throw new Error(`loop did not report nested untracked workspace file\nstdout:\n${subdirUntrackedRun.stdout}\nstderr:\n${subdirUntrackedRun.stderr}`);
}

const subdirOutsideUntrackedRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-subdir-outside-untracked-'));
const subdirOutsideUntrackedRoot = path.join(subdirOutsideUntrackedRepoRoot, 'packages', 'demo');
await fs.mkdir(path.join(subdirOutsideUntrackedRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(subdirOutsideUntrackedRoot, '.ai-bridge', 'current-plan.md'), '# Outside untracked plan\n\nAppend a marker.\n', 'utf8');
await fs.writeFile(path.join(subdirOutsideUntrackedRoot, 'app.txt'), 'base\n', 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: subdirOutsideUntrackedRepoRoot, encoding: 'utf8' }), 'subdir outside untracked repo git init');
requireSuccess(spawnSync('git', ['add', 'packages/demo/app.txt'], { cwd: subdirOutsideUntrackedRepoRoot, encoding: 'utf8' }), 'subdir outside untracked repo git add');
requireSuccess(spawnSync('git', ['-c', 'user.email=codexpro@example.invalid', '-c', 'user.name=CodexPro Smoke', 'commit', '-m', 'init'], { cwd: subdirOutsideUntrackedRepoRoot, encoding: 'utf8' }), 'subdir outside untracked repo git commit');
const outsideGeneratedDir = path.join(
  subdirOutsideUntrackedRepoRoot,
  'packages',
  'generated',
  'x'.repeat(170),
  'y'.repeat(170),
  'z'.repeat(170)
);
await fs.mkdir(outsideGeneratedDir, { recursive: true });
const outsideFileSuffix = 'a'.repeat(110);
for (let index = 0; index < 1800; index += 1) {
  await fs.writeFile(path.join(outsideGeneratedDir, `${String(index).padStart(4, '0')}-${outsideFileSuffix}.txt`), 'outside workspace\n', 'utf8');
}
const subdirOutsideUntrackedRun = run([
  'loop-handoff',
  '--root',
  subdirOutsideUntrackedRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} -e "require('node:fs').appendFileSync('app.txt', 'workspace change\\n')" -- --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} -e "console.log('CODEXPRO_REVIEW=PASS')" -- --plan-file {{plan_file}}`,
  '--require-clean-git-start',
  '--yes'
]);
requireSuccess(subdirOutsideUntrackedRun, 'loop-handoff ignores large untracked tree outside nested workspace');

const largeDirtyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-large-dirty-'));
await fs.mkdir(path.join(largeDirtyRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(largeDirtyRoot, '.ai-bridge', 'current-plan.md'), '# Large dirty plan\n\nAppend to later file.\n', 'utf8');
await fs.writeFile(path.join(largeDirtyRoot, 'aaa-large.txt'), 'base large\n', 'utf8');
await fs.writeFile(path.join(largeDirtyRoot, 'zzz-later.txt'), 'base later\n', 'utf8');
await fs.writeFile(path.join(largeDirtyRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('zzz-later.txt', 'executor changed later file\\n');
`, 'utf8');
await fs.writeFile(path.join(largeDirtyRoot, 'reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: largeDirtyRoot, encoding: 'utf8' }), 'large dirty git init');
requireSuccess(spawnSync('git', ['add', 'aaa-large.txt', 'zzz-later.txt'], { cwd: largeDirtyRoot, encoding: 'utf8' }), 'large dirty git add');
requireSuccess(spawnSync('git', ['-c', 'user.email=codexpro@example.invalid', '-c', 'user.name=CodexPro Smoke', 'commit', '-m', 'init'], { cwd: largeDirtyRoot, encoding: 'utf8' }), 'large dirty git commit');
await fs.writeFile(path.join(largeDirtyRoot, 'aaa-large.txt'), `${'preexisting dirty line\n'.repeat(9000)}`, 'utf8');

const largeDirtyRun = run([
  'loop-handoff',
  '--root',
  largeDirtyRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--max-output-bytes',
  '4000',
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(largeDirtyRun, 'loop-handoff large dirty baseline with later executor change');

const unavailableDiffRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-unavailable-diff-'));
await fs.mkdir(path.join(unavailableDiffRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(unavailableDiffRoot, '.ai-bridge', 'current-plan.md'), '# Unavailable diff plan\n\nWrite a very large tracked diff.\n', 'utf8');
await fs.writeFile(path.join(unavailableDiffRoot, 'huge.txt'), 'base\n', 'utf8');
await fs.writeFile(path.join(unavailableDiffRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('huge.txt', \`changed\\n\${'x'.repeat(2_500_000)}\\n\`);
`, 'utf8');
await fs.writeFile(path.join(unavailableDiffRoot, 'reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: unavailableDiffRoot, encoding: 'utf8' }), 'unavailable diff git init');
requireSuccess(spawnSync('git', ['add', 'huge.txt'], { cwd: unavailableDiffRoot, encoding: 'utf8' }), 'unavailable diff git add');

const unavailableDiffRun = run([
  'loop-handoff',
  '--root',
  unavailableDiffRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--max-output-bytes',
  '4000',
  '--stop-if-no-files-changed',
  '--yes'
]);
requireSuccess(unavailableDiffRun, 'loop-handoff unavailable diff artifact with real executor change');
const unavailableDiffArtifact = await fs.readFile(path.join(unavailableDiffRoot, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
if (!unavailableDiffArtifact.includes('# git changes unavailable')) {
  throw new Error(`unavailable diff smoke did not exercise the bounded diff artifact path\n${unavailableDiffArtifact.slice(0, 1000)}`);
}

const largePlanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-large-plan-'));
const largePlanText = `# Large accepted plan\n\n${'Keep this valid plan above the output cap.\n'.repeat(160)}`;
if (Buffer.byteLength(largePlanText, 'utf8') <= 4000) throw new Error('large plan smoke fixture is not larger than max-output cap');
await fs.mkdir(path.join(largePlanRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(largePlanRoot, '.ai-bridge', 'current-plan.md'), largePlanText, 'utf8');
await fs.writeFile(path.join(largePlanRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(largePlanRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed with large plan\\n');
`, 'utf8');
await fs.writeFile(path.join(largePlanRoot, 'reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: largePlanRoot, encoding: 'utf8' }), 'large plan git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: largePlanRoot, encoding: 'utf8' }), 'large plan git add');

const largePlanRun = run([
  'loop-handoff',
  '--root',
  largePlanRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--max-output-bytes',
  '4000',
  '--yes'
]);
requireSuccess(largePlanRun, 'loop-handoff valid plan larger than output cap');

const stagedRenameRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-staged-rename-'));
await fs.mkdir(path.join(stagedRenameRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(stagedRenameRoot, '.ai-bridge', 'current-plan.md'), '# Staged rename plan\n\nNo-op.\n', 'utf8');
await fs.writeFile(path.join(stagedRenameRoot, 'src.txt'), 'tracked source\n', 'utf8');
await fs.writeFile(path.join(stagedRenameRoot, 'noop-agent.mjs'), `
console.log('noop agent');
`, 'utf8');
await fs.writeFile(path.join(stagedRenameRoot, 'reviewer.mjs'), `
console.log('CODEXPRO_REVIEW=PASS');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: stagedRenameRoot, encoding: 'utf8' }), 'staged rename git init');
requireSuccess(spawnSync('git', ['add', 'src.txt'], { cwd: stagedRenameRoot, encoding: 'utf8' }), 'staged rename git add');
requireSuccess(spawnSync('git', ['-c', 'user.email=codexpro@example.invalid', '-c', 'user.name=CodexPro Smoke', 'commit', '-m', 'init'], { cwd: stagedRenameRoot, encoding: 'utf8' }), 'staged rename git commit');
requireSuccess(spawnSync('git', ['mv', 'src.txt', '.ai-bridge/src.txt'], { cwd: stagedRenameRoot, encoding: 'utf8' }), 'staged rename git mv');

const stagedRenameRun = run([
  'loop-handoff',
  '--root',
  stagedRenameRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} noop-agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} reviewer.mjs --plan-file {{plan_file}}`,
  '--require-clean-git-start',
  '--yes'
]);
if (stagedRenameRun.status === 0) {
  throw new Error(`loop accepted staged rename from outside into .ai-bridge as clean\nstdout:\n${stagedRenameRun.stdout}\nstderr:\n${stagedRenameRun.stderr}`);
}
if (!stagedRenameRun.stderr.includes('--require-clean-git-start refused') || !stagedRenameRun.stderr.includes('src.txt -> .ai-bridge/src.txt')) {
  throw new Error(`loop did not report staged rename as non-handoff change\nstdout:\n${stagedRenameRun.stdout}\nstderr:\n${stagedRenameRun.stderr}`);
}

const deletedPlanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-deleted-followup-'));
await fs.mkdir(path.join(deletedPlanRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(deletedPlanRoot, '.ai-bridge', 'current-plan.md'), '# Delete follow-up plan\n\nAppend marker.\n', 'utf8');
await fs.writeFile(path.join(deletedPlanRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(deletedPlanRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed before deleted follow-up\\n');
`, 'utf8');
await fs.writeFile(path.join(deletedPlanRoot, 'delete-plan-reviewer.mjs'), `
import fs from 'node:fs';
const planPath = process.argv[process.argv.indexOf('--plan-file') + 1];
fs.rmSync(planPath);
console.log('CODEXPRO_REVIEW=FAIL');
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: deletedPlanRoot, encoding: 'utf8' }), 'deleted plan git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: deletedPlanRoot, encoding: 'utf8' }), 'deleted plan git add');

const deletedPlanRun = run([
  'loop-handoff',
  '--root',
  deletedPlanRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} delete-plan-reviewer.mjs --plan-file {{plan_file}}`,
  '--yes'
]);
if (deletedPlanRun.status === 0) {
  throw new Error(`loop accepted deleted follow-up plan after reviewer FAIL\nstdout:\n${deletedPlanRun.stdout}\nstderr:\n${deletedPlanRun.stderr}`);
}
const deletedPlanState = await fs.readFile(path.join(deletedPlanRoot, '.ai-bridge', 'loop-handoff-state.json'), 'utf8');
const deletedPlanLog = await fs.readFile(path.join(deletedPlanRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!deletedPlanState.includes('"followupPlanExists": false') || !deletedPlanState.includes('"hasUsableFollowupPlan": false') || !deletedPlanLog.includes('"stop_reason":"no_followup_plan"')) {
  throw new Error(`loop did not stop cleanly after deleted follow-up plan\nstate:\n${deletedPlanState}\nlog:\n${deletedPlanLog}`);
}

const implicitDeletedPlanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-loop-implicit-deleted-plan-'));
await fs.mkdir(path.join(implicitDeletedPlanRoot, '.ai-bridge'), { recursive: true });
await fs.writeFile(path.join(implicitDeletedPlanRoot, '.ai-bridge', 'current-plan.md'), '# Implicit delete plan\n\nAppend marker.\n', 'utf8');
await fs.writeFile(path.join(implicitDeletedPlanRoot, 'app.txt'), 'start\n', 'utf8');
await fs.writeFile(path.join(implicitDeletedPlanRoot, 'agent.mjs'), `
import fs from 'node:fs';
fs.appendFileSync('app.txt', 'changed before implicit deleted plan\\n');
`, 'utf8');
await fs.writeFile(path.join(implicitDeletedPlanRoot, 'delete-plan-reviewer.mjs'), `
import fs from 'node:fs';
const planPath = process.argv[process.argv.indexOf('--plan-file') + 1];
fs.rmSync(planPath);
`, 'utf8');
requireSuccess(spawnSync('git', ['init'], { cwd: implicitDeletedPlanRoot, encoding: 'utf8' }), 'implicit deleted plan git init');
requireSuccess(spawnSync('git', ['add', 'app.txt'], { cwd: implicitDeletedPlanRoot, encoding: 'utf8' }), 'implicit deleted plan git add');

const implicitDeletedPlanRun = run([
  'loop-handoff',
  '--root',
  implicitDeletedPlanRoot,
  '--agent',
  'custom',
  '--command',
  `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
  '--review-command',
  `${quoteArg(process.execPath)} delete-plan-reviewer.mjs --plan-file {{plan_file}}`,
  '--allow-implicit-review-verdict',
  '--yes'
]);
if (implicitDeletedPlanRun.status === 0) {
  throw new Error(`loop inferred PASS after reviewer deleted the plan\nstdout:\n${implicitDeletedPlanRun.stdout}\nstderr:\n${implicitDeletedPlanRun.stderr}`);
}
const implicitDeletedPlanState = await fs.readFile(path.join(implicitDeletedPlanRoot, '.ai-bridge', 'loop-handoff-state.json'), 'utf8');
const implicitDeletedPlanLog = await fs.readFile(path.join(implicitDeletedPlanRoot, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
if (!implicitDeletedPlanState.includes('"nextPlanChanged": true') || !implicitDeletedPlanState.includes('"followupPlanExists": false') || !implicitDeletedPlanLog.includes('"stop_reason":"no_followup_plan"')) {
  throw new Error(`loop did not fail closed after implicit reviewer deleted the plan\nstate:\n${implicitDeletedPlanState}\nlog:\n${implicitDeletedPlanLog}`);
}

console.log('✓ execute-handoff, watch-handoff, and loop-handoff smoke test passed');
