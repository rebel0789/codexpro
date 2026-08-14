import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCodingTaskJsonAtomic, secureCodingTaskDirectory } from "./codingTaskStore.js";
import { GoalStore, type GoalStoreConfig } from "./goalStore.js";
import { goalSourceDirtyPaths, reviewGoalIntegration, verifyGoalIntegrationDiff } from "./goalWorktree.js";
import { parseGoalState, validateGoalId, type GoalProjection, type GoalState } from "./goalState.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_FILE_MODES = new Set(["100644", "100755"]);

export interface ProjectGoalInput {
  expectedRevision: number;
  projectionKey: string;
  integrationHeadSha: string;
  reviewFingerprint: string;
  isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
}

export interface RevertGoalProjectionInput {
  expectedRevision: number;
  projectionId: string;
  revertKey: string;
  isPathContentAllowed?: (relativePath: string) => boolean | Promise<boolean>;
}

export interface GoalProjectionResult {
  goal: GoalState;
  projection: GoalProjection;
  reused: boolean;
  recovered: boolean;
}

export interface VerifiedGoalLiveProjection {
  projection: GoalProjection;
  review: GoalReviewAttestation;
  sourceDirtyPaths: string[];
}

export interface GoalReviewAttestation {
  reviewFingerprint: string;
  integrationHeadSha: string;
  visibleDiffSha256: string;
  repositoryObservationSha256: string;
  contentComplete: boolean;
  dirty: boolean;
  verificationOutputSha256: string;
}

export function goalReviewFingerprint(
  goal: Pick<GoalState, "goalId" | "contractFingerprint" | "baseSha">,
  review: Pick<Awaited<ReturnType<typeof reviewGoalIntegration>>, "headSha" | "visibleDiffSha256" | "repositoryObservationSha256" | "contentComplete" | "dirty">,
  verification: Pick<Awaited<ReturnType<typeof verifyGoalIntegrationDiff>>, "status" | "output">
): GoalReviewAttestation {
  const verificationOutputSha256 = sha256(verification.output);
  const reviewFingerprint = sha256(JSON.stringify({
    goalId: goal.goalId,
    contractFingerprint: goal.contractFingerprint,
    baseSha: goal.baseSha,
    integrationHeadSha: review.headSha,
    visibleDiffSha256: review.visibleDiffSha256,
    repositoryObservationSha256: review.repositoryObservationSha256,
    contentComplete: review.contentComplete,
    dirty: review.dirty,
    verificationStatus: verification.status,
    verificationOutputSha256
  }));
  return { reviewFingerprint, integrationHeadSha: review.headSha, visibleDiffSha256: review.visibleDiffSha256, repositoryObservationSha256: review.repositoryObservationSha256, contentComplete: review.contentComplete, dirty: review.dirty, verificationOutputSha256 };
}

interface TreeFileState {
  path: string;
  exists: boolean;
  mode?: "100644" | "100755";
  oid?: string;
  size?: number;
  contentSha256?: string;
  contentBase64?: string;
  indexMode?: string;
  indexOid?: string;
  sourcePermissions?: number;
}

interface ProjectionManifest {
  version: 1;
  goalId: string;
  projectionId: string;
  fingerprint: string;
  fromIntegrationSha: string;
  toIntegrationSha: string;
  sourceHeadSha: string;
  paths: TreeFileState[];
}

interface ProjectionJournal {
  version: 1;
  goalId: string;
  projectionId: string;
  fingerprint: string;
  direction: "apply" | "revert";
  status: "prepared" | "applying" | "applied" | "reverting" | "reverted" | "recovery_required";
  updatedAt: string;
  error?: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(normalized)) throw new Error(`${label} must be a safe 1-160 character key.`);
  return normalized;
}

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

async function runGitBuffer(cwd: string, args: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (overflow) return reject(new Error(`Goal projection Git output exceeded ${maxBytes} bytes.`));
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) return reject(new Error(`Goal projection Git ${args[0] ?? "command"} failed (${code ?? signal}): ${err || out.toString("utf8").trim()}`));
      resolve(out);
    });
  });
}

async function runGit(cwd: string, args: string[], maxBytes: number): Promise<string> {
  return (await runGitBuffer(cwd, args, maxBytes)).toString("utf8").trim();
}

function validateRelativePath(value: string): string {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\0") || value.includes("\\")) throw new Error("Goal projection received an unsafe or non-canonical POSIX path.");
  const normalized = value;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Goal projection received an unsafe path: ${value}`);
  return normalized;
}

async function changedPaths(root: string, fromSha: string, toSha: string, maxBytes: number): Promise<string[]> {
  const raw = (await runGitBuffer(root, ["diff", "--name-status", "--no-renames", "-z", fromSha, toSha, "--"], maxBytes)).toString("utf8");
  if (!raw) return [];
  const fields = raw.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    if (!/^[AMD]$/.test(status)) throw new Error(`Live projection does not support Git change type ${status}.`);
    const pathname = fields[index++];
    if (!pathname) throw new Error("Malformed Goal projection changed-path output.");
    paths.push(validateRelativePath(pathname));
  }
  return [...new Set(paths)].sort();
}

async function treeState(root: string, sha: string, pathname: string, maxBytes: number): Promise<TreeFileState> {
  const raw = (await runGitBuffer(root, ["ls-tree", "-z", sha, "--", `:(literal)${pathname}`], maxBytes)).toString("utf8");
  if (!raw) return { path: pathname, exists: false };
  const nul = raw.indexOf("\0");
  const entry = (nul < 0 ? raw : raw.slice(0, nul));
  const tab = entry.indexOf("\t");
  const header = tab < 0 ? entry : entry.slice(0, tab);
  const [mode, type, oid] = header.split(" ");
  if (!SAFE_FILE_MODES.has(mode) || type !== "blob" || !FULL_SHA.test(oid)) {
    throw new Error(`Live projection supports only regular files and executable regular files: ${pathname} (${mode} ${type}).`);
  }
  const content = await runGitBuffer(root, ["cat-file", "blob", oid], maxBytes);
  return {
    path: pathname,
    exists: true,
    mode: mode as "100644" | "100755",
    oid,
    size: content.length,
    contentSha256: sha256(content),
    contentBase64: content.toString("base64")
  };
}

async function indexState(root: string, pathname: string, maxBytes: number): Promise<{ indexMode?: string; indexOid?: string }> {
  const raw = (await runGitBuffer(root, ["ls-files", "--stage", "-z", "--", `:(literal)${pathname}`], maxBytes)).toString("utf8");
  if (!raw) return {};
  const header = raw.split("\t", 1)[0] ?? "";
  const [indexMode, indexOid, stage] = header.split(" ");
  if (stage !== "0" || !FULL_SHA.test(indexOid) || !SAFE_FILE_MODES.has(indexMode)) throw new Error(`Live projection refuses conflicted, symlink, or submodule index state: ${pathname}.`);
  return { indexMode, indexOid };
}

async function assertSafeParents(root: string, pathname: string, create: boolean): Promise<string> {
  const rootReal = await fsp.realpath(root);
  if (rootReal !== path.resolve(root)) throw new Error("Goal source root is not canonical.");
  const parts = pathname.split("/");
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fsp.mkdir(current, { mode: 0o755 });
      stat = await fsp.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Live projection refuses unsafe parent topology: ${pathname}.`);
  }
  return path.join(rootReal, ...parts);
}

async function filesystemState(root: string, expected: TreeFileState, maxBytes: number): Promise<TreeFileState> {
  if (process.platform === "win32") throw new Error("Live projection requires no-follow file handles and is not supported on Windows by this release.");
  const file = await assertSafeParents(root, expected.path, false).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return path.join(root, ...expected.path.split("/"));
    throw error;
  });
  let handle: fsp.FileHandle;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    handle = await fsp.open(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: expected.path, exists: false, ...await indexState(root, expected.path, maxBytes) };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Live projection refuses non-regular source path: ${expected.path}.`);
    if (stat.size > maxBytes) throw new Error(`Live projection path exceeds bounded artifact size: ${expected.path}.`);
    const content = await handle.readFile();
    return {
      path: expected.path,
      exists: true,
      mode: (stat.mode & 0o111) ? "100755" : "100644",
      size: content.length,
      contentSha256: sha256(content),
      contentBase64: content.toString("base64"),
      sourcePermissions: stat.mode & 0o777,
      ...await indexState(root, expected.path, maxBytes)
    };
  } finally {
    await handle.close();
  }
}

function sameFile(left: TreeFileState, right: TreeFileState): boolean {
  return left.path === right.path && left.exists === right.exists &&
    (!left.exists || (left.mode === right.mode && left.contentSha256 === right.contentSha256 &&
      (right.sourcePermissions === undefined || left.sourcePermissions === right.sourcePermissions)));
}

function projectedPermissions(current: number | undefined, targetMode: "100644" | "100755" | undefined): number | undefined {
  if (!targetMode) return undefined;
  if (current === undefined) return targetMode === "100755" ? 0o700 : 0o600;
  return targetMode === "100755" ? (current | 0o100) : (current & ~0o111);
}

function sameIndex(left: TreeFileState, right: TreeFileState): boolean {
  return left.indexMode === right.indexMode && left.indexOid === right.indexOid;
}

async function atomicWriteSource(root: string, target: TreeFileState, expectedCurrent: TreeFileState, maxBytes: number): Promise<void> {
  const file = await assertSafeParents(root, target.path, target.exists);
  if (!target.exists) {
    const immediate = await filesystemState(root, expectedCurrent, maxBytes);
    if (!sameFile(immediate, expectedCurrent) || !sameIndex(immediate, expectedCurrent)) throw new Error(`Goal source changed immediately before delete: ${target.path}.`);
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Live projection refuses to delete non-regular path: ${target.path}.`);
      await fsp.unlink(file);
      const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  if (!target.contentBase64 || !target.mode) throw new Error(`Projection artifact is missing content for ${target.path}.`);
  const existing = await fsp.lstat(file).catch(() => undefined);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Live projection refuses unsafe target topology: ${target.path}.`);
  const temporary = path.join(path.dirname(file), `.codexpro-projection-${process.pid}-${randomUUID()}.tmp`);
  let handle: fsp.FileHandle | undefined;
  try {
    const permissions = target.sourcePermissions ?? (target.mode === "100755" ? 0o700 : 0o600);
    handle = await fsp.open(temporary, "wx", permissions);
    await handle.writeFile(Buffer.from(target.contentBase64, "base64"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.chmod(temporary, permissions);
    const immediate = await filesystemState(root, expectedCurrent, maxBytes);
    if (!sameFile(immediate, expectedCurrent) || !sameIndex(immediate, expectedCurrent)) throw new Error(`Goal source changed immediately before replace: ${target.path}.`);
    await fsp.rename(temporary, file);
    const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeImmutable(file: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await secureCodingTaskDirectory(path.dirname(file), "Goal projection journal");
  const wanted = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fsp.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(wanted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try { await fsp.link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const existing = await readImmutable(file);
    if (!existing.equals(wanted)) throw new Error(`Immutable Goal projection artifact changed: ${file}`);
    const directory = await fsp.open(path.dirname(file), fs.constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fsp.unlink(temporary).catch(() => undefined); }
}

async function readImmutable(file: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  if (process.platform === "win32") throw new Error("Live projection immutable artifacts require no-follow file handles and are not supported on Windows by this release.");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Goal projection artifact must be a regular file: ${file}`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`Goal projection artifact permissions are not private: ${file}`);
    if (stat.size > maxBytes) throw new Error(`Goal projection artifact exceeds the configured bound: ${file}`);
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

async function loadVerifiedManifests(store: GoalStore, goal: GoalState, projection: GoalProjection, maxBytes = 64 * 1024 * 1024): Promise<{ before: ProjectionManifest; after: ProjectionManifest }> {
  const files = store.projectionPaths(goal.goalId, projection.projectionId);
  const [beforeBytes, afterBytes] = await Promise.all([readImmutable(files.before, maxBytes), readImmutable(files.after, maxBytes)]);
  if (sha256(beforeBytes) !== projection.beforeManifestSha256 || sha256(afterBytes) !== projection.afterManifestSha256) {
    throw new Error("Goal projection immutable manifest hash mismatch.");
  }
  const before = JSON.parse(beforeBytes.toString("utf8")) as ProjectionManifest;
  const after = JSON.parse(afterBytes.toString("utf8")) as ProjectionManifest;
  for (const manifest of [before, after]) {
    if (manifest.goalId !== goal.goalId || manifest.projectionId !== projection.projectionId || manifest.fingerprint !== projection.fingerprint ||
        manifest.fromIntegrationSha !== projection.fromIntegrationSha || manifest.toIntegrationSha !== projection.toIntegrationSha || manifest.sourceHeadSha !== projection.sourceHeadSha) {
      throw new Error("Goal projection immutable manifest identity mismatch.");
    }
  }
  if (!Array.isArray(before.paths) || !Array.isArray(after.paths) || before.paths.length !== after.paths.length || before.paths.length !== projection.changedPaths.length) {
    throw new Error("Goal projection immutable manifest path cardinality mismatch.");
  }
  for (let index = 0; index < before.paths.length; index++) {
    const left = before.paths[index];
    const right = after.paths[index];
    if (!left || !right || validateRelativePath(left.path) !== projection.changedPaths[index] || right.path !== left.path) throw new Error("Goal projection immutable manifest path identity mismatch.");
    for (const item of [left, right]) {
      if (typeof item.exists !== "boolean" || (item.exists && (!item.mode || !SAFE_FILE_MODES.has(item.mode) || !item.contentSha256 || !HASH.test(item.contentSha256) || typeof item.contentBase64 !== "string" || sha256(Buffer.from(item.contentBase64, "base64")) !== item.contentSha256))) {
        throw new Error("Goal projection immutable manifest file state is invalid.");
      }
      if (item.sourcePermissions !== undefined && (!Number.isSafeInteger(item.sourcePermissions) || item.sourcePermissions < 0 || item.sourcePermissions > 0o777)) throw new Error("Goal projection immutable manifest permissions are invalid.");
    }
  }
  return { before, after };
}

async function classifySource(goal: GoalState, before: ProjectionManifest, after: ProjectionManifest, maxBytes: number): Promise<{ states: Array<"before" | "after" | "unknown">; current: TreeFileState[] }> {
  const current: TreeFileState[] = [];
  const states: Array<"before" | "after" | "unknown"> = [];
  for (let index = 0; index < before.paths.length; index++) {
    const beforePath = before.paths[index]!;
    const afterPath = after.paths[index]!;
    const observed = await filesystemState(goal.sourceRoot, beforePath, maxBytes);
    current.push(observed);
    if (!sameIndex(observed, beforePath)) states.push("unknown");
    else if (sameFile(observed, beforePath)) states.push("before");
    else if (sameFile(observed, afterPath)) states.push("after");
    else states.push("unknown");
  }
  return { states, current };
}

async function verifyActiveProjectionPaths(
  store: GoalStore,
  goal: GoalState,
  maxOutputBytes: number,
  contentPolicy?: (relativePath: string) => boolean | Promise<boolean>,
  excludedPaths: ReadonlySet<string> = new Set()
): Promise<void> {
  if (!goal.live) throw new Error("Goal Live state is missing.");
  await goalSourceDirtyPaths(goal, maxOutputBytes);
  const expected = new Map<string, TreeFileState>();
  for (const projection of goal.live.projections) {
    if (!["applied", "adopted"].includes(projection.status)) continue;
    for (const pathname of projection.changedPaths) if (contentPolicy && !(await contentPolicy(pathname))) throw new Error(`Live Goal source verification refuses blocked path: ${pathname}`);
    const manifests = await loadVerifiedManifests(store, goal, projection, maxOutputBytes);
    for (const file of manifests.after.paths) if (!excludedPaths.has(file.path)) expected.set(file.path, file);
  }
  for (const file of expected.values()) {
    const observed = await filesystemState(goal.sourceRoot, file, maxOutputBytes);
    if (!sameFile(observed, file) || !sameIndex(observed, file)) {
      throw new Error(`Live Goal source path drifted from its cumulative projected state: ${file.path}; no source bytes were changed.`);
    }
  }
}

async function applyDirection(goal: GoalState, before: ProjectionManifest, after: ProjectionManifest, direction: "apply" | "revert", maxBytes: number): Promise<{ recovered: boolean; sourceDirtyPathsAfter: string[] }> {
  await goalSourceDirtyPaths(goal, maxBytes);
  const classification = await classifySource(goal, before, after, maxBytes);
  const source = direction === "apply" ? before.paths : after.paths;
  const target = direction === "apply" ? after.paths : before.paths;
  const sourceLabel = direction === "apply" ? "before" : "after";
  const targetLabel = direction === "apply" ? "after" : "before";
  if (classification.states.includes("unknown")) throw new Error("Goal source contains an external same-path edit; projection recovery requires user action and will not overwrite it.");
  const recovered = classification.states.some((value) => value === targetLabel);
  for (let index = 0; index < target.length; index++) {
    const state = classification.states[index];
    if (state === targetLabel) continue;
    if (state !== sourceLabel || !sameFile(classification.current[index]!, source[index]!)) throw new Error("Goal projection source changed during recovery classification.");
    await atomicWriteSource(goal.sourceRoot, target[index]!, classification.current[index]!, maxBytes);
    const readback = await filesystemState(goal.sourceRoot, target[index]!, maxBytes);
    if (!sameFile(readback, target[index]!) || !sameIndex(readback, target[index]!)) throw new Error(`Goal projection per-path authoritative readback failed: ${target[index]!.path}.`);
  }
  const verified = await classifySource(goal, before, after, maxBytes);
  const wanted = direction === "apply" ? "after" : "before";
  if (verified.states.some((value) => value !== wanted)) throw new Error("Goal projection authoritative source readback failed.");
  return { recovered, sourceDirtyPathsAfter: await goalSourceDirtyPaths(goal, maxBytes) };
}

export async function attestGoalReview(
  goal: GoalState,
  maxOutputBytes: number,
  contentPolicy?: (relativePath: string) => boolean | Promise<boolean>
): Promise<GoalReviewAttestation> {
  const review = await reviewGoalIntegration(goal, { maxOutputBytes, contentPolicy });
  const verification = await verifyGoalIntegrationDiff(goal, review.headSha, maxOutputBytes);
  return goalReviewFingerprint(goal, review, verification);
}

function replaceProjection(goal: GoalState, projection: GoalProjection, updates: Partial<GoalState>): GoalState {
  if (!goal.live) throw new Error("Goal Live state is missing.");
  return {
    ...goal,
    ...updates,
    live: {
      ...goal.live,
      ...(updates.live ?? {}),
      projections: goal.live.projections.map((item) => item.projectionId === projection.projectionId ? projection : item)
    }
  };
}

async function persistProjection(store: GoalStore, goal: GoalState, projection: GoalProjection, liveUpdates: Partial<NonNullable<GoalState["live"]>>): Promise<GoalState> {
  const now = new Date().toISOString();
  const next = replaceProjection(goal, projection, {
    revision: goal.revision + 1,
    updatedAt: now,
    live: { ...goal.live!, ...liveUpdates },
    events: [...goal.events, { at: now, kind: "projection_updated" as const, message: `Projection ${projection.projectionId}: ${projection.status}.` }].slice(-500)
  });
  parseGoalState(next, goal.goalId);
  await store.writeLocked(next);
  return next;
}

async function executeProjectionApply(
  store: GoalStore,
  goal: GoalState,
  projection: GoalProjection,
  maxOutputBytes: number,
  reused: boolean
): Promise<GoalProjectionResult> {
  const artifactPaths = store.projectionPaths(goal.goalId, projection.projectionId);
  const manifests = await loadVerifiedManifests(store, goal, projection, maxOutputBytes);
  projection = { ...projection, status: "applying", error: undefined };
  goal = await persistProjection(store, goal, projection, { pendingProjectionId: projection.projectionId });
  await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId: goal.goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "apply", status: "applying", updatedAt: new Date().toISOString() } satisfies ProjectionJournal);
  try {
    const applied = await applyDirection(goal, manifests.before, manifests.after, "apply", maxOutputBytes);
    projection = { ...projection, status: "applied", sourceDirtyPathsAfter: applied.sourceDirtyPathsAfter, appliedAt: new Date().toISOString(), error: undefined };
    await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId: goal.goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "apply", status: "applied", updatedAt: new Date().toISOString() } satisfies ProjectionJournal);
    goal = await persistProjection(store, goal, projection, { projectedIntegrationSha: projection.toIntegrationSha, pendingProjectionId: undefined });
    return { goal, projection, reused, recovered: applied.recovered };
  } catch (error) {
    projection = { ...projection, status: "recovery_required", error: error instanceof Error ? error.message : String(error) };
    await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId: goal.goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "apply", status: "recovery_required", updatedAt: new Date().toISOString(), error: projection.error } satisfies ProjectionJournal);
    await persistProjection(store, goal, projection, { pendingProjectionId: projection.projectionId });
    throw error;
  }
}

export async function projectGoal(
  config: GoalStoreConfig & { maxOutputBytes: number },
  goalIdInput: string,
  input: ProjectGoalInput
): Promise<GoalProjectionResult> {
  const goalId = validateGoalId(goalIdInput);
  const projectionKey = boundedKey(input.projectionKey, "Goal projection key");
  const integrationHeadSha = input.integrationHeadSha.trim().toLowerCase();
  const reviewFingerprint = input.reviewFingerprint.trim().toLowerCase();
  if (!FULL_SHA.test(integrationHeadSha) || !HASH.test(reviewFingerprint)) throw new Error("Goal projection requires a full integration HEAD and review fingerprint.");
  const store = new GoalStore(config);
  const initial = await store.get(goalId);
  return store.withSourceLock(initial.sourceRoot, initial.sourceGitCommonDir, async () => store.withGoalLock(goalId, async () => {
    let goal = await store.get(goalId);
    const existing = goal.live?.projections.find((item) => item.projectionKey === projectionKey);
    if (existing) {
      const expectedFingerprint = sha256(JSON.stringify({ goalId, projectionKey, from: existing.fromIntegrationSha, to: integrationHeadSha, reviewFingerprint }));
      if (existing.fingerprint !== expectedFingerprint) throw new Error("Goal projection key is already bound to a different projection contract.");
      if (["applied", "adopted"].includes(existing.status)) {
        await verifyActiveProjectionPaths(store, goal, config.maxOutputBytes, input.isPathContentAllowed);
        return { goal, projection: existing, reused: true, recovered: false };
      }
      if (["reverted", "reverting"].includes(existing.status)) throw new Error("A reverted Goal projection key cannot be reused.");
      if (existing.revertKey) throw new Error("A Goal projection under revert recovery cannot be resumed by project_goal; retry the exact revert key.");
    }
    if (!["running", "waiting_review", "paused"].includes(goal.lifecycle)) {
      throw new Error("Goal projection requires a nonterminal running, paused, or review-waiting Goal.");
    }
    if (!existing && goal.revision !== input.expectedRevision) {
      throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
    }
    if (goal.executionPolicy !== "supervised" || goal.workspacePolicy !== "live" || !goal.permissions.sourceEffects.apply) throw new Error("Goal projection requires an approved supervised Live contract with source apply permission.");
    if (!goal.live) throw new Error("Goal Live state is missing.");
    if (goal.live.adoptedAt || goal.lifecycle === "completed") throw new Error("Completed or adopted Live Goals cannot project more changes.");
    if (goal.live.projections.some((item) => item.status === "recovery_required" && item.projectionKey !== projectionKey)) throw new Error("Goal projection is blocked by an unresolved recovery_required journal.");
    if (goal.integrationHeadSha !== integrationHeadSha) throw new Error("Goal integration HEAD no longer matches the reviewed projection target.");
    const attestation = await attestGoalReview(goal, config.maxOutputBytes, input.isPathContentAllowed);
    if (!attestation.contentComplete) throw new Error("Goal projection refuses an incomplete, content-filtered review.");
    if (attestation.dirty) throw new Error("Goal projection requires a clean committed integration worktree.");
    if (attestation.integrationHeadSha !== integrationHeadSha || attestation.reviewFingerprint !== reviewFingerprint) {
      throw new Error("Goal projection review fingerprint does not match the authoritative integration observation.");
    }
    const fromSha = existing?.fromIntegrationSha ?? goal.live.projectedIntegrationSha;
    const rootHead = (await runGit(goal.integrationWorktreeRoot, ["rev-parse", "HEAD"], config.maxOutputBytes)).toLowerCase();
    if (rootHead !== integrationHeadSha) throw new Error("Goal integration worktree HEAD changed after review.");
    if (existing) {
      await verifyActiveProjectionPaths(store, goal, config.maxOutputBytes, input.isPathContentAllowed, new Set(existing.changedPaths));
      return executeProjectionApply(store, goal, existing, config.maxOutputBytes, true);
    }
    await verifyActiveProjectionPaths(store, goal, config.maxOutputBytes, input.isPathContentAllowed);
    const paths = await changedPaths(goal.integrationWorktreeRoot, fromSha, integrationHeadSha, config.maxOutputBytes);
    if (!paths.length) throw new Error("Goal projection has no new integrated delta.");
    if (paths.length > 1_000) throw new Error("Goal projection exceeds the 1000-path safety bound.");
    for (const pathname of paths) if (input.isPathContentAllowed && !(await input.isPathContentAllowed(pathname))) throw new Error(`Goal projection refuses blocked path: ${pathname}`);
    const fingerprint = sha256(JSON.stringify({ goalId, projectionKey, from: fromSha, to: integrationHeadSha, reviewFingerprint }));
    const projectionId = `proj_${fingerprint.slice(0, 24)}`;
    const artifactPaths = store.projectionPaths(goalId, projectionId);
    const baselineIndex = new Map<string, { indexMode?: string; indexOid?: string }>();
    for (const pathname of paths) baselineIndex.set(pathname, await indexState(goal.sourceRoot, pathname, config.maxOutputBytes));
    const beforeStates: TreeFileState[] = [];
    const afterStates: TreeFileState[] = [];
    for (const pathname of paths) {
      const before = await treeState(goal.integrationWorktreeRoot, fromSha, pathname, config.maxOutputBytes);
      const after = await treeState(goal.integrationWorktreeRoot, integrationHeadSha, pathname, config.maxOutputBytes);
      const base = await treeState(goal.integrationWorktreeRoot, goal.baseSha, pathname, config.maxOutputBytes);
      const actualIndex = baselineIndex.get(pathname)!;
      const expectedIndex = base.exists ? { indexMode: base.mode, indexOid: base.oid } : {};
      if (actualIndex.indexMode !== expectedIndex.indexMode || actualIndex.indexOid !== expectedIndex.indexOid) throw new Error(`Goal projection refuses staged or index-drifted source path: ${pathname}.`);
      const actualSource = await filesystemState(goal.sourceRoot, { path: pathname, exists: base.exists }, config.maxOutputBytes);
      beforeStates.push({ ...before, ...actualIndex, ...(actualSource.sourcePermissions !== undefined ? { sourcePermissions: actualSource.sourcePermissions } : {}) });
      const afterPermissions = projectedPermissions(actualSource.sourcePermissions, after.mode);
      afterStates.push({ ...after, ...actualIndex, ...(afterPermissions !== undefined ? { sourcePermissions: afterPermissions } : {}) });
      const totalBytes = [...beforeStates, ...afterStates].reduce((sum, item) => sum + (item.size ?? 0), 0);
      if (totalBytes > config.maxOutputBytes) throw new Error("Goal projection manifests exceed the configured aggregate content bound.");
    }
    const beforeManifest: ProjectionManifest = { version: 1, goalId, projectionId, fingerprint, fromIntegrationSha: fromSha, toIntegrationSha: integrationHeadSha, sourceHeadSha: goal.baseSha, paths: beforeStates };
    const afterManifest: ProjectionManifest = { ...beforeManifest, paths: afterStates };
    const beforeText = `${JSON.stringify(beforeManifest, null, 2)}\n`;
    const afterText = `${JSON.stringify(afterManifest, null, 2)}\n`;
    if (Buffer.byteLength(beforeText) > config.maxOutputBytes || Buffer.byteLength(afterText) > config.maxOutputBytes) {
      throw new Error("Goal projection serialized manifests exceed the configured artifact bound.");
    }
    const deltaPatch = await runGitBuffer(goal.integrationWorktreeRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", fromSha, integrationHeadSha, "--"], config.maxOutputBytes);
    const cumulativePatch = await runGitBuffer(goal.integrationWorktreeRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", goal.baseSha, integrationHeadSha, "--"], config.maxOutputBytes);
    await writeImmutable(artifactPaths.before, beforeText);
    await writeImmutable(artifactPaths.after, afterText);
    await writeImmutable(artifactPaths.patch, deltaPatch);
    const projection: GoalProjection = {
      projectionId,
      projectionKey,
      fingerprint,
      status: "prepared",
      fromIntegrationSha: fromSha,
      toIntegrationSha: integrationHeadSha,
      reviewFingerprint,
      deltaPatchSha256: sha256(deltaPatch),
      cumulativePatchSha256: sha256(cumulativePatch),
      changedPaths: paths,
      journalRelativePath: path.relative(store.paths(goalId).goalDir, artifactPaths.journal).split(path.sep).join("/"),
      sourceHeadSha: goal.baseSha,
      sourceDirtyPathsBefore: await goalSourceDirtyPaths(goal, config.maxOutputBytes),
      beforeManifestSha256: sha256(beforeText),
      afterManifestSha256: sha256(afterText),
      preparedAt: new Date().toISOString()
    };
    const now = new Date().toISOString();
    goal = {
      ...goal,
      revision: goal.revision + 1,
      updatedAt: now,
      live: { ...goal.live, pendingProjectionId: projectionId, projections: [...goal.live.projections, projection].slice(-500) },
      events: [...goal.events, { at: now, kind: "projection_updated" as const, message: `Projection ${projectionId} prepared.` }].slice(-500)
    };
    await store.writeLocked(goal);
    return executeProjectionApply(store, goal, projection, config.maxOutputBytes, false);
  }));
}

export async function verifyGoalLiveProjection(
  config: GoalStoreConfig & { maxOutputBytes: number },
  goal: GoalState,
  contentPolicy?: (relativePath: string) => boolean | Promise<boolean>
): Promise<VerifiedGoalLiveProjection> {
  if (goal.workspacePolicy !== "live" || !goal.live || !goal.integrationHeadSha) throw new Error("Goal is not an initialized Live Goal.");
  if (goal.live.pendingProjectionId || goal.live.projections.some((item) => ["prepared", "applying", "reverting", "recovery_required"].includes(item.status))) {
    throw new Error("Live Goal has a pending or recovery-required projection journal.");
  }
  if (goal.live.projectedIntegrationSha !== goal.integrationHeadSha) throw new Error("Live Goal integration HEAD is not fully projected.");
  const projection = [...goal.live.projections].reverse().find((item) => ["applied", "adopted"].includes(item.status) && item.toIntegrationSha === goal.integrationHeadSha);
  if (!projection) throw new Error("Live Goal has no authoritative latest-applied projection for its integration HEAD.");
  const review = await attestGoalReview(goal, config.maxOutputBytes, contentPolicy);
  if (!review.contentComplete || review.dirty || review.integrationHeadSha !== goal.integrationHeadSha || review.reviewFingerprint !== projection.reviewFingerprint) {
    throw new Error("Live Goal final review no longer matches its projected integration checkpoint.");
  }
  const store = new GoalStore(config);
  await verifyActiveProjectionPaths(store, goal, config.maxOutputBytes, contentPolicy);
  return { projection, review, sourceDirtyPaths: await goalSourceDirtyPaths(goal, config.maxOutputBytes) };
}

export async function revertGoalProjection(
  config: GoalStoreConfig & { maxOutputBytes: number },
  goalIdInput: string,
  input: RevertGoalProjectionInput
): Promise<GoalProjectionResult> {
  const goalId = validateGoalId(goalIdInput);
  const revertKey = boundedKey(input.revertKey, "Goal projection revert key");
  if (!/^proj_[a-f0-9]{24}$/.test(input.projectionId)) throw new Error("Invalid Goal projection id.");
  const store = new GoalStore(config);
  const initial = await store.get(goalId);
  return store.withSourceLock(initial.sourceRoot, initial.sourceGitCommonDir, async () => store.withGoalLock(goalId, async () => {
    let goal = await store.get(goalId);
    if (!goal.live) throw new Error("Goal is not a Live Goal.");
    let projection = goal.live.projections.find((item) => item.projectionId === input.projectionId);
    if (!projection) throw new Error(`Goal projection not found: ${input.projectionId}`);
    if (projection.status === "reverted") {
      if (projection.revertKey !== revertKey) throw new Error("Goal projection is already bound to a different revert key.");
      return { goal, projection, reused: true, recovered: false };
    }
    if (projection.revertKey && projection.revertKey !== revertKey) throw new Error("Goal projection is already bound to a different revert key.");
    const recoveringRevert = projection.revertKey === revertKey && ["reverting", "recovery_required"].includes(projection.status);
    if (!recoveringRevert && goal.revision !== input.expectedRevision) throw new Error(`Goal revision conflict: expected ${input.expectedRevision}, found ${goal.revision}.`);
    if (goal.lifecycle === "completed" || goal.live.adoptedAt) throw new Error("Completed or adopted Goal projections cannot be reverted.");
    const latest = [...goal.live.projections].reverse().find((item) => ["applied", "reverting", "recovery_required"].includes(item.status));
    if (!latest || latest.projectionId !== projection.projectionId) throw new Error("Goal projections may only be reverted latest-applied first (LIFO).");
    await verifyActiveProjectionPaths(store, goal, config.maxOutputBytes, input.isPathContentAllowed, new Set(projection.changedPaths));
    for (const pathname of projection.changedPaths) if (input.isPathContentAllowed && !(await input.isPathContentAllowed(pathname))) throw new Error(`Goal projection revert refuses blocked path: ${pathname}`);
    const artifactPaths = store.projectionPaths(goalId, projection.projectionId);
    projection = { ...projection, status: "reverting", revertKey, error: undefined };
    goal = await persistProjection(store, goal, projection, { pendingProjectionId: projection.projectionId });
    await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "revert", status: "reverting", updatedAt: new Date().toISOString() } satisfies ProjectionJournal);
    try {
      const manifests = await loadVerifiedManifests(store, goal, projection, config.maxOutputBytes);
      const reverted = await applyDirection(goal, manifests.before, manifests.after, "revert", config.maxOutputBytes);
      projection = { ...projection, status: "reverted", revertedAt: new Date().toISOString(), error: undefined };
      await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "revert", status: "reverted", updatedAt: new Date().toISOString() } satisfies ProjectionJournal);
      goal = await persistProjection(store, goal, projection, { projectedIntegrationSha: projection.fromIntegrationSha, pendingProjectionId: undefined });
      return { goal, projection, reused: false, recovered: reverted.recovered };
    } catch (error) {
      projection = { ...projection, status: "recovery_required", revertKey, error: error instanceof Error ? error.message : String(error) };
      await writeCodingTaskJsonAtomic(artifactPaths.journal, { version: 1, goalId, projectionId: projection.projectionId, fingerprint: projection.fingerprint, direction: "revert", status: "recovery_required", updatedAt: new Date().toISOString(), error: projection.error } satisfies ProjectionJournal);
      await persistProjection(store, goal, projection, { pendingProjectionId: projection.projectionId });
      throw error;
    }
  }));
}
