import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  CODING_TASK_ID_PATTERN,
  parseCodingTaskState,
  validateCodingTaskId,
  type CodingTaskState
} from "./codingTaskState.js";

export interface CodingTaskStoreConfig {
  dataRoot: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface CodingTaskPaths {
  taskDir: string;
  state: string;
  lock: string;
  cancelRequest: string;
  runDefinition: string;
  worktreeRoot: string;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
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

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsp.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function secureCodingTaskDirectory(directory: string, label = "Coding task directory"): Promise<void> {
  if (process.platform === "win32") return;
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fsp.open(directory, fs.constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined && before.uid !== effectiveUid) {
      throw new Error(`${label} must be owned by the current user before permissions can be secured: ${directory}`);
    }
    if ((before.mode & 0o077) !== 0) await handle.chmod(0o700);
    const after = await handle.stat();
    if ((after.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0700: ${directory}`);
  } finally {
    await handle.close();
  }
}

export async function writeCodingTaskJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temporary, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class CodingTaskStore {
  readonly dataRoot: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(config: CodingTaskStoreConfig) {
    if (!path.isAbsolute(config.dataRoot)) throw new Error("Coding task data root must be an absolute path.");
    this.dataRoot = path.resolve(config.dataRoot);
    this.lockTimeoutMs = Math.max(100, Math.min(config.lockTimeoutMs ?? 10_000, 60_000));
    this.staleLockMs = Math.max(5_000, Math.min(config.staleLockMs ?? 120_000, 60 * 60_000));
  }

  paths(taskIdInput: string): CodingTaskPaths {
    const taskId = validateCodingTaskId(taskIdInput);
    return {
      taskDir: path.join(this.dataRoot, "tasks", taskId),
      state: path.join(this.dataRoot, "tasks", taskId, "state.json"),
      lock: path.join(this.dataRoot, "tasks", taskId, "state.lock"),
      cancelRequest: path.join(this.dataRoot, "tasks", taskId, "cancel-request.json"),
      runDefinition: path.join(this.dataRoot, "tasks", taskId, "run-definition.json"),
      worktreeRoot: path.join(this.dataRoot, "worktrees", taskId)
    };
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(this.dataRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Coding task data root must be a real directory, not a file or symlink: ${this.dataRoot}`);
    }
    const realRoot = await fsp.realpath(this.dataRoot);
    if (realRoot !== this.dataRoot) {
      throw new Error(`Coding task data root must be provided as its canonical path: ${realRoot}`);
    }
    await secureCodingTaskDirectory(this.dataRoot, "Coding task data root");
    await Promise.all([
      fsp.mkdir(path.join(this.dataRoot, "tasks"), { recursive: true, mode: 0o700 }),
      fsp.mkdir(path.join(this.dataRoot, "worktrees"), { recursive: true, mode: 0o700 })
    ]);
    for (const child of [path.join(this.dataRoot, "tasks"), path.join(this.dataRoot, "worktrees")]) {
      const childStat = await fsp.lstat(child);
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
        throw new Error(`Coding task storage directory must be a real directory, not a symlink: ${child}`);
      }
      await secureCodingTaskDirectory(child, "Coding task storage directory");
    }
  }

  async get(taskIdInput: string): Promise<CodingTaskState> {
    await this.initialize();
    const taskId = validateCodingTaskId(taskIdInput);
    await this.assertTaskDirectory(taskId, false);
    let raw: string;
    try {
      raw = await fsp.readFile(this.paths(taskId).state, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Coding task not found: ${taskId}`);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Coding task state is not valid JSON for ${taskId}: ${(error as Error).message}`);
    }
    return parseCodingTaskState(parsed, taskId);
  }

  async getIfExists(taskIdInput: string): Promise<CodingTaskState | undefined> {
    try {
      return await this.get(taskIdInput);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Coding task not found:")) return undefined;
      throw error;
    }
  }

  async list(options: { sourceRoot?: string; limit?: number } = {}): Promise<CodingTaskState[]> {
    await this.initialize();
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const entries = await fsp.readdir(path.join(this.dataRoot, "tasks"), { withFileTypes: true });
    const states: CodingTaskState[] = [];
    for (const entry of entries.slice(0, 2_000)) {
      if (!entry.isDirectory() || !CODING_TASK_ID_PATTERN.test(entry.name)) continue;
      try {
        const state = await this.get(entry.name);
        if (options.sourceRoot && state.sourceRoot !== options.sourceRoot) continue;
        states.push(state);
      } catch {
        // A malformed directory must not make healthy tasks undiscoverable. Direct get reports the corruption.
      }
    }
    states.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.taskId.localeCompare(right.taskId));
    return states.slice(0, limit);
  }

  async withTaskLock<T>(taskIdInput: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const taskId = validateCodingTaskId(taskIdInput);
    const paths = this.paths(taskId);
    await fsp.mkdir(paths.taskDir, { recursive: true, mode: 0o700 });
    await this.assertTaskDirectory(taskId, true);
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: fsp.FileHandle | undefined;
    while (!handle) {
      try {
        handle = await fsp.open(paths.lock, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stale = await this.lockIsStale(paths.lock);
        if (stale) {
          await fsp.rename(paths.lock, `${paths.lock}.stale.${Date.now()}.${randomUUID()}`).catch((renameError) => {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          });
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for coding task lock: ${taskId}`);
        await sleep(20 + Math.floor(Math.random() * 30));
      }
    }
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.unlink(paths.lock).catch(() => undefined);
    }
  }

  async writeLocked(state: CodingTaskState): Promise<void> {
    parseCodingTaskState(state, state.taskId);
    await writeCodingTaskJsonAtomic(this.paths(state.taskId).state, state);
  }

  private async lockIsStale(lockPath: string): Promise<boolean> {
    const stat = await fsp.stat(lockPath).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs < this.staleLockMs) return false;
    try {
      const parsed = JSON.parse(await fsp.readFile(lockPath, "utf8")) as { pid?: unknown };
      return typeof parsed.pid !== "number" || !processAlive(parsed.pid);
    } catch {
      return true;
    }
  }

  private async assertTaskDirectory(taskId: string, required: boolean): Promise<void> {
    const taskDir = this.paths(taskId).taskDir;
    let stat;
    try {
      stat = await fsp.lstat(taskDir);
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Coding task directory must be a real directory: ${taskDir}`);
    const real = await fsp.realpath(taskDir);
    if (real !== taskDir) throw new Error(`Coding task directory must be canonical: ${real}`);
    await secureCodingTaskDirectory(taskDir);
  }
}
