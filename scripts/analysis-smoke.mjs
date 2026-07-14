import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-analysis-'));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-analysis-outside-'));

async function write(relativePath, content) {
  const target = path.join(tmp, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

try {
  await write('package.json', JSON.stringify({ name: 'fixture', packageManager: 'pnpm@9.15.0', scripts: { test: 'node --test' } }, null, 2));
  await write('src/index.ts', "import { authenticate } from './auth.js';\nexport const ready = authenticate('demo');\n");
  await write('src/auth.ts', 'export function authenticate(user: string) { return Boolean(user); }\n');
  await write('src/race.ts', 'export function temporaryFile() { return true; }\n');
  await write('test/auth.test.ts', "import { authenticate } from '../src/auth.js';\nvoid authenticate('test');\n");
  await write('README.md', '# Fixture\n');
  await write('.env', 'PRIVATE_TOKEN=never-visible\n');
  await write('python/service.py', 'def load_user(user_id):\n    return user_id\n');
  await write('go/service.go', 'package service\nfunc LoadUser(id string) string { return id }\n');
  await write('go.mod', 'module example.com/fixture\n\ngo 1.24\n');
  await write('rust/service.rs', 'pub fn load_user(id: &str) -> &str { id }\n');
  await write('swift/Service.swift', 'public func loadUser(_ id: String) -> String { id }\n');
  await write('java/Service.java', 'public class Service { }\n');
  await write('csharp/Service.cs', 'public class Service { }\n');
  await write('c/service.c', 'int load_user(int id) { return id; }\n');
  await write('cpp/service.cpp', 'class Service { };\n');
  await write('notes/many.txt', Array.from({ length: 20 }, (_, index) => `common marker ${index}`).join('\n') + '\n');
  await write('unknown/service.zig', 'pub fn loadUser() void {}\n');
  await write('packages/core/package.json', JSON.stringify({ name: '@fixture/core' }, null, 2));
  await write('packages/core/src/index.ts', 'export function coreValue() { return 1; }\n');
  await write('packages/web/package.json', JSON.stringify({ name: '@fixture/web', dependencies: { '@fixture/core': 'workspace:*' } }, null, 2));
  await write('packages/web/src/index.ts', "import { coreValue } from '../../core/src/index.js';\nexport const webValue = coreValue();\n");
  await fs.writeFile(path.join(outside, 'outside.ts'), 'export const outside = true;\n', 'utf8');
  let symlinkCreated = false;
  try {
    await fs.symlink(outside, path.join(tmp, 'outside-link'), 'dir');
    symlinkCreated = true;
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  }

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { inventoryWorkspace }, { extractWorkspaceFiles }, classification, analysisApi] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('analysis/inventory.js'),
    importBuilt('analysis/extract.js'),
    importBuilt('analysis/classify.js'),
    importBuilt('analysis/index.js')
  ]);
  const config = loadConfig(['--root', tmp, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  const result = await inventoryWorkspace(config, guard, workspace);

  assert(result.files.some((file) => file.path === 'src/index.ts' && file.language === 'typescript' && file.role === 'source'));
  assert(result.files.some((file) => file.path === 'test/auth.test.ts' && file.role === 'test'));
  assert(!result.files.some((file) => file.path === '.env'));
  assert(classification.detectProjectTypes(result.files).includes('node'));
  assert(result.files.some((file) => file.path === 'src/index.ts' && file.entrypoint === true));
  assert.equal(result.coverage.inventoryFiles, result.files.length);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert(result.files.some((file) => file.path === 'unknown/service.zig' && file.language === 'unknown'));
  if (symlinkCreated) assert(!result.files.some((file) => file.path.startsWith('outside-link/')));
  await fs.rm(path.join(tmp, 'src', 'race.ts'));
  const changedDuringScan = await extractWorkspaceFiles(config, guard, workspace, result.files);
  assert.equal(changedDuringScan.truncated, true);
  assert(changedDuringScan.warnings.some((warning) => warning.includes('changed or became unreadable')));

  const analysis = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert(analysis.symbols.some((symbol) => symbol.name === 'authenticate' && symbol.kind === 'function' && symbol.path === 'src/auth.ts'));
  assert(analysis.relationships.some((edge) => edge.from === 'src/index.ts' && edge.to === 'src/auth.ts' && edge.kind === 'imports'));
  assert(analysis.relationships.some((edge) => edge.from === 'packages/web/src/index.ts' && edge.to === 'packages/core/src/index.ts' && edge.kind === 'imports'));

  const expectedSymbols = [
    ['python/service.py', 'load_user'],
    ['go/service.go', 'LoadUser'],
    ['rust/service.rs', 'load_user'],
    ['swift/Service.swift', 'loadUser'],
    ['java/Service.java', 'Service'],
    ['csharp/Service.cs', 'Service'],
    ['c/service.c', 'load_user'],
    ['cpp/service.cpp', 'Service']
  ];
  for (const [file, name] of expectedSymbols) {
    assert(analysis.symbols.some((symbol) => symbol.path === file && symbol.name === name), `missing ${name} in ${file}`);
  }

  const structured = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'authenticate',
    intent: 'symbol',
    includeTests: true
  });
  assert.equal(structured.groups.definitions[0]?.path, 'src/auth.ts');
  assert(structured.groups.tests.some((match) => match.path === 'test/auth.test.ts'));
  assert(structured.groups.definitions[0].reasons.includes('symbol definition'));
  const impactSearch = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'authenticate',
    intent: 'impact',
    includeTests: true
  });
  assert(impactSearch.groups.references.some((match) => match.path === 'src/index.ts' && match.reasons.includes('dependent module')));
  assert(impactSearch.groups.tests.some((match) => match.path === 'test/auth.test.ts' && match.reasons.includes('dependent test')));

  const cached = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert.equal(cached.cache.hit, true);
  await fs.appendFile(path.join(tmp, 'src/auth.ts'), 'export function authorize() { return true; }\n', 'utf8');
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const refreshed = await analysisApi.inspectWorkspace(config, guard, workspace);
  assert.equal(refreshed.cache.hit, false);
  assert(refreshed.symbols.some((symbol) => symbol.name === 'authorize'));

  const review = await analysisApi.reviewWorkspaceChanges(config, guard, workspace, { changedPaths: ['src/auth.ts'] });
  assert(review.affectedAreas.includes('src'));
  assert(review.dependentFiles.some((file) => file.path === 'src/index.ts'));
  assert(review.relatedTests.some((file) => file.path === 'test/auth.test.ts'));
  assert(review.riskSignals.some((risk) => risk.id === 'authentication'));
  assert(review.recommendedCommands.some((item) => item.command === 'pnpm test' && item.source === 'package.json'));
  assert(review.recommendedCommands.some((item) => item.command === 'go test ./...' && item.source === 'go.mod'));

  const symbolLimitedConfig = {
    ...config,
    analysisLimits: { ...config.analysisLimits, maxSymbols: 2 }
  };
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const symbolLimited = await analysisApi.inspectWorkspace(symbolLimitedConfig, guard, workspace);
  assert.equal(symbolLimited.symbols.length, 2);
  assert.equal(symbolLimited.coverage.truncated, true);
  assert(symbolLimited.warnings.some((warning) => warning.includes('Symbol extraction reached')));

  const searchLimitedConfig = {
    ...config,
    analysisLimits: { ...config.analysisLimits, maxAnalyzedFiles: 1 }
  };
  analysisApi.invalidateWorkspaceAnalysis(workspace.id);
  const searchLimited = await analysisApi.searchWorkspaceStructured(searchLimitedConfig, guard, workspace, {
    query: 'authenticate',
    intent: 'symbol',
    includeTests: true
  });
  assert.equal(searchLimited.coverage.truncated, true);
  assert(searchLimited.warnings.some((warning) => warning.includes('Grouped search reached')));

  const scoped = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'coreValue',
    intent: 'symbol',
    root: 'src'
  });
  assert.equal(scoped.matches.length, 0);

  const unsupportedRegex = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: '(?i)authenticate',
    intent: 'text',
    regex: true
  });
  assert.equal(unsupportedRegex.matches.length, 0);
  assert(unsupportedRegex.warnings.some((warning) => warning.includes('regular expression')));

  const candidateLimited = await analysisApi.searchWorkspaceStructured(config, guard, workspace, {
    query: 'common marker',
    intent: 'text',
    maxResults: 2
  });
  assert.equal(candidateLimited.matches.length, 2);
  assert.equal(candidateLimited.coverage.truncated, true);
  assert(candidateLimited.warnings.some((warning) => warning.includes('retained the first 8 candidates')));

  console.log('✓ analysis smoke test passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
