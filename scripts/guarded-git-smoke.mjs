import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';
import { commit, createBranch, createPullRequest, currentState, push, stagePaths, unstagePaths } from '../dist/guardedGit.js';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function config(root, writeMode = 'workspace') {
  return { defaultRoot: root, allowedRoots: [root], blockedGlobs: ['.git', '.git/**', '**/.git/**', '.env', '.env.*', '**/*.key'], maxOutputBytes: 120000, writeMode, gitWrite: true, gitPush: true, githubPr: true, handoffGitWrite: true, handoffGitPush: true, handoffGithubPr: true, handoffGitAllowedPaths: ['.ai-bridge/**'], protectedBranches: ['main', 'master', 'develop', 'development', 'production', 'prod', 'release', 'staging'] };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-guarded-git-'));
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-guarded-git-remote-'));
  git(remote, ['init', '--bare']); git(root, ['init', '-b', 'main']); git(root, ['config', 'user.email', 'smoke@example.com']); git(root, ['config', 'user.name', 'Smoke']);
  await fs.writeFile(path.join(root, 'one.txt'), 'one\n'); await fs.writeFile(path.join(root, 'two.txt'), 'two\n'); await fs.mkdir(path.join(root, '.ai-bridge')); await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), 'plan\n');
  git(root, ['add', 'one.txt', 'two.txt', '.ai-bridge/current-plan.md']); git(root, ['commit', '-m', 'initial']); git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-u', 'origin', 'main']);
  return { root: await fs.realpath(root), remote: await fs.realpath(remote) };
}
async function workspace(root, cfg) { return new WorkspaceManager(cfg).defaultWorkspace(); }
function rejects(fn, text) { assert.throws(fn, new RegExp(text)); }

const { root } = await fixture();
const agent = config(root); const guard = new PathGuard(agent); const ws = await workspace(root, agent);
assert.equal(currentState(agent, ws).branch, 'main');
rejects(() => createBranch(agent, ws, 'main'), 'Protected');
createBranch(agent, ws, 'feat/safe');
await fs.writeFile(path.join(root, 'one.txt'), 'changed\n'); await fs.writeFile(path.join(root, 'two.txt'), 'other\n');
rejects(() => stagePaths(agent, guard, ws, ['.']), 'explicit');
rejects(() => stagePaths(agent, guard, ws, ['../escape']), 'workspace|Path');
stagePaths(agent, guard, ws, ['one.txt']);
assert.deepEqual(currentState(agent, ws).staged_files, ['one.txt']);
unstagePaths(agent, guard, ws, ['one.txt']); assert.deepEqual(currentState(agent, ws).staged_files, []);
stagePaths(agent, guard, ws, ['one.txt']); const before = currentState(agent, ws); const committed = commit(agent, ws, 'test: explicit stage', before.branch, before.head, true);
assert.equal(committed.branch, 'feat/safe'); assert.deepEqual(committed.committed_files, ['one.txt']); assert.ok(currentState(agent, ws).unstaged_files.includes('two.txt'));
const pushed = push(agent, ws, 'origin', 'feat/safe', currentState(agent, ws).head, true); assert.equal(pushed.upstream, 'origin/feat/safe');
rejects(() => push(agent, ws, 'https://bad.example', 'feat/safe', currentState(agent, ws).head, true), 'Remote');

const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-gh-mock-'));
await fs.writeFile(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$2" = "list" ]; then echo "[]"; else echo "https://github.example.test/pr/1"; fi\n'); await fs.chmod(path.join(bin, 'gh'), 0o755);
const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
const pr = createPullRequest(agent, ws, 'Draft', 'body', 'main', undefined, 'feat/safe', currentState(agent, ws).head, true); assert.equal(pr.draft, true); assert.match(pr.url, /pr\/1/); process.env.PATH = oldPath;

const handoff = config(root, 'handoff'); const handoffGuard = new PathGuard(handoff); const handoffWs = await workspace(root, handoff);
rejects(() => stagePaths(handoff, handoffGuard, handoffWs, ['two.txt']), 'allowlist');
await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), 'updated plan\n');
stagePaths(handoff, handoffGuard, handoffWs, ['.ai-bridge/current-plan.md']); git(root, ['add', 'two.txt']);
rejects(() => commit(handoff, handoffWs, 'docs: plan', 'feat/safe', currentState(handoff, handoffWs).head, true), 'outside allowlist');
git(root, ['restore', '--staged', 'two.txt']); commit(handoff, handoffWs, 'docs: plan', 'feat/safe', currentState(handoff, handoffWs).head, true);
console.log('✓ guarded git smoke passed');
