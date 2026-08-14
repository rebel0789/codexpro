import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  approveGoal,
  getGoal,
  listGoals,
  proposeGoal,
  publishGoalBlackboard
} from '../dist/goalOps.js';
import { GoalStore } from '../dist/goalStore.js';
import { createGoalContentPolicySnapshot, isGoalPathContentAllowed } from '../dist/goalPolicy.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0'
    }
  }).trim();
}

async function expectReject(promise, pattern) {
  await assert.rejects(promise, pattern);
}

const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-goal-core-')));
try {
  const sourceRoot = path.join(fixture, 'source');
  const dataRoot = path.join(fixture, 'state');
  await fs.mkdir(sourceRoot);
  git(sourceRoot, ['init', '-q']);
  git(sourceRoot, ['config', 'user.name', 'Goal Smoke']);
  git(sourceRoot, ['config', 'user.email', 'goal-smoke@example.invalid']);
  await fs.writeFile(path.join(sourceRoot, 'app.txt'), 'base\n', 'utf8');
  git(sourceRoot, ['add', '--', 'app.txt']);
  git(sourceRoot, ['commit', '-qm', 'base']);
  const baseSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(sourceRoot, 'app.txt'), 'pre-existing source edit\n', 'utf8');
  await fs.writeFile(path.join(sourceRoot, 'notes.txt'), 'untracked source note\n', 'utf8');
  const sourceStatus = git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);

  const config = { dataRoot };
  const alternateDataRoot = path.join(fixture, 'alternate-state');
  const guard = {
    assertSourceWorkspace(root) {
      assert.equal(root, sourceRoot);
    }
  };
  let activeSourceLocks = 0;
  let maximumSourceLocks = 0;
  const lockOperation = (store) => store.withSourceLock(sourceRoot, git(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']), async () => {
    activeSourceLocks += 1;
    maximumSourceLocks = Math.max(maximumSourceLocks, activeSourceLocks);
    await new Promise((resolve) => setTimeout(resolve, 75));
    activeSourceLocks -= 1;
  });
  await Promise.all([lockOperation(new GoalStore(config)), lockOperation(new GoalStore({ dataRoot: alternateDataRoot }))]);
  assert.equal(maximumSourceLocks, 1, 'same repository must serialize source effects across different Goal data roots');
  const input = {
    goalKey: 'parallel-auth-hardening-v1',
    title: 'Harden authentication boundaries',
    goal: 'Implement and verify the approved authentication hardening plan.',
    exclusions: ['No dependency upgrades'],
    completionCriteria: ['All three work items satisfy their acceptance criteria', 'Whole-repository verification passes'],
    verification: ['npm test', 'git diff --check'],
    executionPolicy: 'supervised',
    workspacePolicy: 'isolated',
    workerModel: 'gpt-5.6-sol',
    workerEffort: 'high',
    limits: {
      maxConcurrency: 2,
      timeoutMs: 3_600_000,
      maxTurnsPerWorker: 1,
      maxRetriesPerWorker: 0,
      maxLogBytes: 1_048_576
    },
    permissions: {
      fileGlobs: ['src/**', 'test/**'],
      commands: ['npm test', 'git diff --check'],
      network: false,
      sourceEffects: { apply: false, commit: false, push: false, draftPr: false }
    },
    baseSha,
    work: [
      {
        workId: 'work_contract',
        title: 'Define session contract',
        goal: 'Harden the session boundary contract.',
        acceptanceCriteria: ['Boundary behavior is explicit'],
        verification: ['npm test -- session'],
        dependsOn: [],
        parallelGroup: 'foundation',
        fileGlobs: ['src/session/**']
      },
      {
        workId: 'work_tests',
        title: 'Add adversarial tests',
        goal: 'Cover invalid and expired sessions.',
        acceptanceCriteria: ['Expired sessions are rejected'],
        verification: ['npm test -- auth'],
        dependsOn: [],
        parallelGroup: 'foundation',
        fileGlobs: ['test/auth/**']
      },
      {
        workId: 'work_integration',
        title: 'Integrate the boundary',
        goal: 'Integrate the contract and tests.',
        acceptanceCriteria: ['The combined behavior passes'],
        verification: ['npm test'],
        dependsOn: ['work_contract', 'work_tests'],
        fileGlobs: ['src/**', 'test/**']
      }
    ]
  };

  const proposed = await proposeGoal(config, { root: sourceRoot }, guard, input);
  assert.equal(proposed.reused, false);
  assert.equal(proposed.goal.lifecycle, 'proposed');
  assert.equal(proposed.goal.approval.status, 'pending');
  assert.equal(proposed.goal.revision, 1);
  assert.equal(proposed.goal.sourceUncommittedChangesIncluded, false);
  assert.equal(proposed.goal.sourceDirtyAtCreation, true);
  assert.equal(proposed.goal.work.length, 3);
  assert.equal(await fs.stat(proposed.goal.integrationWorktreeRoot).then(() => true, () => false), false);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatus);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dataRoot)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'goals'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'goal-worktrees'))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(dataRoot, 'goals', proposed.goal.goalId))).mode & 0o777, 0o700);
  }

  const reused = await proposeGoal(config, { root: sourceRoot }, guard, input);
  assert.equal(reused.reused, true);
  assert.equal(reused.goal.revision, 1);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, { ...input, title: 'Different binding' }), /different contract/);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'cycle-v1',
    work: [
      { ...input.work[0], workId: 'work_a', dependsOn: ['work_b'] },
      { ...input.work[1], workId: 'work_b', dependsOn: ['work_a'] }
    ]
  }), /cycle/);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'network-v1',
    permissions: { ...input.permissions, network: true }
  }), /network access is not supported/);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'persistent-v1',
    executionPolicy: 'persistent'
  }), /content-policy snapshot/);
  const persistentPolicy = createGoalContentPolicySnapshot(['**/.env', '**/*.pem']);
  assert.equal(isGoalPathContentAllowed(persistentPolicy, 'src/.ENV'), false);
  assert.equal(isGoalPathContentAllowed(persistentPolicy, 'keys/SECRET.PEM'), false);
  const persistent = await proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'persistent-valid-v1',
    executionPolicy: 'persistent',
    contentPolicy: persistentPolicy,
    permissions: { ...input.permissions, commands: [], sourceEffects: { apply: false, commit: false, push: false, draftPr: false } }
  });
  assert.equal(persistent.goal.executionPolicy, 'persistent');
  assert.equal(persistent.goal.contentPolicy.fingerprint, persistentPolicy.fingerprint);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'persistent-live-v1', executionPolicy: 'persistent', workspacePolicy: 'live', contentPolicy: persistentPolicy,
    permissions: { ...input.permissions, commands: [], sourceEffects: { apply: false, commit: false, push: false, draftPr: false } }
  }), /requires an isolated/);
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'live-without-apply-v1',
    workspacePolicy: 'live'
  }), /requires the existing sourceEffects.apply permission/);
  const liveProposed = await proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'live-contract-v1',
    workspacePolicy: 'live',
    permissions: { ...input.permissions, sourceEffects: { ...input.permissions.sourceEffects, apply: true } }
  });
  assert.deepEqual(liveProposed.goal.live, { projectedIntegrationSha: baseSha, projections: [] });
  await expectReject(proposeGoal(config, { root: sourceRoot }, guard, {
    ...input,
    goalKey: 'automatic-retry-v1',
    limits: { ...input.limits, maxRetriesPerWorker: 1 }
  }), /one-turn contract|retry/i);

  await expectReject(approveGoal(config, proposed.goal.goalId, {
    expectedRevision: 1,
    contractFingerprint: '0'.repeat(64),
    approvalKey: 'approval-v1'
  }), /fingerprint changed/);
  const approved = await approveGoal(config, proposed.goal.goalId, {
    expectedRevision: 1,
    contractFingerprint: proposed.goal.contractFingerprint,
    approvalKey: 'approval-v1'
  });
  assert.equal(approved.lifecycle, 'approved');
  assert.equal(approved.revision, 2);
  const approvalRetry = await approveGoal(config, proposed.goal.goalId, {
    expectedRevision: 1,
    contractFingerprint: proposed.goal.contractFingerprint,
    approvalKey: 'approval-v1'
  });
  assert.equal(approvalRetry.revision, 2);

  await expectReject(publishGoalBlackboard(config, approved.goalId, {
    expectedRevision: 2,
    recordKey: 'worker-decision-v1',
    kind: 'decision',
    author: 'worker:work_contract',
    workId: 'work_contract',
    summary: 'Worker attempted to change the plan.'
  }), /Only Pro/);
  const published = await publishGoalBlackboard(config, approved.goalId, {
    expectedRevision: 2,
    recordKey: 'contract-discovery-v1',
    kind: 'contract',
    author: 'worker:work_contract',
    workId: 'work_contract',
    summary: 'Session validation must remain at the request boundary.',
    evidence: ['Existing callers rely on a single validation entry point.'],
    paths: ['src/session/validate.ts']
  });
  assert.equal(published.reused, false);
  assert.equal(published.goal.revision, 3);
  assert.equal(published.record.author, 'worker:work_contract');
  const publishRetry = await publishGoalBlackboard(config, approved.goalId, {
    expectedRevision: 2,
    recordKey: 'contract-discovery-v1',
    kind: 'contract',
    author: 'worker:work_contract',
    workId: 'work_contract',
    summary: 'Session validation must remain at the request boundary.',
    evidence: ['Existing callers rely on a single validation entry point.'],
    paths: ['src/session/validate.ts']
  });
  assert.equal(publishRetry.reused, true);
  assert.equal(publishRetry.goal.revision, 3);
  await expectReject(publishGoalBlackboard(config, approved.goalId, {
    expectedRevision: 3,
    recordKey: 'contract-discovery-v1',
    kind: 'contract',
    author: 'worker:work_contract',
    workId: 'work_contract',
    summary: 'Changed content'
  }), /different content/);

  const restarted = await getGoal(config, proposed.goal.goalId);
  assert.equal(restarted.revision, 3);
  assert.equal(restarted.blackboard.length, 1);
  assert.equal((await listGoals(config)).at(0)?.goalId, proposed.goal.goalId);
  const hiddenSourceRoot = path.join(fixture, 'not-allowed-source');
  const store = new GoalStore(config);
  for (let index = 0; index < 25; index += 1) {
    const hiddenGoalId = `goal_${(0xdef000 + index).toString(16).padStart(24, '0')}`;
    await store.withGoalLock(hiddenGoalId, async () => {
      await store.writeLocked({
        ...restarted,
        goalId: hiddenGoalId,
        goalKey: `newer-hidden-goal-${index}`,
        title: `Newer hidden Goal ${index}`,
        sourceRoot: hiddenSourceRoot,
        integrationWorktreeRoot: store.paths(hiddenGoalId).integrationWorktreeRoot,
        updatedAt: new Date(Date.now() + index + 1).toISOString()
      });
    });
  }
  const allowedOnly = await listGoals(config, { allowedSourceRoots: [sourceRoot], limit: 1 });
  assert.equal(allowedOnly.length, 1, 'newer disallowed Goals must not consume the requested list limit');
  assert.equal(allowedOnly[0].sourceRoot, sourceRoot);
  assert.equal(git(sourceRoot, ['rev-parse', 'HEAD']), baseSha);
  assert.equal(git(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']), sourceStatus);

  console.log('goal core smoke: ok');
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}
