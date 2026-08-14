import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CodexProError } from "./guard.js";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

export interface GitIdentityGuard {
  expectedHead?: string;
  requireCleanWorktree: boolean;
}

export interface GitIdentityObservation {
  repositoryRoot: string;
  head: string;
  clean: boolean;
  verifiedAt: string;
}

function runGit(workspaceRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error) {
    throw new CodexProError(`Git identity guard could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `git exited with status ${result.status}`).trim();
    throw new CodexProError(`Git identity guard could not inspect the workspace: ${detail}`);
  }
  return String(result.stdout).trim();
}

export function normalizeGitIdentityGuard(input: {
  expectedHead?: string;
  requireCleanWorktree?: boolean;
}): GitIdentityGuard | undefined {
  const expectedHead = input.expectedHead?.trim().toLowerCase();
  if (expectedHead && !FULL_GIT_SHA.test(expectedHead)) {
    throw new CodexProError("expected_git_head must be a full 40-character Git commit SHA.");
  }
  const requireCleanWorktree = Boolean(input.requireCleanWorktree);
  if (!expectedHead && !requireCleanWorktree) return undefined;
  return {
    ...(expectedHead ? { expectedHead } : {}),
    requireCleanWorktree
  };
}

export function verifyGitIdentity(workspaceRoot: string, guard: GitIdentityGuard): GitIdentityObservation {
  const repositoryRootRaw = runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = fs.realpathSync.native(path.resolve(repositoryRootRaw));
  const head = runGit(workspaceRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (!FULL_GIT_SHA.test(head)) {
    throw new CodexProError(`Git identity guard received an invalid HEAD from git: ${head || "(empty)"}`);
  }
  const status = runGit(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const clean = status.length === 0;
  if (guard.expectedHead && head !== guard.expectedHead) {
    throw new CodexProError(
      `Git identity guard rejected start: expected HEAD ${guard.expectedHead}, observed ${head}. No command was started.`
    );
  }
  if (guard.requireCleanWorktree && !clean) {
    const entries = status.split(/\r?\n/).filter(Boolean);
    const preview = entries.slice(0, 5).join("; ");
    throw new CodexProError(
      `Git identity guard rejected start: worktree is not clean (${entries.length} status entr${entries.length === 1 ? "y" : "ies"}${preview ? `: ${preview}` : ""}). No command was started.`
    );
  }
  return {
    repositoryRoot,
    head,
    clean,
    verifiedAt: new Date().toISOString()
  };
}
