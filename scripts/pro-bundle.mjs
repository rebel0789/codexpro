#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`CodexPro context bundle

Usage:
  codexpro pro-bundle --root /path/to/repo --copy
  codexpro pro-bundle --root /path/to/repo --path src/App.tsx --glob "src/**/*.ts"

Options:
  --root <dir>              Workspace root. Default: current directory.
  --path <file>             Extra file to include. Can be repeated.
  --glob <pattern>          Extra glob to include. Can be repeated.
  --title <text>            Context title.
  --max-files <n>           Maximum file contents to include. Default: 24.
  --max-file-bytes <n>      Maximum bytes per included file. Default: 60000.
  --max-total-bytes <n>     Maximum bytes in .ai-bridge/pro-context.md.
  --no-important-files      Do not auto-include root config/docs such as AGENTS.md, README.md, package.json.
  --no-changed-files        Do not auto-include currently changed files from git status.
  --no-diff                 Do not include git diff.
  --no-ai-bridge            Do not include existing .ai-bridge files.
  --copy                    Copy generated context to the macOS clipboard with pbcopy.
  --help                    Show this message.
`);
}

function parseArgs(argv) {
  const out = { paths: [], globs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    if (key === 'help') out.help = true;
    else if (key === 'copy') out.copy = true;
    else if (key === 'no-important-files') out.noImportantFiles = true;
    else if (key === 'no-changed-files') out.noChangedFiles = true;
    else if (key === 'no-diff') out.noDiff = true;
    else if (key === 'no-ai-bridge') out.noAiBridge = true;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      i += 1;
      if (key === 'path') out.paths.push(next);
      else if (key === 'glob') out.globs.push(next);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
    }
  }
  return out;
}

function requireBuild() {
  const distPath = path.resolve('dist/proContext.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('Missing dist/proContext.js. Run npm install && npm run build first.');
  }
}

function numberArg(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  requireBuild();

  const [{ loadConfig }, { WorkspaceManager, PathGuard }, { exportProContext }] = await Promise.all([
    import('../dist/config.js'),
    import('../dist/guard.js'),
    import('../dist/proContext.js')
  ]);

  const config = loadConfig(process.argv.slice(2));
  const guard = new PathGuard(config);
  const workspaces = new WorkspaceManager(config);
  const workspace = workspaces.openWorkspace(config.defaultRoot);
  const result = await exportProContext(config, guard, workspace, {
    title: args.title,
    selectedPaths: args.paths,
    extraGlobs: args.globs,
    includeImportantFiles: !args.noImportantFiles,
    includeChangedFiles: !args.noChangedFiles,
    includeDiff: !args.noDiff,
    includeAiBridge: !args.noAiBridge,
    maxFiles: numberArg(args.maxFiles),
    maxFileBytes: numberArg(args.maxFileBytes),
    maxTotalBytes: numberArg(args.maxTotalBytes)
  });

  const absPath = path.join(workspace.root, result.path);
  console.log(`Wrote ${absPath}`);
  console.log(`Bytes: ${result.bytes}`);
  console.log(`Files included: ${result.filesIncluded.length}`);
  console.log(`Files skipped: ${result.filesSkipped.length}`);
  console.log(`Truncated: ${result.truncated}`);

  if (args.copy) {
    const copied = spawnSync('pbcopy', { input: result.markdown, encoding: 'utf8' });
    if (copied.status !== 0) {
      throw new Error(`pbcopy failed: ${copied.stderr || copied.error?.message || `exit ${copied.status}`}`);
    }
    console.log('Copied Pro context to clipboard.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
