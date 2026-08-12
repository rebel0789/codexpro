import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { secureCodingTaskDirectory, writeCodingTaskJsonAtomic } from "./codingTaskStore.js";
import { GOAL_ID_PATTERN, parseGoalState, validateGoalId, type GoalState } from "./goalState.js";

const GOAL_STATE_MAX_BYTES = 4 * 1024 * 1024;
const GOAL_LIST_MAX_READ_BYTES = 32 * 1024 * 1024;
const GOAL_LIST_MAX_CANDIDATES = 500;

export interface GoalStoreConfig {
  dataRoot: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface GoalPaths {
  goalDir: string;
  state: string;
  lock: string;
  integrationWorktreeRoot: string;
  projectionRoot: string;
  integrationJournalRoot: string;
  schedulerRoot: string;
  schedulerRuntime: string;
  schedulerLock: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class GoalStore {
  readonly dataRoot: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(config: GoalStoreConfig) {
    if (!path.isAbsolute(config.dataRoot)) throw new Error("Goal data root must be an absolute path.");
    this.dataRoot = path.resolve(config.dataRoot);
    this.lockTimeoutMs = Math.max(100, Math.min(config.lockTimeoutMs ?? 10_000, 60_000));
    this.staleLockMs = Math.max(5_000, Math.min(config.staleLockMs ?? 120_000, 3_600_000));
  }

  paths(goalIdInput: string): GoalPaths {
    const goalId = validateGoalId(goalIdInput);
    return {
      goalDir: path.join(this.dataRoot, "goals", goalId),
      state: path.join(this.dataRoot, "goals", goalId, "state.json"),
      lock: path.join(this.dataRoot, "goals", goalId, "state.lock"),
      integrationWorktreeRoot: path.join(this.dataRoot, "goal-worktrees", goalId),
      projectionRoot: path.join(this.dataRoot, "goals", goalId, "projections"),
      integrationJournalRoot: path.join(this.dataRoot, "goals", goalId, "integrations"),
      schedulerRoot: path.join(this.dataRoot, "goals", goalId, "scheduler"),
      schedulerRuntime: path.join(this.dataRoot, "goals", goalId, "scheduler", "runtime.json"),
      schedulerLock: path.join(this.dataRoot, "goals", goalId, "scheduler", "scheduler.lock")
    };
  }

  integrationJournalPath(goalIdInput: string, workId: string): string {
    const goalId = validateGoalId(goalIdInput);
    if (!/^work_[a-z0-9][a-z0-9_-]{0,63}$/.test(workId)) throw new Error("Invalid Goal integration work id.");
    return path.join(this.paths(goalId).integrationJournalRoot, `${workId}.json`);
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fsp.lstat(this.dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Goal data root must be a real directory: ${this.dataRoot}`);
    const real = await fsp.realpath(this.dataRoot);
    if (real !== this.dataRoot) throw new Error(`Goal data root must be canonical: ${real}`);
    await secureCodingTaskDirectory(this.dataRoot, "Goal data root");
    for (const directory of [path.join(this.dataRoot, "goals"), path.join(this.dataRoot, "goal-worktrees"), path.join(this.dataRoot, "source-locks")]) {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Goal storage must be a real directory: ${directory}`);
      await secureCodingTaskDirectory(directory, "Goal storage directory");
    }
  }

  projectionPaths(goalIdInput: string, projectionId: string): { root: string; journal: string; patch: string; before: string; after: string } {
    const goalId = validateGoalId(goalIdInput);
    if (!/^proj_[a-f0-9]{24}$/.test(projectionId)) throw new Error("Invalid Goal projection id.");
    const root = path.join(this.paths(goalId).projectionRoot, projectionId);
    return {
      root,
      journal: path.join(root, "journal.json"),
      patch: path.join(root, "delta.patch"),
      before: path.join(root, "before.json"),
      after: path.join(root, "after.json")
    };
  }

  async withSourceLock<T>(sourceRoot: string, commonDir: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lockId = createHash("sha256").update(`${path.resolve(sourceRoot)}\0${path.resolve(commonDir)}`).digest("hex").slice(0, 32);
    const registry = path.join(os.tmpdir(), `codexpro-goal-source-locks-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
    await fsp.mkdir(registry, { recursive: true, mode: 0o700 });
    await secureCodingTaskDirectory(registry, "Goal global source lock registry");
    const lockPath = path.join(registry, `${lockId}.lock`);
    if (process.platform !== "win32") return this.withPosixAdvisoryLock(lockPath, operation);
    const recoveryPath = path.join(registry, `${lockId}.recovery`);
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: fsp.FileHandle | undefined;
    const token = randomUUID();
    const lockContent = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), sourceRoot, commonDir })}\n`;
    while (!handle) {
      try {
        handle = await fsp.open(lockPath, "wx", 0o600);
        await handle.writeFile(lockContent, "utf8");
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fsp.stat(lockPath).catch(() => undefined);
        let stale = Boolean(stat && Date.now() - stat.mtimeMs >= this.staleLockMs);
        if (stale) {
          try {
            const parsed = JSON.parse(await fsp.readFile(lockPath, "utf8")) as { pid?: unknown };
            stale = typeof parsed.pid !== "number" || !processAlive(parsed.pid);
          } catch {
            stale = true;
          }
        }
        if (stale) {
          let recoveryHandle: fsp.FileHandle | undefined;
          try {
            recoveryHandle = await fsp.open(recoveryPath, "wx", 0o600);
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") { await sleep(20); continue; }
            throw recoveryError;
          }
          try {
            const current = await fsp.readFile(lockPath, "utf8").catch(() => undefined);
            if (current === undefined) continue;
            let currentStale = false;
            try {
              const parsed = JSON.parse(current) as { pid?: unknown };
              const currentStat = await fsp.stat(lockPath);
              currentStale = Date.now() - currentStat.mtimeMs >= this.staleLockMs && (typeof parsed.pid !== "number" || !processAlive(parsed.pid));
            } catch { currentStale = true; }
            if (!currentStale) continue;
          const observed = await fsp.readFile(lockPath, "utf8").catch(() => undefined);
          const moved = `${lockPath}.stale.${Date.now()}.${randomUUID()}`;
          await fsp.rename(lockPath, moved).catch((renameError) => {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          });
          if (observed !== undefined) {
            const movedContent = await fsp.readFile(moved, "utf8").catch(() => undefined);
            if (movedContent !== observed) {
              await fsp.rename(moved, lockPath);
              continue;
            }
            await fsp.unlink(moved).catch(() => undefined);
          }
          continue;
          } finally {
            await recoveryHandle.close().catch(() => undefined);
            await fsp.unlink(recoveryPath).catch(() => undefined);
          }
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Goal source lock: ${sourceRoot}`);
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
    try {
      if (await fsp.readFile(lockPath, "utf8").catch(() => undefined) !== lockContent) throw new Error("Goal source lock ownership changed before operation.");
      const result = await operation();
      if (await fsp.readFile(lockPath, "utf8").catch(() => undefined) !== lockContent) throw new Error("Goal source lock ownership changed during operation.");
      return result;
    } finally {
      await handle.close().catch(() => undefined);
      if (await fsp.readFile(lockPath, "utf8").catch(() => undefined) === lockContent) await fsp.unlink(lockPath).catch(() => undefined);
    }
  }

  async get(goalIdInput: string): Promise<GoalState> {
    await this.initialize();
    const goalId = validateGoalId(goalIdInput);
    await this.assertGoalDirectory(goalId, false);
    try {
      const statePath = this.paths(goalId).state;
      const handle = await fsp.open(statePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > GOAL_STATE_MAX_BYTES) throw new Error(`Goal state exceeds the ${GOAL_STATE_MAX_BYTES}-byte safety bound.`);
        return parseGoalState(JSON.parse(await handle.readFile("utf8")), goalId);
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Goal not found: ${goalId}`);
      throw error;
    }
  }

  async getIfExists(goalId: string): Promise<GoalState | undefined> {
    try {
      return await this.get(goalId);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Goal not found:")) return undefined;
      throw error;
    }
  }

  async list(options: { sourceRoot?: string; limit?: number } = {}): Promise<GoalState[]> {
    await this.initialize();
    const entries = await fsp.readdir(path.join(this.dataRoot, "goals"), { withFileTypes: true });
    const requestedLimit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const candidates = (await Promise.all(entries.slice(0, 2_000).flatMap(async (entry) => {
      if (!entry.isDirectory() || !GOAL_ID_PATTERN.test(entry.name)) return [];
      const stat = await fsp.lstat(this.paths(entry.name).state).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > GOAL_STATE_MAX_BYTES) return [];
      return [{ goalId: entry.name, size: stat.size, mtimeMs: stat.mtimeMs }];
    }))).flat().sort((left, right) => right.mtimeMs - left.mtimeMs || left.goalId.localeCompare(right.goalId)).slice(0, GOAL_LIST_MAX_CANDIDATES);
    const goals: GoalState[] = [];
    let readBytes = 0;
    for (const candidate of candidates) {
      if (goals.length >= requestedLimit || readBytes + candidate.size > GOAL_LIST_MAX_READ_BYTES) break;
      readBytes += candidate.size;
      try {
        const goal = await this.get(candidate.goalId);
        if (!options.sourceRoot || goal.sourceRoot === options.sourceRoot) goals.push(goal);
      } catch {
        // Direct get remains the corruption-reporting path; one malformed Goal cannot hide healthy Goals.
      }
    }
    goals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.goalId.localeCompare(right.goalId));
    return goals.slice(0, requestedLimit);
  }

  async withGoalLock<T>(goalIdInput: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const goalId = validateGoalId(goalIdInput);
    const paths = this.paths(goalId);
    await fsp.mkdir(paths.goalDir, { recursive: true, mode: 0o700 });
    await this.assertGoalDirectory(goalId, true);
    if (process.platform !== "win32") return this.withPosixAdvisoryLock(paths.lock, operation);
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: fsp.FileHandle | undefined;
    const token = randomUUID();
    const lockContent = `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`;
    while (!handle) {
      try {
        handle = await fsp.open(paths.lock, "wx", 0o600);
        await handle.writeFile(lockContent, "utf8");
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fsp.stat(paths.lock).catch(() => undefined);
        let stale = Boolean(stat && Date.now() - stat.mtimeMs >= this.staleLockMs);
        if (stale) {
          try {
            const parsed = JSON.parse(await fsp.readFile(paths.lock, "utf8")) as { pid?: unknown };
            stale = typeof parsed.pid !== "number" || !processAlive(parsed.pid);
          } catch {
            stale = true;
          }
        }
        if (stale) {
          const observed = await fsp.readFile(paths.lock, "utf8").catch(() => undefined);
          const moved = `${paths.lock}.stale.${Date.now()}.${randomUUID()}`;
          await fsp.rename(paths.lock, moved).catch((renameError) => {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          });
          if (observed !== undefined) {
            const movedContent = await fsp.readFile(moved, "utf8").catch(() => undefined);
            if (movedContent !== observed) {
              await fsp.rename(moved, paths.lock).catch(() => undefined);
              continue;
            }
            await fsp.unlink(moved).catch(() => undefined);
          }
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Goal lock: ${goalId}`);
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
    try {
      if (await fsp.readFile(paths.lock, "utf8").catch(() => undefined) !== lockContent) throw new Error("Goal lock ownership changed before operation.");
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      if (await fsp.readFile(paths.lock, "utf8").catch(() => undefined) === lockContent) await fsp.unlink(paths.lock).catch(() => undefined);
    }
  }

  async writeLocked(state: GoalState): Promise<void> {
    parseGoalState(state, state.goalId);
    if (Buffer.byteLength(JSON.stringify(state), "utf8") > GOAL_STATE_MAX_BYTES) throw new Error(`Goal state exceeds the ${GOAL_STATE_MAX_BYTES}-byte safety bound.`);
    await writeCodingTaskJsonAtomic(this.paths(state.goalId).state, state);
  }

  schedulerDefinitionPath(goalIdInput: string, fingerprint: string): string {
    const goalId = validateGoalId(goalIdInput);
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid Goal scheduler definition fingerprint.");
    return path.join(this.paths(goalId).schedulerRoot, `definition-${fingerprint}.json`);
  }

  async withSchedulerLock<T>(goalIdInput: string, operation: () => Promise<T>): Promise<T> {
    if (process.platform === "win32") throw new Error("Persistent Goal scheduling requires POSIX advisory locking.");
    const goalId = validateGoalId(goalIdInput);
    await this.initialize();
    const paths = this.paths(goalId);
    await fsp.mkdir(paths.schedulerRoot, { recursive: true, mode: 0o700 });
    await secureCodingTaskDirectory(paths.schedulerRoot, "Goal scheduler directory");
    return this.withPosixAdvisoryLock(paths.schedulerLock, operation);
  }

  async tryWithSchedulerLock<T>(goalIdInput: string, operation: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    if (process.platform === "win32") throw new Error("Persistent Goal scheduling requires POSIX advisory locking.");
    const goalId = validateGoalId(goalIdInput);
    await this.initialize();
    const paths = this.paths(goalId);
    await fsp.mkdir(paths.schedulerRoot, { recursive: true, mode: 0o700 });
    await secureCodingTaskDirectory(paths.schedulerRoot, "Goal scheduler directory");
    return this.tryPosixAdvisoryLock(paths.schedulerLock, operation);
  }

  private async withPosixAdvisoryLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    const executable = process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
    const helper = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
    const timeoutSeconds = Math.max(1, Math.ceil(this.lockTimeoutMs / 1_000));
    const args = process.platform === "darwin"
      ? ["-k", "-t", String(timeoutSeconds), lockPath, process.execPath, "-e", helper]
      : ["-w", String(timeoutSeconds), lockPath, process.execPath, "-e", helper];
    const child = spawn(executable, args, {
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1"
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Timed out waiting for Goal advisory lock: ${lockPath}`));
      }, this.lockTimeoutMs + 1_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("LOCKED\n")) { clearTimeout(timer); resolve(); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Could not start Goal advisory lock helper ${executable}: ${error.message}`)); });
      child.once("exit", (code, signal) => {
        if (!output.includes("LOCKED\n")) { clearTimeout(timer); reject(new Error(`Goal advisory lock acquisition failed (${code ?? signal}): ${stderr.trim()}`)); }
      });
    });
    try {
      return await operation();
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }

  private async tryPosixAdvisoryLock<T>(lockPath: string, operation: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const executable = process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
    const helper = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
    const args = process.platform === "darwin" ? ["-t", "0", lockPath, process.execPath, "-e", helper] : ["-E", "75", "-n", lockPath, process.execPath, "-e", helper];
    const child = spawn(executable, args, { env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}), LANG: "C", LC_ALL: "C", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const acquired = await new Promise<boolean>((resolve, reject) => {
      let output = ""; let stderr = ""; let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error(`Timed out probing Goal scheduler lock: ${lockPath}`)); } }, Math.min(this.lockTimeoutMs, 2_000));
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (!settled && output.includes("LOCKED\n")) { settled = true; clearTimeout(timer); resolve(true); } });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8_192) stderr += chunk.toString("utf8"); });
      child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (code === 75) resolve(false);
        else reject(new Error(`Goal scheduler lock probe failed (${code ?? signal}): ${stderr.trim().slice(0, 8_192)}`));
      });
    });
    if (!acquired) return { acquired: false };
    try { return { acquired: true, value: await operation() }; }
    finally {
      child.stdin.end();
      await new Promise<void>((resolve) => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => { child.kill(); resolve(); }, 2_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    }
  }

  private async assertGoalDirectory(goalId: string, required: boolean): Promise<void> {
    const directory = this.paths(goalId).goalDir;
    try {
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Goal directory must be a real directory: ${directory}`);
      if (await fsp.realpath(directory) !== directory) throw new Error(`Goal directory must be canonical: ${directory}`);
      await secureCodingTaskDirectory(directory, "Goal directory");
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
