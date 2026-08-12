import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { secureCodingTaskDirectory, writeCodingTaskJsonAtomic } from "./codingTaskStore.js";
import { GOAL_ID_PATTERN, parseGoalState, validateGoalId, type GoalState } from "./goalState.js";

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
      integrationWorktreeRoot: path.join(this.dataRoot, "goal-worktrees", goalId)
    };
  }

  async initialize(): Promise<void> {
    await fsp.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fsp.lstat(this.dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Goal data root must be a real directory: ${this.dataRoot}`);
    const real = await fsp.realpath(this.dataRoot);
    if (real !== this.dataRoot) throw new Error(`Goal data root must be canonical: ${real}`);
    await secureCodingTaskDirectory(this.dataRoot, "Goal data root");
    for (const directory of [path.join(this.dataRoot, "goals"), path.join(this.dataRoot, "goal-worktrees")]) {
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Goal storage must be a real directory: ${directory}`);
      await secureCodingTaskDirectory(directory, "Goal storage directory");
    }
  }

  async get(goalIdInput: string): Promise<GoalState> {
    await this.initialize();
    const goalId = validateGoalId(goalIdInput);
    await this.assertGoalDirectory(goalId, false);
    try {
      return parseGoalState(JSON.parse(await fsp.readFile(this.paths(goalId).state, "utf8")), goalId);
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
    const goals: GoalState[] = [];
    for (const entry of entries.slice(0, 2_000)) {
      if (!entry.isDirectory() || !GOAL_ID_PATTERN.test(entry.name)) continue;
      try {
        const goal = await this.get(entry.name);
        if (!options.sourceRoot || goal.sourceRoot === options.sourceRoot) goals.push(goal);
      } catch {
        // Direct get remains the corruption-reporting path; one malformed Goal cannot hide healthy Goals.
      }
    }
    goals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.goalId.localeCompare(right.goalId));
    return goals.slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)));
  }

  async withGoalLock<T>(goalIdInput: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const goalId = validateGoalId(goalIdInput);
    const paths = this.paths(goalId);
    await fsp.mkdir(paths.goalDir, { recursive: true, mode: 0o700 });
    await this.assertGoalDirectory(goalId, true);
    const deadline = Date.now() + this.lockTimeoutMs;
    let handle: fsp.FileHandle | undefined;
    while (!handle) {
      try {
        handle = await fsp.open(paths.lock, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
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
          await fsp.rename(paths.lock, `${paths.lock}.stale.${Date.now()}.${randomUUID()}`).catch((renameError) => {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          });
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for Goal lock: ${goalId}`);
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

  async writeLocked(state: GoalState): Promise<void> {
    parseGoalState(state, state.goalId);
    await writeCodingTaskJsonAtomic(this.paths(state.goalId).state, state);
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
