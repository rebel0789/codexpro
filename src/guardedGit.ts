import { spawnSync } from "node:child_process";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export type GitProfile = "agent" | "handoff";
const PROTECTED = new Set(["main", "master", "develop", "development", "production", "prod", "release", "staging"]);

function run(workspace: Workspace, args: string[], max = 120_000): string {
  const result = spawnSync("git", args, { cwd: workspace.root, encoding: "utf8", timeout: 30_000, maxBuffer: max, env: { ...process.env, NO_COLOR: "1" } });
  if (result.error || result.status !== 0) throw new CodexProError(redactSensitiveText((result.stderr || result.stdout || result.error?.message || "Git operation failed").trim()));
  return redactSensitiveText((result.stdout || "").trim());
}

function gh(workspace: Workspace, args: string[], max = 120_000): string {
  const result = spawnSync("gh", args, { cwd: workspace.root, encoding: "utf8", timeout: 30_000, maxBuffer: max, env: { ...process.env, NO_COLOR: "1", GH_PAGER: "cat" } });
  if (result.error || result.status !== 0) throw new CodexProError(redactSensitiveText((result.stderr || result.stdout || result.error?.message || "GitHub operation failed").trim()));
  return redactSensitiveText((result.stdout || "").trim());
}

function repo(workspace: Workspace): void { run(workspace, ["rev-parse", "--show-toplevel"]); }
function branch(workspace: Workspace): string { return run(workspace, ["branch", "--show-current"]); }
function head(workspace: Workspace): string { return run(workspace, ["rev-parse", "HEAD"]); }
function defaultBranch(workspace: Workspace): string {
  const ref = run(workspace, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  return ref.replace(/^refs\/remotes\/origin\//, "");
}
function protectedBranch(config: CodexProConfig, workspace: Workspace, name: string): boolean {
  let defaultName = "";
  try { defaultName = defaultBranch(workspace); } catch { /* no origin default */ }
  return PROTECTED.has(name) || config.protectedBranches.includes(name) || name === defaultName;
}
function validBranch(name: string): string {
  if (!name || name.startsWith("-") || name.includes("..") || name.includes("@{") || /[\x00-\x20~^:?*\\[\\\\]/.test(name)) throw new CodexProError("Invalid branch name.");
  return name;
}
function profile(config: CodexProConfig): GitProfile { return config.writeMode === "handoff" ? "handoff" : "agent"; }
export function gitCapability(config: CodexProConfig, kind: "write" | "push" | "pr"): boolean {
  const handoff = profile(config) === "handoff";
  return handoff ? (kind === "write" ? config.handoffGitWrite : kind === "push" ? config.handoffGitPush : config.handoffGithubPr) : (kind === "write" ? config.gitWrite : kind === "push" ? config.gitPush : config.githubPr);
}
export function gitToolNames(config: CodexProConfig): string[] {
  const names = ["git_current_state"];
  if (gitCapability(config, "write")) names.push("git_create_branch", "git_switch_branch", "git_stage_paths", "git_unstage_paths", "git_commit");
  if (gitCapability(config, "push")) names.push("git_push_current_branch");
  if (gitCapability(config, "pr")) names.push("github_create_pull_request");
  return names;
}
function checkConfirmation(value: boolean | undefined): void { if (value !== true) throw new CodexProError("Explicit confirmation is required."); }
function checkExpected(workspace: Workspace, expectedBranch?: string, expectedHead?: string): { branch: string; head: string } {
  const current = branch(workspace); const currentHead = head(workspace);
  if (expectedBranch && expectedBranch !== current) throw new CodexProError("Expected branch does not match current branch.");
  if (expectedHead && expectedHead !== currentHead) throw new CodexProError("Expected HEAD does not match current HEAD.");
  return { branch: current, head: currentHead };
}
function paths(config: CodexProConfig, guard: PathGuard, workspace: Workspace, input: string[]): string[] {
  if (!input.length) throw new CodexProError("At least one explicit path is required.");
  return input.map((item) => {
    if (!item || path.isAbsolute(item) || path.win32.isAbsolute(item) || item === "." || item.includes("*") || item.includes("?") || item.startsWith("-")) throw new CodexProError("Paths must be explicit workspace-relative file paths.");
    const rel = guard.resolve(workspace, item, { forWrite: true }).relPath;
    if (profile(config) === "handoff" && !config.handoffGitAllowedPaths.some((glob) => minimatch(rel, glob, { dot: true }))) throw new CodexProError(`Handoff Git path is outside the allowlist: ${rel}`);
    return rel;
  });
}
function staged(workspace: Workspace): string[] { const out = run(workspace, ["diff", "--cached", "--name-only"]); return out ? out.split("\n").filter(Boolean) : []; }
function assertHandoffStaged(config: CodexProConfig, workspace: Workspace): void {
  if (profile(config) !== "handoff") return;
  const outside = staged(workspace).filter((item) => !config.handoffGitAllowedPaths.some((glob) => minimatch(item, glob, { dot: true })));
  if (outside.length) throw new CodexProError(`Handoff commit refused: staged paths outside allowlist: ${outside.join(", ")}`);
}

export function currentState(config: CodexProConfig, workspace: Workspace): Record<string, unknown> {
  repo(workspace); const current = branch(workspace);
  const stagedFiles = staged(workspace);
  const unstagedOutput = run(workspace, ["diff", "--name-only"]); const unstagedFiles = unstagedOutput ? unstagedOutput.split("\n").filter(Boolean) : [];
  const untrackedOutput = run(workspace, ["ls-files", "--others", "--exclude-standard"]); const untrackedFiles = untrackedOutput ? untrackedOutput.split("\n").filter(Boolean) : [];
  let upstream: string | null = null; let ahead = 0; let behind = 0;
  try { upstream = run(workspace, ["rev-parse", "--abbrev-ref", "@{upstream}"]); const counts = run(workspace, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).split(/\s+/); ahead = Number(counts[0]) || 0; behind = Number(counts[1]) || 0; } catch { /* no upstream */ }
  return { root: workspace.root, branch: current, head: head(workspace), upstream, ahead, behind, staged_files: stagedFiles, unstaged_files: unstagedFiles, untracked_files: untrackedFiles, protected_branch: protectedBranch(config, workspace, current), clean: !stagedFiles.length && !unstagedFiles.length && !untrackedFiles.length };
}
export function createBranch(config: CodexProConfig, workspace: Workspace, name: string, start?: string): Record<string, unknown> {
  repo(workspace); name = validBranch(name); if (protectedBranch(config, workspace, name)) throw new CodexProError("Protected branch names cannot be created.");
  if (run(workspace, ["branch", "--list", name])) throw new CodexProError("Branch already exists.");
  if (start && (!/^[A-Za-z0-9._/-]+$/.test(start) || start.startsWith("-"))) throw new CodexProError("Invalid start point.");
  run(workspace, start ? ["switch", "-c", name, start] : ["switch", "-c", name]); return currentState(config, workspace);
}
export function switchBranch(config: CodexProConfig, workspace: Workspace, name: string): Record<string, unknown> {
  repo(workspace); name = validBranch(name); if (!run(workspace, ["branch", "--list", name])) throw new CodexProError("Local branch does not exist."); run(workspace, ["switch", name]); return currentState(config, workspace);
}
export function stagePaths(config: CodexProConfig, guard: PathGuard, workspace: Workspace, input: string[]): Record<string, unknown> { repo(workspace); const rel = paths(config, guard, workspace, input); run(workspace, ["add", "--", ...rel]); return currentState(config, workspace); }
export function unstagePaths(config: CodexProConfig, guard: PathGuard, workspace: Workspace, input: string[]): Record<string, unknown> { repo(workspace); const rel = paths(config, guard, workspace, input); run(workspace, ["restore", "--staged", "--", ...rel]); return currentState(config, workspace); }
export function commit(config: CodexProConfig, workspace: Workspace, message: string, expectedBranch?: string, expectedHead?: string, confirmation?: boolean): Record<string, unknown> {
  repo(workspace); checkConfirmation(confirmation); const current = checkExpected(workspace, expectedBranch, expectedHead); if (protectedBranch(config, workspace, current.branch)) throw new CodexProError("Commits to protected branches are blocked."); if (!message.trim()) throw new CodexProError("Commit message is required."); assertHandoffStaged(config, workspace); const files = staged(workspace); if (!files.length) throw new CodexProError("No staged changes to commit."); run(workspace, ["commit", "-m", message]); return { ...currentState(config, workspace), committed_files: files, subject: run(workspace, ["log", "-1", "--format=%s"]) };
}
export function push(config: CodexProConfig, workspace: Workspace, remote: string | undefined, expectedBranch: string, expectedHead: string, confirmation?: boolean): Record<string, unknown> {
  repo(workspace); checkConfirmation(confirmation); const current = checkExpected(workspace, expectedBranch, expectedHead); if (protectedBranch(config, workspace, current.branch)) throw new CodexProError("Pushes to protected branches are blocked."); const target = remote || "origin"; if (!/^[A-Za-z0-9._-]+$/.test(target) || !run(workspace, ["remote"]).split("\n").includes(target)) throw new CodexProError("Remote must be an existing configured remote name."); run(workspace, ["push", "-u", target, current.branch]); return { remote: target, branch: current.branch, head: current.head, upstream: `${target}/${current.branch}` };
}
export function createPullRequest(config: CodexProConfig, workspace: Workspace, title: string, body: string, base: string | undefined, draft: boolean | undefined, expectedBranch: string, expectedHead: string, confirmation?: boolean): Record<string, unknown> {
  repo(workspace); checkConfirmation(confirmation); const current = checkExpected(workspace, expectedBranch, expectedHead); if (protectedBranch(config, workspace, current.branch)) throw new CodexProError("Protected branches cannot be PR heads."); const target = base || defaultBranch(workspace); if (!title.trim() || target === current.branch) throw new CodexProError("PR title is required and base must differ from head."); run(workspace, ["rev-parse", "--verify", "@{upstream}"]);
  const existing = gh(workspace, ["pr", "list", "--head", current.branch, "--base", target, "--state", "open", "--json", "number,url,title,baseRefName,headRefName,isDraft"]); const found = JSON.parse(existing || "[]")[0];
  if (found) return { number: found.number, url: found.url, title: found.title, base: found.baseRefName, head: found.headRefName, draft: found.isDraft, existing: true };
  const output = gh(workspace, ["pr", "create", "--title", title, "--body", body, "--base", target, ...(draft === false ? [] : ["--draft"])]); return { url: output, title, base: target, head: current.branch, draft: draft !== false, existing: false };
}
