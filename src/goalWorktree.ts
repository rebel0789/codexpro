import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { secureCodingTaskDirectory } from "./codingTaskStore.js";
import { assertCodingTaskWorktree, reviewCodingTaskWorktree, type CodingTaskReviewContentPolicy, type CodingTaskReviewSnapshot } from "./codingTaskWorktree.js";
import type { GoalState } from "./goalState.js";

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: path.join(os.tmpdir(), "codexpro-disabled-git-hooks")
  };
}

async function runGit(cwd: string, args: string[], options: { input?: string; maxBytes?: number } = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnvironment(), shell: false, windowsHide: true, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflow = true;
        child.kill();
      } else target.push(chunk);
    };
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (overflow) return reject(new Error(`Goal Git output exceeded ${maxBytes} bytes.`));
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(new Error(`Goal Git ${args[0] ?? "command"} failed (${code ?? signal}): ${err || out}`));
      resolve(out);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

async function gitSucceeds(cwd: string, args: string[], input: string, maxBytes: number): Promise<boolean> {
  try {
    await runGit(cwd, args, { input, maxBytes });
    return true;
  } catch {
    return false;
  }
}

function identity(goal: GoalState) {
  return {
    sourceRoot: goal.sourceRoot,
    commonDir: goal.sourceGitCommonDir,
    baseSha: goal.baseSha,
    sourceDirty: goal.sourceDirtyAtCreation,
    sourceStatusEntryCount: goal.sourceStatusEntryCountAtCreation
  };
}

export async function ensureGoalIntegrationWorktree(goal: GoalState): Promise<string> {
  const root = path.resolve(goal.integrationWorktreeRoot);
  const parent = path.dirname(root);
  const parentReal = await fsp.realpath(parent);
  if (parentReal !== parent) throw new Error(`Goal worktree parent must be canonical: ${parentReal}`);
  await secureCodingTaskDirectory(parent, "Goal worktree parent");
  const existing = await fsp.lstat(root).catch(() => undefined);
  if (!existing) {
    await runGit(goal.sourceRoot, ["worktree", "add", "--detach", root, goal.baseSha]);
  } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`Goal integration worktree must be a real directory: ${root}`);
  }
  await secureCodingTaskDirectory(root, "Goal integration worktree");
  await assertCodingTaskWorktree(identity(goal), root);
  return root;
}

export async function getGoalIntegrationHead(goal: GoalState): Promise<string> {
  const root = await ensureGoalIntegrationWorktree(goal);
  return (await runGit(root, ["rev-parse", "HEAD"])).toLowerCase();
}

export async function reviewGoalIntegration(
  goal: GoalState,
  options: { maxOutputBytes?: number; contentPolicy?: CodingTaskReviewContentPolicy } = {}
): Promise<CodingTaskReviewSnapshot> {
  const root = path.resolve(goal.integrationWorktreeRoot);
  const stat = await fsp.lstat(root).catch(() => undefined);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Goal integration worktree does not exist; start the approved Goal before review.");
  await assertCodingTaskWorktree(identity(goal), root);
  return reviewCodingTaskWorktree(identity(goal), root, options);
}

export async function verifyGoalIntegrationDiff(
  goal: GoalState,
  expectedHeadSha: string,
  maxOutputBytes = 4 * 1024 * 1024
): Promise<{ command: "git diff --check"; status: "passed"; baseSha: string; headSha: string; output: string }> {
  const root = path.resolve(goal.integrationWorktreeRoot);
  await assertCodingTaskWorktree(identity(goal), root);
  const headSha = (await runGit(root, ["rev-parse", "HEAD"], { maxBytes: maxOutputBytes })).toLowerCase();
  if (headSha !== expectedHeadSha) throw new Error(`Goal integration HEAD changed during review: expected ${expectedHeadSha}, found ${headSha}.`);
  const output = await runGit(root, ["diff", "--check", goal.baseSha, "HEAD", "--"], { maxBytes: maxOutputBytes });
  return { command: "git diff --check", status: "passed", baseSha: goal.baseSha, headSha, output };
}

export async function applyGoalWorkerPatch(
  goal: GoalState,
  workId: string,
  diffSha256: string,
  patch: string,
  maxOutputBytes = 4 * 1024 * 1024
): Promise<{ beforeHead: string; commitSha: string }> {
  if (!patch.trim()) throw new Error(`Goal work ${workId} produced no patch to integrate.`);
  const root = await ensureGoalIntegrationWorktree(goal);
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], { maxBytes: maxOutputBytes });
  if (status) throw new Error("Goal integration worktree is not clean; resolve the persisted integration state before continuing.");
  const beforeHead = (await runGit(root, ["rev-parse", "HEAD"])).toLowerCase();
  const patchInput = patch.endsWith("\n") ? patch : `${patch}\n`;
  await runGit(root, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patchInput, maxBytes: maxOutputBytes });
  await runGit(root, ["apply", "--index", "--binary", "--whitespace=nowarn", "-"], { input: patchInput, maxBytes: maxOutputBytes });
  await runGit(root, [
    "-c", "user.name=CodexPro Goal",
    "-c", "user.email=goal@codexpro.local",
    "-c", `core.hooksPath=${path.join(os.tmpdir(), "codexpro-disabled-git-hooks")}`,
    "commit", "--no-gpg-sign", "-m", `CodexPro Goal checkpoint: ${workId}`,
    "-m", `CodexPro-Goal: ${goal.goalId}\nCodexPro-Work: ${workId}\nCodexPro-Diff: ${diffSha256}`
  ], { maxBytes: maxOutputBytes });
  const commitSha = (await runGit(root, ["rev-parse", "HEAD"])).toLowerCase();
  return { beforeHead, commitSha };
}

async function assertGoalSourceIdentity(goal: GoalState, maxOutputBytes: number): Promise<void> {
  const sourceRoot = path.resolve(goal.sourceRoot);
  const stat = await fsp.lstat(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(sourceRoot) !== sourceRoot) throw new Error("Goal source root identity changed.");
  const repositoryRoot = await fsp.realpath(path.resolve(sourceRoot, await runGit(sourceRoot, ["rev-parse", "--show-toplevel"], { maxBytes: maxOutputBytes })));
  if (repositoryRoot !== sourceRoot) throw new Error("Goal source Git root identity changed.");
  const commonDir = await fsp.realpath(path.resolve(sourceRoot, await runGit(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { maxBytes: maxOutputBytes })));
  if (commonDir !== goal.sourceGitCommonDir) throw new Error("Goal source Git common-directory identity changed.");
  const head = (await runGit(sourceRoot, ["rev-parse", "HEAD"], { maxBytes: maxOutputBytes })).toLowerCase();
  if (head !== goal.baseSha) throw new Error(`Goal source HEAD drifted from approved base ${goal.baseSha} to ${head}; replan instead of applying.`);
}

export async function goalSourceDirtyPaths(goal: GoalState, maxOutputBytes: number): Promise<string[]> {
  await assertGoalSourceIdentity(goal, maxOutputBytes);
  const [tracked, untracked] = await Promise.all([
    runGit(goal.sourceRoot, ["diff", "--name-only", "-z", "HEAD", "--"], { maxBytes: maxOutputBytes }),
    runGit(goal.sourceRoot, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBytes: maxOutputBytes })
  ]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
}

export async function applyGoalPatchToSource(
  goal: GoalState,
  patch: string,
  changedPaths: string[],
  options: { maxOutputBytes: number; allowAlreadyApplied?: boolean }
): Promise<{ alreadyApplied: boolean; sourceDirtyPathsBefore: string[]; sourceDirtyPathsAfter: string[] }> {
  if (!patch.trim()) throw new Error("Goal has no integrated patch to apply.");
  const patchInput = patch.endsWith("\n") ? patch : `${patch}\n`;
  const before = await goalSourceDirtyPaths(goal, options.maxOutputBytes);
  if (options.allowAlreadyApplied && await gitSucceeds(goal.sourceRoot, ["apply", "--reverse", "--check", "--binary", "--whitespace=nowarn", "-"], patchInput, options.maxOutputBytes)) {
    return { alreadyApplied: true, sourceDirtyPathsBefore: before, sourceDirtyPathsAfter: before };
  }
  const overlap = changedPaths.filter((pathname) => before.includes(pathname));
  if (overlap.length) throw new Error(`Goal source has pre-existing changes on Goal-owned paths: ${overlap.join(", ")}`);
  await runGit(goal.sourceRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patchInput, maxBytes: options.maxOutputBytes });
  await runGit(goal.sourceRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patchInput, maxBytes: options.maxOutputBytes });
  const after = await goalSourceDirtyPaths(goal, options.maxOutputBytes);
  const missing = changedPaths.filter((pathname) => !after.includes(pathname));
  if (missing.length) throw new Error(`Goal source apply readback did not report expected changed paths: ${missing.join(", ")}`);
  if (!await gitSucceeds(goal.sourceRoot, ["apply", "--reverse", "--check", "--binary", "--whitespace=nowarn", "-"], patchInput, options.maxOutputBytes)) {
    throw new Error("Goal source apply could not be authoritatively verified by reverse patch check.");
  }
  return { alreadyApplied: false, sourceDirtyPathsBefore: before, sourceDirtyPathsAfter: after };
}
