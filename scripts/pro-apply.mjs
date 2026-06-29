#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.log(`Apply a planning-model response to the agent handoff file

Usage:
  codexpro pro-apply --root /path/to/repo --file plan.md
  cat plan.md | codexpro pro-apply --root /path/to/repo --stdin

Options:
  --root <dir>       Workspace root. Default: current directory.
  --file <path>      Plan file to read.
  --stdin            Read the plan from stdin.
  --title <text>     Add a heading when the plan does not already start with one.
  --append           Append to .ai-bridge/current-plan.md instead of overwriting.
  --help             Show this message.
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    if (key === 'help') out.help = true;
    else if (key === 'stdin') out.stdin = true;
    else if (key === 'append') out.append = true;
    else {
      const next = inlineValue ?? argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for --${key}`);
      if (inlineValue === undefined) i += 1;
      out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = next;
    }
  }
  return out;
}

function requireBuild() {
  const distPath = path.resolve('dist/fsOps.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('Missing dist/fsOps.js. Run npm install && npm run build first.');
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function resolvePlanPath(args) {
  const callerCwd = process.env.CODEXPRO_CALLER_CWD || process.cwd();
  return path.isAbsolute(args.file) ? args.file : path.resolve(callerCwd, args.file);
}

async function readPlan(args) {
  if (args.stdin && args.file) throw new Error('Use either --stdin or --file, not both.');
  if (args.stdin) return readStdin();
  if (!args.file) throw new Error('Missing --file <path> or --stdin.');
  return fsp.readFile(resolvePlanPath(args), 'utf8');
}

function normalizePlan(rawPlan, title) {
  const trimmed = rawPlan.trim();
  if (!trimmed) throw new Error('Plan is empty.');
  if (trimmed.startsWith('#')) return `${trimmed}\n`;
  return `# ${title || 'Planning Model Handoff'}\n\nUpdated: ${new Date().toISOString()}\n\n${trimmed}\n`;
}

function jsonlEvent(event, data) {
  return `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  requireBuild();

  const [{ loadConfig }, { WorkspaceManager, PathGuard }, { ensureAiBridge, readTextFile, writeTextFile }] = await Promise.all([
    import('../dist/config.js'),
    import('../dist/guard.js'),
    import('../dist/fsOps.js')
  ]);

  const config = loadConfig(process.argv.slice(2));
  const guard = new PathGuard(config);
  const workspaces = new WorkspaceManager(config);
  const workspace = workspaces.openWorkspace(config.defaultRoot);

  const planPath = `${config.contextDir}/current-plan.md`;
  const rawPlan = await readPlan(args);
  const newPlan = normalizePlan(rawPlan, args.title);
  await ensureAiBridge(config, guard, workspace);
  let content = newPlan;

  if (args.append) {
    const resolved = guard.resolve(workspace, planPath);
    const existing = await readTextFile(config, guard, workspace, planPath, { maxBytes: config.maxReadBytes });
    const rawExisting = await fsp.readFile(resolved.absPath, 'utf8');
    content = `${rawExisting.trimEnd()}\n\n---\n\n${newPlan}`;
    void existing;
  }

  const result = await writeTextFile(config, guard, workspace, planPath, content, {
    createDirs: true,
    overwrite: true
  });

  const logRel = `${config.contextDir}/session-log.jsonl`;
  const executionLogRel = `${config.contextDir}/execution-log.jsonl`;
  const logResolved = guard.resolve(workspace, logRel, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogRel, { forWrite: true });
  const event = jsonlEvent('pro_apply', {
    plan_path: planPath,
    source_file: args.file ? resolvePlanPath(args) : 'stdin',
    append: Boolean(args.append)
  });
  await fsp.appendFile(logResolved.absPath, event, 'utf8');
  await fsp.appendFile(executionLogResolved.absPath, event, 'utf8');

  console.log(`Wrote ${path.join(workspace.root, planPath)}`);
  console.log(`Bytes: ${result.bytes}`);
  console.log(`Diff stats: +${result.diff.additions} -${result.diff.deletions}`);
  console.log(`Session log: ${path.join(workspace.root, logRel)}`);
  console.log(`Execution log: ${path.join(workspace.root, executionLogRel)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
