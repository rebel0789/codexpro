import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
  codingTaskId?: string;
}

export interface PersistentTaskWorkspaceResolution {
  taskId: string;
  worktreeRoot: string;
  sourceRoot: string;
  openedAt?: string;
  provenanceVerified: boolean;
}

export type PersistentTaskWorkspaceResolver = (
  workspaceId: string
) => PersistentTaskWorkspaceResolution | undefined | Promise<PersistentTaskWorkspaceResolution | undefined>;

export interface WorkspaceManagerOptions {
  resolvePersistentTaskWorkspace?: PersistentTaskWorkspaceResolver;
}

export class CodexProError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return undefined;
  }
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof (value as PromiseLike<T>).then === "function";
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private selectedWorkspaceId?: string;

  constructor(
    private readonly config: CodexProConfig,
    private readonly options: WorkspaceManagerOptions = {}
  ) {}

  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    return existing ?? this.openWorkspace(this.config.defaultRoot, { select: false });
  }

  selectDefaultWorkspace(): Workspace {
    const workspace = this.defaultWorkspace();
    this.selectedWorkspaceId = workspace.id;
    return workspace;
  }

  openWorkspace(rootInput?: string, options: { select?: boolean } = {}): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new CodexProError(`Workspace root is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync.native(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new CodexProError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) {
      if (options.select !== false) this.selectedWorkspaceId = existing.id;
      return existing;
    }

    const id = workspaceIdForRoot(realRoot);
    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    this.workspaces.set(id, workspace);
    if (options.select !== false) this.selectedWorkspaceId = id;
    return workspace;
  }

  getWorkspace(id?: string): Workspace {
    if (!id) {
      if (this.selectedWorkspaceId) {
        const selected = this.workspaces.get(this.selectedWorkspaceId);
        if (selected) return selected;
      }
      return this.selectDefaultWorkspace();
    }
    let workspace = this.knownWorkspace(id);
    if (!workspace && /^taskws_[a-f0-9]{24}$/.test(id)) workspace = this.resolvePersistentTaskWorkspaceSync(id);
    if (!workspace) {
      throw new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    return workspace;
  }

  async getWorkspaceAsync(id?: string): Promise<Workspace> {
    if (!id) return this.getWorkspace();
    const workspace = this.knownWorkspace(id);
    if (workspace) return workspace;
    if (/^taskws_[a-f0-9]{24}$/.test(id)) return this.resolvePersistentTaskWorkspaceAsync(id);
    throw new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  currentWorkspaceId(): string {
    return this.getWorkspace().id;
  }

  private knownWorkspace(workspaceId: string): Workspace | undefined {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) return workspace;
    const configuredRoot = this.config.allowedRoots.find((allowedRoot) => workspaceIdForRoot(allowedRoot) === workspaceId);
    return configuredRoot ? this.openWorkspace(configuredRoot, { select: false }) : undefined;
  }

  private persistentTaskWorkspaceResolver(workspaceId: string): PersistentTaskWorkspaceResolver {
    const resolver = this.options.resolvePersistentTaskWorkspace;
    if (!resolver) {
      throw new CodexProError(`Coding task workspace cannot be restored by this server: ${workspaceId}.`);
    }
    return resolver;
  }

  private resolvePersistentTaskWorkspaceSync(workspaceId: string): Workspace {
    const resolution = this.persistentTaskWorkspaceResolver(workspaceId)(workspaceId);
    if (isPromiseLike<PersistentTaskWorkspaceResolution | undefined>(resolution)) {
      void Promise.resolve(resolution).catch(() => undefined);
      throw new CodexProError(
        `Coding task workspace requires asynchronous restoration: ${workspaceId}. Use getWorkspaceAsync for this lookup.`
      );
    }
    return this.materializePersistentTaskWorkspace(workspaceId, resolution);
  }

  private async resolvePersistentTaskWorkspaceAsync(workspaceId: string): Promise<Workspace> {
    const resolution = await this.persistentTaskWorkspaceResolver(workspaceId)(workspaceId);
    return this.materializePersistentTaskWorkspace(workspaceId, resolution);
  }

  private materializePersistentTaskWorkspace(
    workspaceId: string,
    resolution: PersistentTaskWorkspaceResolution | undefined
  ): Workspace {
    if (!resolution || resolution.provenanceVerified !== true) {
      throw new CodexProError(`Coding task workspace provenance could not be verified: ${workspaceId}.`);
    }
    if (!/^task_[a-f0-9]{24}$/.test(resolution.taskId)) {
      throw new CodexProError(`Coding task workspace resolver returned an invalid task identity: ${workspaceId}.`);
    }
    if (`taskws_${resolution.taskId.slice("task_".length)}` !== workspaceId) {
      throw new CodexProError(`Coding task workspace identity does not match its task: ${workspaceId}.`);
    }

    const requestedSourceRoot = path.resolve(resolution.sourceRoot);
    const sourceRoot = maybeRealpath(requestedSourceRoot);
    if (!sourceRoot || sourceRoot !== requestedSourceRoot || !this.config.allowedRoots.some((root) => isSubpath(sourceRoot, root))) {
      throw new CodexProError(`Coding task source workspace is no longer an allowed canonical root: ${workspaceId}.`);
    }

    const requestedWorktreeRoot = path.resolve(resolution.worktreeRoot);
    const worktreeRoot = maybeRealpath(requestedWorktreeRoot);
    const taskStateRoot = maybeRealpath(this.config.codingTaskDir);
    if (!worktreeRoot || worktreeRoot !== requestedWorktreeRoot || !taskStateRoot || !isSubpath(worktreeRoot, taskStateRoot)) {
      throw new CodexProError(`Coding task worktree is missing or outside the configured task directory: ${workspaceId}.`);
    }
    const stat = fs.lstatSync(worktreeRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CodexProError(`Coding task worktree is not a real directory: ${workspaceId}.`);
    }

    const workspace: Workspace = {
      id: workspaceId,
      root: worktreeRoot,
      openedAt: resolution.openedAt ?? new Date().toISOString(),
      codingTaskId: resolution.taskId
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }
}

export class PathGuard {
  constructor(private readonly config: CodexProConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new CodexProError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new CodexProError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new CodexProError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof CodexProError) throw error;
      }
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new CodexProError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new CodexProError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(sample, 0, sample.length, offset);
        if (bytesRead === 0) break;
        if (sample.subarray(0, bytesRead).includes(0)) {
          throw new CodexProError("Refusing to read binary file.");
        }
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
