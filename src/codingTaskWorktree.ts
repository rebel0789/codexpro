import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateFullGitSha, type CodingTaskGitObservation } from "./codingTaskState.js";
import { secureCodingTaskDirectory } from "./codingTaskStore.js";

const DEFAULT_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const inheritedPath = process.env.PATH ?? process.env.Path;
  const environment: NodeJS.ProcessEnv = {
    ...(inheritedPath ? { PATH: inheritedPath } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
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
  return environment;
}

export interface CodingTaskSourceWorkspace {
  root: string;
}

export interface CodingTaskWorkspaceGuard {
  assertSourceWorkspace?(sourceRoot: string): void | Promise<void>;
}

export interface CodingTaskGitIdentity {
  sourceRoot: string;
  commonDir: string;
  baseSha: string;
  sourceDirty: boolean;
  sourceStatusEntryCount: number;
}

export interface CodingTaskReviewSnapshot extends CodingTaskGitObservation {
  baseSha: string;
  worktreeRoot: string;
  diff: string;
  changedPaths: string[];
  changedFileCount: number;
  additions: number;
  deletions: number;
  visibleDiffSha256: string;
  repositoryObservationSha256: string;
  contentComplete: boolean;
  omittedPaths: string[];
  omittedPathCount: number;
}

export type CodingTaskReviewContentPolicy = (relativePath: string) => boolean | Promise<boolean>;

function visibleDiffMetrics(status: string, diff: string): { changedFileCount: number; additions: number; deletions: number } {
  const changedFileCount = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { changedFileCount, additions, deletions };
}

async function runGit(cwd: string, args: string[], maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: safeGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        overflow = true;
        child.kill();
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        overflow = true;
        child.kill();
      } else stderr.push(chunk);
    });
    child.once("error", (error) => reject(new Error(`Could not run git: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (overflow) return reject(new Error(`Git output exceeded the ${maxOutputBytes}-byte safety limit.`));
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(new Error(`Git ${args[0] ?? "command"} failed (${code ?? signal}): ${err || out.trim()}`));
      resolve(out.trim());
    });
  });
}

async function canonicalRealDirectory(directory: string, label: string): Promise<string> {
  const resolved = path.resolve(directory);
  const stat = await fsp.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory, not a symlink: ${resolved}`);
  const real = await fsp.realpath(resolved);
  if (real !== resolved) throw new Error(`${label} must be provided as its canonical path: ${real}`);
  return real;
}

export async function inspectCodingTaskSource(
  workspace: CodingTaskSourceWorkspace,
  explicitBaseSha: string,
  guard?: CodingTaskWorkspaceGuard
): Promise<CodingTaskGitIdentity> {
  const sourceRoot = await canonicalRealDirectory(workspace.root, "Source workspace");
  await guard?.assertSourceWorkspace?.(sourceRoot);
  const repositoryRootRaw = await runGit(sourceRoot, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await fsp.realpath(path.resolve(sourceRoot, repositoryRootRaw));
  if (repositoryRoot !== sourceRoot) {
    throw new Error(
      `Coding tasks require the already allowed workspace to be the Git repository root; refusing to widen ${sourceRoot} to ${repositoryRoot}.`
    );
  }
  const baseSha = validateFullGitSha(explicitBaseSha);
  const resolvedCommit = (await runGit(sourceRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`])).toLowerCase();
  if (resolvedCommit !== baseSha) throw new Error("The explicit base SHA does not resolve to the same committed Git object.");
  const [commonRaw, sourceStatus] = await Promise.all([
    runGit(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  const commonDir = await fsp.realpath(path.resolve(sourceRoot, commonRaw));
  const commonStat = await fsp.lstat(commonDir);
  if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) throw new Error("Git common directory must be a real directory.");
  return {
    sourceRoot,
    commonDir,
    baseSha,
    sourceDirty: Boolean(sourceStatus),
    sourceStatusEntryCount: sourceStatus ? sourceStatus.split(/\r?\n/).filter(Boolean).length : 0
  };
}

export async function resolveCodingTaskBaseSha(
  workspace: CodingTaskSourceWorkspace,
  baseSha?: string,
  guard?: CodingTaskWorkspaceGuard
): Promise<string> {
  if (baseSha?.trim()) return (await inspectCodingTaskSource(workspace, validateFullGitSha(baseSha), guard)).baseSha;
  const sourceRoot = await canonicalRealDirectory(workspace.root, "Source workspace");
  await guard?.assertSourceWorkspace?.(sourceRoot);
  const repositoryRootRaw = await runGit(sourceRoot, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await fsp.realpath(path.resolve(sourceRoot, repositoryRootRaw));
  if (repositoryRoot !== sourceRoot) {
    throw new Error(`Coding tasks require the already allowed workspace to be the Git repository root; refusing to widen ${sourceRoot} to ${repositoryRoot}.`);
  }
  const head = validateFullGitSha(await runGit(sourceRoot, ["rev-parse", "HEAD"]), "source HEAD");
  return (await inspectCodingTaskSource({ root: sourceRoot }, head, guard)).baseSha;
}

async function untrackedDiff(
  worktreeRoot: string,
  maxOutputBytes: number,
  contentPolicy?: CodingTaskReviewContentPolicy
): Promise<{ diff: string; stat: string; visiblePaths: string[]; omittedPaths: string[] }> {
  const raw = await runGit(worktreeRoot, ["ls-files", "--others", "--exclude-standard", "-z"], maxOutputBytes);
  if (!raw) return { diff: "", stat: "", visiblePaths: [], omittedPaths: [] };
  const names = raw.split("\0").filter(Boolean);
  const patches: string[] = [];
  const stats: string[] = [];
  const omittedPaths: string[] = [];
  const visiblePaths: string[] = [];
  let usedBytes = 0;
  for (const name of names) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Git returned an unsafe untracked path.");
    if (contentPolicy && !(await contentPolicy(name))) {
      omittedPaths.push(name);
      continue;
    }
    visiblePaths.push(name);
    const file = path.resolve(worktreeRoot, name);
    if (!file.startsWith(`${worktreeRoot}${path.sep}`)) throw new Error("Untracked path escaped the task worktree.");
    let handle: fsp.FileHandle;
    if (process.platform === "win32") {
      const before = await fsp.lstat(file);
      if (before.isSymbolicLink()) throw new Error(`Review refuses untracked symlink content: ${name}`);
      const real = await fsp.realpath(file);
      if (!real.startsWith(`${worktreeRoot}${path.sep}`)) throw new Error(`Untracked file resolves outside the task worktree: ${name}`);
      handle = await fsp.open(file, fs.constants.O_RDONLY);
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        await handle.close();
        throw new Error(`Untracked file changed identity during safe open: ${name}`);
      }
    } else {
      handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      continue;
    }
    if (usedBytes + stat.size > maxOutputBytes) {
      await handle.close();
      throw new Error(`Untracked review content exceeded the ${maxOutputBytes}-byte safety limit.`);
    }
    const content = await handle.readFile();
    await handle.close();
    usedBytes += content.length;
    const binary = content.includes(0);
    if (binary) {
      patches.push(`diff --git a/${name} b/${name}\nnew file mode ${stat.mode & 0o111 ? "100755" : "100644"}\nBinary files /dev/null and b/${name} differ`);
      stats.push(` ${name} | Bin ${content.length} bytes`);
      continue;
    }
    const text = content.toString("utf8");
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const escaped = name.replaceAll('"', '\\"');
    patches.push([
      `diff --git a/${name} b/${name}`,
      `new file mode ${stat.mode & 0o111 ? "100755" : "100644"}`,
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${escaped}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
      ...(text.endsWith("\n") ? [] : ["\\ No newline at end of file"])
    ].join("\n"));
    stats.push(` ${name} | ${lines.length} ${"+".repeat(Math.min(lines.length, 60))}`);
  }
  const combined = patches.join("\n");
  if (Buffer.byteLength(combined) > maxOutputBytes) throw new Error(`Combined untracked diff exceeded the ${maxOutputBytes}-byte safety limit.`);
  return { diff: combined, stat: stats.join("\n"), visiblePaths, omittedPaths };
}

interface TrackedReviewPaths {
  visiblePathspecs: string[];
  omittedPaths: string[];
}

async function trackedReviewPaths(
  worktreeRoot: string,
  baseSha: string,
  maxOutputBytes: number,
  contentPolicy?: CodingTaskReviewContentPolicy
): Promise<TrackedReviewPaths> {
  const raw = await runGit(
    worktreeRoot,
    ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", baseSha, "--"],
    maxOutputBytes
  );
  if (!raw) return { visiblePathspecs: [], omittedPaths: [] };
  const fields = raw.split("\0").filter(Boolean);
  const visiblePathspecs = new Set<string>();
  const omittedPaths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const names = fields.slice(index, index + count);
    index += count;
    if (names.length !== count) throw new Error("Git returned malformed changed-path metadata.");
    for (const name of names) {
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error("Git returned an unsafe tracked path.");
    }
    const allowed = !contentPolicy || (await Promise.all(names.map((name) => contentPolicy(name)))).every(Boolean);
    for (const name of names) (allowed ? visiblePathspecs : omittedPaths).add(name);
  }
  return { visiblePathspecs: [...visiblePathspecs], omittedPaths: [...omittedPaths] };
}

export async function createCodingTaskWorktree(
  identity: CodingTaskGitIdentity,
  worktreeRootInput: string
): Promise<string> {
  const worktreeRoot = path.resolve(worktreeRootInput);
  const parent = await canonicalRealDirectory(path.dirname(worktreeRoot), "Coding task worktree parent");
  if (path.dirname(worktreeRoot) !== parent) throw new Error("Coding task worktree path must have a canonical parent.");
  const existing = await fsp.lstat(worktreeRoot).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Task worktree path is not a real directory: ${worktreeRoot}`);
    // This function is used before durable task state exists. A prior crash may have registered
    // the detached worktree after --no-checkout but before populating its index/files. Restore the
    // authoritative committed base before the creation transaction is allowed to persist state.
    await runGit(worktreeRoot, ["checkout", "--force", "--detach", identity.baseSha]);
    await secureCodingTaskDirectory(worktreeRoot, "Coding task worktree");
    await assertCodingTaskWorktree(identity, worktreeRoot);
    return worktreeRoot;
  }
  await runGit(identity.sourceRoot, ["worktree", "add", "--detach", "--no-checkout", worktreeRoot, identity.baseSha]);
  try {
    await runGit(worktreeRoot, ["checkout", "--force", "--detach", identity.baseSha]);
    await secureCodingTaskDirectory(worktreeRoot, "Coding task worktree");
    await assertCodingTaskWorktree(identity, worktreeRoot);
    return worktreeRoot;
  } catch (error) {
    // Leave the worktree registered for recovery and diagnosis; this slice never performs destructive cleanup.
    throw error;
  }
}

export async function assertCodingTaskWorktree(identity: CodingTaskGitIdentity, worktreeRootInput: string): Promise<void> {
  const worktreeRoot = await canonicalRealDirectory(worktreeRootInput, "Coding task worktree");
  await secureCodingTaskDirectory(worktreeRoot, "Coding task worktree");
  const repositoryRootRaw = await runGit(worktreeRoot, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await fsp.realpath(path.resolve(worktreeRoot, repositoryRootRaw));
  if (repositoryRoot !== worktreeRoot) throw new Error("Coding task worktree Git root identity mismatch.");
  const commonRaw = await runGit(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = await fsp.realpath(path.resolve(worktreeRoot, commonRaw));
  if (commonDir !== identity.commonDir) throw new Error("Coding task worktree belongs to a different Git common directory.");
  const head = (await runGit(worktreeRoot, ["rev-parse", "HEAD"])).toLowerCase();
  if (head !== identity.baseSha) {
    const baseIsAncestor = await runGit(worktreeRoot, ["merge-base", "--is-ancestor", identity.baseSha, head]).then(
      () => true,
      () => false
    );
    if (!baseIsAncestor) throw new Error("Coding task worktree HEAD is not descended from the persisted base SHA.");
  }
}

export async function observeCodingTaskGit(
  identity: CodingTaskGitIdentity,
  worktreeRoot: string,
  maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES
): Promise<CodingTaskGitObservation> {
  await assertCodingTaskWorktree(identity, worktreeRoot);
  const [headSha, status, diffStat, trackedDiff, untracked] = await Promise.all([
    runGit(worktreeRoot, ["rev-parse", "HEAD"], maxOutputBytes),
    runGit(worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"], maxOutputBytes),
    runGit(worktreeRoot, ["diff", "--stat", "--no-ext-diff", identity.baseSha, "--"], maxOutputBytes),
    runGit(worktreeRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", identity.baseSha, "--"], maxOutputBytes),
    untrackedDiff(worktreeRoot, maxOutputBytes)
  ]);
  const diff = [trackedDiff, untracked.diff].filter(Boolean).join("\n");
  return {
    capturedAt: new Date().toISOString(),
    headSha: validateFullGitSha(headSha, "observed worktree HEAD"),
    status,
    diffStat: [diffStat, untracked.stat].filter(Boolean).join("\n"),
    diffSha256: createHash("sha256").update(diff).digest("hex"),
    dirty: Boolean(status)
  };
}

export async function reviewCodingTaskWorktree(
  identity: CodingTaskGitIdentity,
  worktreeRoot: string,
  options: number | { maxOutputBytes?: number; contentPolicy?: CodingTaskReviewContentPolicy } = {}
): Promise<CodingTaskReviewSnapshot> {
  const maxOutputBytes = typeof options === "number" ? options : options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
  const contentPolicy = typeof options === "number" ? undefined : options.contentPolicy;
  await assertCodingTaskWorktree(identity, worktreeRoot);
  const [headSha, status, diffStat, trackedPaths, untracked] = await Promise.all([
    runGit(worktreeRoot, ["rev-parse", "HEAD"], maxOutputBytes),
    runGit(worktreeRoot, ["status", "--porcelain=v1", "--untracked-files=all"], maxOutputBytes),
    runGit(worktreeRoot, ["diff", "--stat", "--no-ext-diff", identity.baseSha, "--"], maxOutputBytes),
    trackedReviewPaths(worktreeRoot, identity.baseSha, maxOutputBytes, contentPolicy),
    untrackedDiff(worktreeRoot, maxOutputBytes, contentPolicy)
  ]);
  const trackedDiff = trackedPaths.visiblePathspecs.length
    ? await runGit(
        worktreeRoot,
        [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          identity.baseSha,
          "--",
          ...trackedPaths.visiblePathspecs.map((name) => `:(literal)${name}`)
        ],
        maxOutputBytes
      )
    : "";
  const diff = [trackedDiff, untracked.diff].filter(Boolean).join("\n");
  const metrics = visibleDiffMetrics(status, diff);
  const visibleDiffSha256 = createHash("sha256").update(diff).digest("hex");
  const omittedPaths = [...new Set([...trackedPaths.omittedPaths, ...untracked.omittedPaths])].sort();
  const changedPaths = [...new Set([...trackedPaths.visiblePathspecs, ...untracked.visiblePaths])].sort();
  const repositoryObservationSha256 = createHash("sha256")
    .update(JSON.stringify({ baseSha: identity.baseSha, headSha, status, diffStat, omittedPaths }))
    .digest("hex");
  return {
    baseSha: identity.baseSha,
    worktreeRoot,
    capturedAt: new Date().toISOString(),
    headSha: validateFullGitSha(headSha, "observed worktree HEAD"),
    status,
    diffStat: [diffStat, untracked.stat].filter(Boolean).join("\n"),
    diff,
    changedPaths,
    ...metrics,
    diffSha256: visibleDiffSha256,
    visibleDiffSha256,
    repositoryObservationSha256,
    contentComplete: omittedPaths.length === 0,
    omittedPaths,
    omittedPathCount: omittedPaths.length,
    dirty: Boolean(status)
  };
}
