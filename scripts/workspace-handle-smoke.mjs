import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const guardUrl = new URL('../dist/guard.js', import.meta.url).href;

function runNode(code, args = []) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`child process failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-workspace-handle-root-'));
const project = path.join(root, 'project');
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-workspace-handle-outside-'));
await fs.mkdir(project);

const openCode = `
  import fs from 'node:fs';
  import { WorkspaceManager } from ${JSON.stringify(guardUrl)};
  const [root, project] = process.argv.slice(1);
  const realRoot = fs.realpathSync.native(root);
  const manager = new WorkspaceManager({ defaultRoot: realRoot, allowedRoots: [realRoot] });
  console.log(manager.openWorkspace(project).id);
`;

const resolveCode = `
  import fs from 'node:fs';
  import { WorkspaceManager } from ${JSON.stringify(guardUrl)};
  const [root, workspaceId] = process.argv.slice(1);
  const realRoot = fs.realpathSync.native(root);
  const manager = new WorkspaceManager({ defaultRoot: realRoot, allowedRoots: [realRoot] });
  const workspace = manager.getWorkspace(workspaceId);
  console.log(JSON.stringify(workspace));
`;

const rejectOutsideCode = `
  import fs from 'node:fs';
  import { WorkspaceManager } from ${JSON.stringify(guardUrl)};
  const [root, workspaceId] = process.argv.slice(1);
  const realRoot = fs.realpathSync.native(root);
  const manager = new WorkspaceManager({ defaultRoot: realRoot, allowedRoots: [realRoot] });
  try {
    manager.getWorkspace(workspaceId);
    console.error('outside workspace unexpectedly resolved');
    process.exit(2);
  } catch (error) {
    if (!String(error?.message ?? error).includes('outside allowed roots')) {
      console.error(String(error?.stack ?? error));
      process.exit(3);
    }
    console.log('blocked');
  }
`;

try {
  const workspaceId = runNode(openCode, [root, project]);
  if (!/^ws_[0-9a-f]{24}_[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new Error(`workspace id is not a stable self-describing handle: ${workspaceId}`);
  }

  // This runs in a fresh Node process: no process-local workspace catalog exists.
  const resolved = JSON.parse(runNode(resolveCode, [root, workspaceId]));
  const realProject = await fs.realpath(project);
  if (resolved.id !== workspaceId || resolved.root !== realProject) {
    throw new Error(`restart-stable workspace resolution mismatch: ${JSON.stringify(resolved)}`);
  }

  // Legacy hash-only ids remain valid for configured roots.
  const realRoot = await fs.realpath(root);
  const legacyId = `ws_${createHash('sha256').update(realRoot).digest('hex').slice(0, 24)}`;
  const legacyResolved = JSON.parse(runNode(resolveCode, [realRoot, legacyId]));
  if (legacyResolved.root !== realRoot) {
    throw new Error(`legacy configured-root workspace id no longer resolves: ${JSON.stringify(legacyResolved)}`);
  }

  // A self-describing id is not an authority grant; another process must still
  // reject a decoded root that is outside its configured allowlist.
  const outsideId = runNode(openCode, [outside, outside]);
  if (runNode(rejectOutsideCode, [root, outsideId]) !== 'blocked') {
    throw new Error('outside-root workspace handle was not rejected');
  }

  console.log('✓ workspace handle restart smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
