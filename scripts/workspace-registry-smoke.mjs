import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { loadConfig } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href);
const { CodexProError, WorkspaceManager, WorkspaceRegistry } = await import(
  pathToFileURL(path.join(path.resolve('.'), 'dist', 'guard.js')).href
);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectError(fn, pattern, message) {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (pattern.test(text)) return text;
    throw new Error(`${message}: unexpected error ${text}`);
  }
  throw new Error(message);
}

const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codexpro-ws-parent-'));
const nestedA = path.join(parent, 'worktree-a');
const nestedB = path.join(parent, 'worktree-b');
await fs.promises.mkdir(nestedA);
await fs.promises.mkdir(nestedB);
await fs.promises.writeFile(path.join(parent, 'known-file.txt'), 'parent workspace\n', 'utf8');
await fs.promises.writeFile(path.join(nestedA, 'known-file.txt'), 'worktree a\n', 'utf8');
await fs.promises.writeFile(path.join(nestedB, 'known-file.txt'), 'worktree b\n', 'utf8');

const escapeLink = path.join(parent, 'escape-link');
await fs.promises.symlink('/etc', escapeLink);

const previousRoot = process.env.CODEXPRO_ROOT;
const previousAllowed = process.env.CODEXPRO_ALLOWED_ROOTS;
const previousAllowHome = process.env.CODEXPRO_ALLOW_HOME;
delete process.env.CODEXPRO_ROOT;
delete process.env.CODEXPRO_ALLOWED_ROOTS;
delete process.env.CODEXPRO_ALLOW_HOME;

try {
  const config = loadConfig(['--root', parent, '--allow-root', parent, '--bash', 'off']);
  const registry = new WorkspaceRegistry();
  const sessionA = new WorkspaceManager(config, { registry });
  const sessionB = new WorkspaceManager(config, { registry });
  const isolated = new WorkspaceManager(config);

  const openedA = sessionA.openWorkspace(nestedA);
  const openedAAgain = sessionA.openWorkspace(nestedA);
  expect(openedA.id === openedAAgain.id, 'same nested root should reuse a stable workspace_id');
  expect(openedA.root === fs.realpathSync.native(nestedA), `opened A root was ${openedA.root}`);

  const openedB = sessionA.openWorkspace(nestedB);
  expect(openedA.id !== openedB.id, 'distinct nested roots must receive distinct ids');

  const resolvedFromB = sessionB.getWorkspace(openedA.id);
  expect(resolvedFromB.root === openedA.root, 'shared registry must resolve a dynamic id from another manager');
  expect(resolvedFromB.id === openedA.id, 'shared registry must not remap a resolved id');

  const selectedOnB = sessionB.getWorkspace();
  expect(selectedOnB.root === config.defaultRoot, `session B omit-id must stay on default, got ${selectedOnB.root}`);
  expect(selectedOnB.id !== openedA.id, 'opening a workspace in session A must not select it in session B');

  sessionB.openWorkspace(nestedB);
  const explicitAWhileBSelected = sessionB.getWorkspace(openedA.id);
  expect(explicitAWhileBSelected.root === openedA.root, 'explicit id must beat session-local selection');

  sessionB.selectDefaultWorkspace();
  const stillA = sessionB.getWorkspace(openedA.id);
  expect(stillA.root === openedA.root, 'open_current/default must not unregister a dynamic workspace');

  const againA = sessionB.getWorkspace(openedA.id);
  expect(againA.root === openedA.root, 'dynamic workspace must remain after resolving another workspace');

  const isolatedLookup = expectError(
    () => isolated.getWorkspace(openedA.id),
    /Unknown workspace_id/,
    'private registry must not see another manager\'s dynamic workspace'
  );
  expect(!isolatedLookup.includes(parent), 'unknown-id error must not include another workspace root');

  const unknown = expectError(
    () => sessionB.getWorkspace('ws_does_not_exist'),
    /Unknown workspace_id: ws_does_not_exist/,
    'unknown workspace_id must fail closed'
  );
  expect(!unknown.toLowerCase().includes(path.basename(parent).toLowerCase()), 'unknown-id error must not resolve the default workspace');
  expect(sessionB.getWorkspace().root === config.defaultRoot, 'failed unknown-id lookup must not change the selected workspace');

  expectError(
    () => sessionA.openWorkspace('/tmp'),
    /outside allowed roots/,
    '/tmp must remain outside allowedRoots'
  );
  expectError(
    () => sessionA.openWorkspace(os.homedir()),
    /outside allowed roots/,
    'home directory must remain outside allowedRoots'
  );
  expectError(
    () => sessionA.openWorkspace('/etc'),
    /outside allowed roots/,
    '/etc must remain outside allowedRoots'
  );
  expectError(
    () => sessionA.openWorkspace(escapeLink),
    /outside allowed roots/,
    'symlink escaping allowedRoots must be rejected after canonicalization'
  );

  const listed = sessionB.listWorkspaces().map((workspace) => workspace.id);
  expect(listed.includes(openedA.id) && listed.includes(openedB.id), 'shared registry list must keep both dynamic workspaces');
} finally {
  if (previousRoot === undefined) delete process.env.CODEXPRO_ROOT;
  else process.env.CODEXPRO_ROOT = previousRoot;
  if (previousAllowed === undefined) delete process.env.CODEXPRO_ALLOWED_ROOTS;
  else process.env.CODEXPRO_ALLOWED_ROOTS = previousAllowed;
  if (previousAllowHome === undefined) delete process.env.CODEXPRO_ALLOW_HOME;
  else process.env.CODEXPRO_ALLOW_HOME = previousAllowHome;
  await fs.promises.rm(parent, { recursive: true, force: true });
}

console.log('✓ workspace registry smoke test passed');
