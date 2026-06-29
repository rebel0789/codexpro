import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(encode(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));

function assertCommand(args, expected) {
  const result = spawnSync(process.execPath, args, { cwd: path.resolve('.'), encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  if (!result.stdout.includes(expected)) {
    throw new Error(`${args.join(' ')} did not print ${expected}: ${result.stdout}`);
  }
}

assertCommand(['dist/stdio.js', '--version'], pkg.version);
assertCommand(['dist/stdio.js', '--help'], 'CodexPro MCP stdio server');
assertCommand(['dist/http.js', '--version'], pkg.version);
assertCommand(['dist/http.js', '--help'], 'CodexPro MCP HTTP server');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-smoke-'));
await fs.writeFile(path.join(tmp, 'demo.txt'), 'alpha\nread\nread\nomega\n', 'utf8');
await fs.writeFile(path.join(tmp, 'config.txt'), 'OPENAI_API_KEY=sk-realSecretValue123\n', 'utf8');
await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# Smoke Agents\n\n- Preserve demo.txt.\n', 'utf8');
const codexHistoryDir = path.join(tmp, 'codex-history');
const codexSessionDir = path.join(codexHistoryDir, 'sessions', '2026', '06', '20');
await fs.mkdir(codexSessionDir, { recursive: true });
const codexSessionPath = path.join(codexSessionDir, 'rollout-2026-06-20T01-02-03-019cc369-bd7c-7891-b371-7b20b4fe0b18.jsonl');
await fs.writeFile(codexSessionPath, [
  JSON.stringify({ timestamp: '2026-06-20T01:02:03Z', type: 'session_meta', payload: { id: '019cc369-bd7c-7891-b371-7b20b4fe0b18', cwd: tmp } }),
  JSON.stringify({ timestamp: '2026-06-20T01:02:04Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Fix the smoke session browser' } }),
  JSON.stringify({ timestamp: '2026-06-20T01:02:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Session browser plan.' } }),
  JSON.stringify({ timestamp: '2026-06-20T01:02:06Z', type: 'response_item', payload: { type: 'function_call', name: 'bash' } }),
  JSON.stringify({ timestamp: '2026-06-20T01:02:07Z', type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } })
].join('\n') + '\n', 'utf8');
const olderCodexSessionId = '019cc368-1111-7222-8333-123456789abc';
await fs.writeFile(path.join(codexSessionDir, `rollout-2026-06-19T01-02-03-${olderCodexSessionId}.jsonl`), [
  JSON.stringify({ timestamp: '2026-06-19T01:02:03Z', type: 'session_meta', payload: { id: olderCodexSessionId, cwd: tmp } }),
  JSON.stringify({ timestamp: '2026-06-19T01:02:04Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Older session still readable by id' } })
].join('\n') + '\n', 'utf8');
const largeCodexSessionId = '019cc367-aaaa-7333-8444-123456789def';
await fs.writeFile(path.join(codexSessionDir, `rollout-2026-06-18T01-02-03-${largeCodexSessionId}.jsonl`), [
  JSON.stringify({ timestamp: '2026-06-18T01:02:03Z', type: 'session_meta', payload: { id: largeCodexSessionId, cwd: tmp } }),
  JSON.stringify({ timestamp: '2026-06-18T01:02:04Z', type: 'response_item', payload: { type: 'message', role: 'user', content: 'Large metadata session' } }),
  JSON.stringify({ timestamp: '2026-06-18T01:02:05Z', type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(140000) } }),
  JSON.stringify({ timestamp: '2026-06-18T01:02:06Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'Large tail summary' } })
].join('\n') + '\n', 'utf8');
await fs.mkdir(path.join(tmp, '.codex', 'skills', 'smoke-skill'), { recursive: true });
await fs.writeFile(path.join(tmp, '.codex', 'skills', 'smoke-skill', 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: Smoke test skill discovery.',
  '---',
  '',
  '# Smoke Skill',
  ''
].join('\n'), 'utf8');
await fs.mkdir(path.join(tmp, '.agents', 'skills', 'smoke-skill'), { recursive: true });
await fs.writeFile(path.join(tmp, '.agents', 'skills', 'smoke-skill', 'SKILL.md'), [
  '---',
  'name: smoke-skill',
  'description: Duplicate smoke test skill discovery.',
  '---',
  '',
  '# Duplicate Smoke Skill',
  ''
].join('\n'), 'utf8');
const outsideSkillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-outside-skills-'));
await fs.mkdir(path.join(outsideSkillRoot, 'outside-skill'), { recursive: true });
await fs.writeFile(path.join(outsideSkillRoot, 'outside-skill', 'SKILL.md'), [
  '---',
  'name: outside-skill',
  'description: Outside workspace skill.',
  '---',
  '',
  '# Outside Skill',
  ''
].join('\n'), 'utf8');
try {
  await fs.symlink(outsideSkillRoot, path.join(tmp, 'skills'), 'dir');
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
}
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
  scripts: {
    'build:clients': "node -e \"console.log('clients ok')\""
  }
}, null, 2), 'utf8');
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-outside-'));
await fs.writeFile(path.join(outside, 'secret.txt'), 'do-not-read', 'utf8');
const danglingSymlinks = [];
for (const [linkPath, targetPath] of [
  ['dangling-outside.txt', path.join(outside, 'created-outside.txt')],
  ['dangling-env.txt', path.join(tmp, '.env')]
]) {
  try {
    await fs.symlink(targetPath, path.join(tmp, linkPath));
    danglingSymlinks.push(linkPath);
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  }
}
let symlinkEscapePath = 'secret-link.txt';
try {
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(tmp, symlinkEscapePath));
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  symlinkEscapePath = 'secret-link-dir/secret.txt';
  await fs.symlink(outside, path.join(tmp, 'secret-link-dir'), 'junction');
}
for (const args of [['init'], ['add', 'demo.txt', 'AGENTS.md', 'package.json']]) {
  const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}
const commitResult = spawnSync('git', ['-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke Test', 'commit', '-m', 'initial smoke fixture'], { cwd: tmp, encoding: 'utf8' });
if (commitResult.status !== 0) {
  throw new Error(`git commit failed: ${commitResult.stderr || commitResult.stdout}`);
}

const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_WIDGET_DOMAIN: 'https://widgets.codexpro.test', CODEXPRO_TOOL_CARDS: '0' }
});

await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-smoke', version: '0.1.0' }
});
client.notify('notifications/initialized');
const tools = await client.request('tools/list', {});
const toolNames = tools.tools.map((tool) => tool.name);
for (const expected of ['server_config', 'codexpro_self_test', 'codexpro_inventory', 'list_workspaces', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'tree', 'search', 'load_skill', 'read', 'write', 'edit', 'bash', 'git_status', 'git_diff', 'show_changes', 'read_handoff', 'wait_for_handoff', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}
const toolCardUri = 'ui://widget/codexpro-tool-card-v9.html';
const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
function hasWidgetMeta(name) {
  const meta = toolsByName.get(name)?._meta ?? {};
  return meta.ui?.resourceUri === toolCardUri && meta['openai/outputTemplate'] === toolCardUri;
}
function hasToolCardStatusMeta(name) {
  const meta = toolsByName.get(name)?._meta ?? {};
  return Boolean(meta['openai/toolInvocation/invoking'] || meta['openai/toolInvocation/invoked']);
}
async function expectToolError(name, args, pattern, targetClient = client) {
  const result = await targetClient.request('tools/call', { name, arguments: args });
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} error did not match ${pattern}: ${text}`);
  }
}
for (const visualTool of toolNames) {
  if (hasWidgetMeta(visualTool) || hasToolCardStatusMeta(visualTool)) throw new Error(`${visualTool} exposed widget metadata while CODEXPRO_TOOL_CARDS is off`);
}
const cardClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_CARDS: '1' }
});
await cardClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-smoke-card-opt-in', version: '0.1.0' }
});
cardClient.notify('notifications/initialized');
const cardTools = await cardClient.request('tools/list', {});
const cardSearchMeta = cardTools.tools.find((tool) => tool.name === 'search')?._meta ?? {};
if (cardSearchMeta.ui?.resourceUri !== toolCardUri || cardSearchMeta['openai/outputTemplate'] !== toolCardUri) {
  throw new Error('CODEXPRO_TOOL_CARDS=1 did not opt search into widget metadata');
}
const cardOpened = await cardClient.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
const cardSearch = await cardClient.request('tools/call', {
  name: 'search',
  arguments: { workspace_id: cardOpened.structuredContent.workspace_id, query: 'read', path: 'demo.txt', max_results: 5 }
});
if (!cardSearch.structuredContent.text?.includes('read')) {
  throw new Error(`CODEXPRO_TOOL_CARDS=1 search did not include structured text: ${JSON.stringify(cardSearch.structuredContent)}`);
}
await cardClient.close();
const resources = await client.request('resources/list', {});
const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
if (!toolCard) throw new Error(`missing tool-card resource: ${toolCardUri}`);
if (toolCard.mimeType !== 'text/html;profile=mcp-app') throw new Error(`unexpected tool-card mime type: ${toolCard.mimeType}`);
const legacyToolCardUri = 'ui://widget/codexpro-tool-card-v8.html';
const legacyToolCard = resources.resources.find((resource) => resource.uri === legacyToolCardUri);
if (!legacyToolCard) throw new Error(`missing legacy tool-card resource: ${legacyToolCardUri}`);
const widget = await client.request('resources/read', { uri: toolCardUri });
const widgetText = widget.contents?.[0]?.text ?? '';
const widgetMeta = widget.contents?.[0]?._meta ?? {};
if (!widgetText.includes('Waiting for tool result') || !widgetText.includes('renderWorkspace') || !widgetText.includes('renderSelfTest') || !widgetText.includes('details class="fold"') || !widgetText.includes('ui/notifications/tool-result')) {
  throw new Error('tool-card widget resource did not include expected Apps bridge code');
}
if (!widgetMeta.ui?.csp || !widgetMeta['openai/widgetCSP']) {
  throw new Error('tool-card widget resource did not expose standard and ChatGPT CSP metadata');
}
if (widgetMeta.ui?.domain !== 'https://widgets.codexpro.test' || widgetMeta['openai/widgetDomain'] !== 'https://widgets.codexpro.test') {
  throw new Error('tool-card widget resource did not expose standard and ChatGPT widget domain metadata');
}
const legacyWidget = await client.request('resources/read', { uri: legacyToolCardUri });
if (legacyWidget.contents?.[0]?.uri !== legacyToolCardUri) {
  throw new Error('legacy tool-card widget resource did not preserve requested URI');
}
if (!(legacyWidget.contents?.[0]?.text ?? '').includes('Waiting for tool result')) {
  throw new Error('legacy tool-card widget resource did not serve widget HTML');
}
const current = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
const realTmp = await fs.realpath(tmp);
if (current.structuredContent.root !== realTmp) throw new Error(`open_current_workspace opened ${current.structuredContent.root}, expected ${realTmp}`);
if (current.structuredContent.codexpro_tool !== 'open_current_workspace') throw new Error('tool result was not tagged for widget rendering');
if (current.structuredContent.tool_mode !== 'full') throw new Error(`open_current_workspace did not expose tool_mode: ${current.structuredContent.tool_mode}`);
if (current.structuredContent.skill_inventory?.length) {
  throw new Error('open_current_workspace discovered skills by default');
}
const currentWithSkills = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false, include_skills: true } });
if (!currentWithSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'smoke-skill')) {
  throw new Error('open_current_workspace did not discover workspace skill inventory when requested');
}
if (currentWithSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'outside-skill')) {
  throw new Error('open_current_workspace followed a symlinked workspace skill root outside the workspace');
}
const selfTest = await client.request('tools/call', {
  name: 'codexpro_self_test',
  arguments: {
    workspace_id: current.structuredContent.workspace_id,
    max_skills: 12
  }
});
if (selfTest.structuredContent.status === 'fail' || !selfTest.structuredContent.expected_tools?.includes?.('codexpro_self_test')) {
  throw new Error(`codexpro_self_test failed: ${JSON.stringify(selfTest.structuredContent)}`);
}
if (JSON.stringify([...(selfTest.structuredContent.expected_tools ?? [])].sort()) !== JSON.stringify([...(selfTest.structuredContent.registered_tools ?? [])].sort())) {
  throw new Error(`codexpro_self_test expected/registered tools mismatch: ${JSON.stringify(selfTest.structuredContent)}`);
}
if (!selfTest.structuredContent.files_touched?.includes?.('.ai-bridge/codexpro-self-test.md')) {
  throw new Error('codexpro_self_test did not run the .ai-bridge write/edit probe');
}
const snapshotAlias = await client.request('tools/call', {
  name: 'workspace_snapshot',
  arguments: {
    workspace_id: current.structuredContent.workspace_id,
    max_depth: 1,
    max_files: 20,
    include_skills: false
  }
});
if (!snapshotAlias.structuredContent.tree) {
  throw new Error('workspace_snapshot did not accept max_files alias or return a tree');
}
await expectToolError('load_skill', { name: 'smoke-skill', source: 'workspace' }, /Multiple skills named smoke-skill/);
const loadedSkill = await client.request('tools/call', {
  name: 'load_skill',
  arguments: {
    name: 'smoke-skill',
    source: 'workspace',
    path: '$WORKSPACE/.codex/skills/smoke-skill/SKILL.md'
  }
});
if (loadedSkill.structuredContent.skill?.name !== 'smoke-skill' || !loadedSkill.structuredContent.text?.includes('# Smoke Skill')) {
  throw new Error('load_skill did not return bounded SKILL.md content for smoke-skill');
}
await expectToolError('load_skill', { name: 'missing-skill' }, /Skill not found/);
await expectToolError('load_skill', { name: 'outside-skill', source: 'workspace', include_global_skills: false }, /Skill not found/);
const inventory = await client.request('tools/call', { name: 'codexpro_inventory', arguments: { include_global_skills: false, include_mcp_servers: false } });
if (inventory.structuredContent.codexpro_tool !== 'codexpro_inventory') throw new Error('inventory result was not tagged for widget rendering');
const opened = await client.request('tools/call', { name: 'open_workspace', arguments: { root: tmp, include_tree: true } });
const ws = opened.structuredContent.workspace_id;
const openedByPath = await client.request('tools/call', { name: 'open_workspace', arguments: { path: tmp, include_tree: false } });
if (openedByPath.structuredContent.workspace_id !== ws) {
  throw new Error(`open_workspace path alias returned ${openedByPath.structuredContent.workspace_id}, expected ${ws}`);
}
await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'demo.txt' } });
await fs.writeFile(path.join(tmp, 'tokens.txt'), [
  'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456',
  'https://example.test/mcp?codexpro_token=verysecretcodexprotoken123&x=1',
  'codexpro_token=secretsecret12345',
  '"codexpro_token": "shortcodextoken"',
  'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz123456',
  '"api_key": "jsonsecretvalueabcdefghijklmnop"',
  'service_token: yamlsecretvalueabcdefghijklmnop'
].join('\n'), 'utf8');
const secretRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'config.txt' } });
const secretPayload = JSON.stringify(secretRead);
if (secretPayload.includes('sk-realSecretValue123') || !secretPayload.includes('[REDACTED_SECRET]')) {
  throw new Error('read did not redact secret-looking content');
}
const tokenRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'tokens.txt' } });
const tokenPayload = JSON.stringify(tokenRead);
for (const leaked of ['ghp_abcdefghijklmnopqrstuvwxyz123456', 'verysecretcodexprotoken123', 'secretsecret12345', 'shortcodextoken', 'sk-ant-abcdefghijklmnopqrstuvwxyz123456', 'jsonsecretvalueabcdefghijklmnop', 'yamlsecretvalueabcdefghijklmnop']) {
  if (tokenPayload.includes(leaked)) throw new Error(`read leaked token-like content: ${leaked}`);
}
await expectToolError('write', { workspace_id: ws, path: 'notes.md', content: 'OPENAI_API_KEY=sk-realSecretValue123\n' }, /Secret-looking content is blocked/);
await expectToolError('write', { workspace_id: ws, path: 'token.txt', content: 'codexpro_token=shorttok\n' }, /Secret-looking content is blocked/);
await expectToolError('write', { workspace_id: ws, path: 'notes.yaml', content: 'api_key: yamlsecretvalueabcdefghijklmnop\n' }, /Secret-looking content is blocked/);
await client.request('tools/call', {
  name: 'write',
  arguments: {
    workspace_id: ws,
    path: 'env-ref.js',
    content: 'const TOKEN = process.env.TOKEN;\nconst OPENAI_API_KEY = process.env.OPENAI_API_KEY;\nconst apiToken = getToken();\n'
  }
});
const envRefRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'env-ref.js' } });
const envRefPayload = JSON.stringify(envRefRead);
if (envRefPayload.includes('[REDACTED_SECRET]')) {
  throw new Error('env-var token references were incorrectly redacted as literal secrets');
}
const symlinkRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: symlinkEscapePath } });
if (!symlinkRead.isError) throw new Error('symlink escape read was not blocked');
for (const linkPath of danglingSymlinks) {
  await expectToolError('write', { workspace_id: ws, path: linkPath, content: 'escaped write\n' }, /symlink/i);
}
await client.request('tools/call', { name: 'edit', arguments: { workspace_id: ws, path: 'demo.txt', old_text: 'read\nread', new_text: 'read\nwrite' } });
const changes = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws } });
if (!changes.structuredContent.changed || !changes.structuredContent.diff.includes('demo.txt')) {
  throw new Error('show_changes did not report the edited demo.txt diff');
}
const statsOnlyDiff = await client.request('tools/call', { name: 'git_diff', arguments: { workspace_id: ws, include_diff: false } });
if (statsOnlyDiff.structuredContent.include_diff !== false || statsOnlyDiff.structuredContent.diff !== '') {
  throw new Error(`git_diff include_diff=false returned raw diff: ${JSON.stringify(statsOnlyDiff.structuredContent)}`);
}
if (!statsOnlyDiff.content?.[0]?.text?.includes('Raw diff omitted by include_diff=false')) {
  throw new Error('git_diff include_diff=false did not report omitted diff in text output');
}
const demoChanges = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws, path: 'demo.txt' } });
if (!demoChanges.structuredContent.changed || !demoChanges.structuredContent.changed_files?.some?.((line) => line.includes('demo.txt'))) {
  throw new Error(`path-scoped show_changes did not report demo.txt: ${JSON.stringify(demoChanges.structuredContent.changed_files)}`);
}
if (demoChanges.structuredContent.changed_files?.some?.((line) => line.includes('env-ref.js'))) {
  throw new Error(`path-scoped show_changes leaked unrelated env-ref.js status: ${JSON.stringify(demoChanges.structuredContent.changed_files)}`);
}
const cleanPathChanges = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: ws, path: 'package.json' } });
if (cleanPathChanges.structuredContent.changed || cleanPathChanges.structuredContent.changed_files?.length || cleanPathChanges.structuredContent.diff.includes('demo.txt')) {
  throw new Error(`path-scoped show_changes leaked unrelated changes: ${JSON.stringify(cleanPathChanges.structuredContent)}`);
}
const codexContext = await client.request('tools/call', { name: 'codex_context', arguments: { workspace_id: ws, target_path: 'demo.txt' } });
if (!codexContext.structuredContent.agents_files.includes('AGENTS.md')) throw new Error('codex_context did not include AGENTS.md');
if (codexContext.structuredContent.agents_files.length !== 1) throw new Error(`codex_context returned duplicate AGENTS files: ${codexContext.structuredContent.agents_files.join(', ')}`);
if (!codexContext.content?.[0]?.text?.includes('Smoke Agents')) throw new Error('codex_context did not include AGENTS.md content');
const pwdBash = await client.request('tools/call', { name: 'bash', arguments: { workspace_id: ws, command: 'pwd' } });
const pwdBashText = pwdBash.content?.[0]?.text ?? '';
if (!pwdBashText.includes('Exit: 0') || pwdBashText.includes('## stdout') || pwdBashText.includes('## stderr')) {
  throw new Error(`default bash transcript should be compact: ${pwdBashText}`);
}
if (!pwdBash.structuredContent.stdout?.includes(tmp)) {
  throw new Error(`compact bash transcript dropped structured stdout: ${JSON.stringify(pwdBash.structuredContent)}`);
}
await expectToolError('bash', { workspace_id: ws, command: 'find /tmp' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'find . -fprint leaked.txt' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'git show HEAD:.env' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'ls $HOME' }, /blocked/i);
const clientBuild = await client.request('tools/call', { name: 'bash', arguments: { workspace_id: ws, command: 'npm run build:clients', timeout_ms: 60000 } });
if (!clientBuild.structuredContent.stdout?.includes('clients ok')) {
  throw new Error('safe bash did not run npm run build:clients');
}
const exported = await client.request('tools/call', { name: 'export_pro_context', arguments: { workspace_id: ws, selected_paths: ['demo.txt'], max_files: 4, max_total_bytes: 80000 } });
if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') throw new Error('export_pro_context wrote an unexpected path');
if (!exported.structuredContent.files_included?.includes('demo.txt')) {
  throw new Error(`export_pro_context dropped an explicit selected path: ${JSON.stringify(exported.structuredContent.files_included)}`);
}
await fs.stat(path.join(tmp, '.ai-bridge', 'pro-context.md'));
const oneFileExport = await client.request('tools/call', {
  name: 'export_pro_context',
  arguments: {
    workspace_id: ws,
    selected_paths: ['demo.txt'],
    max_files: 1,
    max_total_bytes: 80000
  }
});
if (JSON.stringify(oneFileExport.structuredContent.files_included) !== JSON.stringify(['demo.txt'])) {
  throw new Error(`export_pro_context did not prioritize selected path with max_files=1: ${JSON.stringify(oneFileExport.structuredContent.files_included)}`);
}
const exactExport = await client.request('tools/call', {
  name: 'export_pro_context',
  arguments: {
    workspace_id: ws,
    selected_paths: ['demo.txt'],
    include_important_files: false,
    include_changed_files: false,
    include_diff: false,
    include_ai_bridge: false,
    max_files: 4,
    max_total_bytes: 80000
  }
});
if (!exactExport.structuredContent.files_included?.includes('demo.txt')) {
  throw new Error(`selected-only export did not include demo.txt: ${JSON.stringify(exactExport.structuredContent.files_included)}`);
}
if (exactExport.structuredContent.files_included?.some?.((file) => file !== 'demo.txt')) {
  throw new Error(`selected-only export included unexpected files: ${JSON.stringify(exactExport.structuredContent.files_included)}`);
}
const exactProContext = await fs.readFile(path.join(tmp, '.ai-bridge', 'pro-context.md'), 'utf8');
if (!exactProContext.includes('Auto-include important root files: no') || !exactProContext.includes('Auto-include changed files: no')) {
  throw new Error('selected-only export did not record disabled auto-inclusion settings');
}
if (exactProContext.includes('### AGENTS.md') || exactProContext.includes('### package.json') || exactProContext.includes('### env-ref.js')) {
  throw new Error('selected-only export leaked auto-included important or changed files');
}
const agentHandoff = await client.request('tools/call', {
  name: 'handoff_to_agent',
  arguments: {
    workspace_id: ws,
    agent: 'opencode',
    model: 'provider/cheap-model',
    title: 'Smoke agent plan',
    plan: '- Verify demo.txt contains write.'
  }
});
if (agentHandoff.structuredContent.agent !== 'opencode') throw new Error('handoff_to_agent did not preserve target agent');
const escapedHandoff = await client.request('tools/call', {
  name: 'handoff_to_agent',
  arguments: {
    workspace_id: ws,
    agent: 'opencode',
    model: 'foo; touch /tmp/pwned',
    title: 'Escaped model plan',
    plan: '- Verify shell hints quote model names.'
  }
});
const escapedPrompt = escapedHandoff.content?.find?.((part) => part.type === 'text')?.text ?? '';
if (!escapedPrompt.includes("--model 'foo; touch /tmp/pwned'")) {
  throw new Error(`handoff_to_agent did not shell-quote the model hint: ${escapedPrompt}`);
}
if (escapedPrompt.includes('--model foo; touch')) {
  throw new Error(`handoff_to_agent exposed an unquoted model hint: ${escapedPrompt}`);
}
for (const bridgeFile of ['agent-status.md', 'implementation-diff.patch', 'execution-log.jsonl']) {
  await fs.stat(path.join(tmp, '.ai-bridge', bridgeFile));
}
const handoffContext = await client.request('tools/call', { name: 'read_handoff', arguments: { workspace_id: ws } });
for (const expectedFile of ['.ai-bridge/agent-status.md', '.ai-bridge/implementation-diff.patch', '.ai-bridge/execution-log.jsonl']) {
  if (!handoffContext.structuredContent.files.includes(expectedFile)) {
    throw new Error(`read_handoff did not include ${expectedFile}`);
  }
}
const runStatePayload = {
  version: 1,
  state: 'completed',
  iteration: 1,
  plan_hash: 'smoke-plan-hash',
  executor: 'opencode',
  model: 'provider/cheap-model',
  exit_code: 0,
  timed_out: false,
  started_at: new Date(Date.now() - 1000).toISOString(),
  finished_at: new Date().toISOString(),
  status_file: '.ai-bridge/agent-status.md',
  diff_file: '.ai-bridge/implementation-diff.patch',
  log_file: '.ai-bridge/execution-log.jsonl'
};
await fs.writeFile(path.join(tmp, '.ai-bridge', 'handoff-run-state.json'), `${JSON.stringify(runStatePayload, null, 2)}\n`, 'utf8');
const waitCompleted = await client.request('tools/call', {
  name: 'wait_for_handoff',
  arguments: { workspace_id: ws, max_wait_seconds: 1, poll_ms: 250, plan_hash: 'smoke-plan-hash' }
});
if (waitCompleted.structuredContent.awaited_completed !== true || waitCompleted.structuredContent.state !== 'completed') {
  throw new Error(`wait_for_handoff did not report completion: ${JSON.stringify(waitCompleted.structuredContent)}`);
}
if (waitCompleted.structuredContent.awaited_terminal !== true || waitCompleted.structuredContent.succeeded !== true) {
  throw new Error(`wait_for_handoff did not report terminal success fields: ${JSON.stringify(waitCompleted.structuredContent)}`);
}
if (waitCompleted.structuredContent.exit_code !== 0 || waitCompleted.structuredContent.status_file !== '.ai-bridge/agent-status.md') {
  throw new Error(`wait_for_handoff missing completion fields: ${JSON.stringify(waitCompleted.structuredContent)}`);
}
const waitMismatch = await client.request('tools/call', {
  name: 'wait_for_handoff',
  arguments: { workspace_id: ws, max_wait_seconds: 1, poll_ms: 250, plan_hash: 'a-different-hash' }
});
if (waitMismatch.structuredContent.awaited_completed !== false || waitMismatch.structuredContent.state !== 'running' || waitMismatch.structuredContent.plan_hash_mismatch !== true) {
  throw new Error(`wait_for_handoff did not keep waiting on plan-hash mismatch: ${JSON.stringify(waitMismatch.structuredContent)}`);
}
await fs.writeFile(path.join(tmp, '.ai-bridge', 'handoff-run-state.json'), `${JSON.stringify({
  ...runStatePayload,
  state: 'failed',
  plan_hash: 'failed-plan',
  exit_code: 2,
  status_file: 'demo.txt',
  diff_file: '../demo.txt',
  log_file: '.ai-bridge/execution-log.jsonl'
}, null, 2)}\n`, 'utf8');
const waitFailed = await client.request('tools/call', {
  name: 'wait_for_handoff',
  arguments: { workspace_id: ws, max_wait_seconds: 1, poll_ms: 250, plan_hash: 'failed-plan' }
});
if (waitFailed.structuredContent.awaited_terminal !== true || waitFailed.structuredContent.awaited_completed !== false || waitFailed.structuredContent.succeeded !== false || waitFailed.structuredContent.state !== 'failed') {
  throw new Error(`wait_for_handoff did not report failed terminal state: ${JSON.stringify(waitFailed.structuredContent)}`);
}
if (waitFailed.structuredContent.status_file !== '.ai-bridge/agent-status.md' || waitFailed.structuredContent.diff_file !== '.ai-bridge/implementation-diff.patch') {
  throw new Error(`wait_for_handoff trusted forged artifact paths: ${JSON.stringify(waitFailed.structuredContent)}`);
}
await fs.writeFile(path.join(tmp, '.ai-bridge', 'handoff-run-state.json'), `${JSON.stringify({
  ...runStatePayload,
  state: 'timed_out',
  plan_hash: 'timed-out-plan',
  exit_code: null,
  timed_out: true
}, null, 2)}\n`, 'utf8');
const waitTimedOut = await client.request('tools/call', {
  name: 'wait_for_handoff',
  arguments: { workspace_id: ws, max_wait_seconds: 1, poll_ms: 250, plan_hash: 'timed-out-plan' }
});
if (waitTimedOut.structuredContent.awaited_terminal !== true || waitTimedOut.structuredContent.awaited_completed !== false || waitTimedOut.structuredContent.succeeded !== false || waitTimedOut.structuredContent.state !== 'timed_out') {
  throw new Error(`wait_for_handoff did not report timed-out terminal state: ${JSON.stringify(waitTimedOut.structuredContent)}`);
}
await fs.rm(path.join(tmp, '.ai-bridge', 'handoff-run-state.json'), { force: true });
await client.request('tools/call', { name: 'handoff_to_codex', arguments: { workspace_id: ws, title: 'Smoke Codex plan', plan: '- Verify demo.txt contains write.', append: true } });
await fs.writeFile(path.join(tmp, '.ai-bridge', 'current-plan.md'), 'x'.repeat(190000), 'utf8');
await expectToolError('handoff_to_agent', {
  workspace_id: ws,
  agent: 'opencode',
  title: 'Oversized append plan',
  plan: '- This append should fail before loading the existing plan.',
  append: true
}, /File is too large/);
client.close();
async function assertToolMode(mode, expected, hidden) {
  const args = ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe'];
  if (mode) args.push('--tool-mode', mode);
  const modeClient = new McpStdioClient('node', args, {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_MODE: '' }
  });
  await modeClient.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: `codexpro-${mode || 'default'}-smoke`, version: '0.1.0' }
  });
  modeClient.notify('notifications/initialized');
  const modeTools = await modeClient.request('tools/list', {});
  const names = modeTools.tools.map((tool) => tool.name);
  for (const expectedName of expected) {
    if (!names.includes(expectedName)) throw new Error(`${mode || 'default'} mode missing ${expectedName}; got ${names.join(', ')}`);
  }
  for (const hiddenName of hidden) {
    if (names.includes(hiddenName)) throw new Error(`${mode || 'default'} mode should hide ${hiddenName}; got ${names.join(', ')}`);
  }
  modeClient.close();
}

await assertToolMode('', ['server_config', 'codexpro_self_test', 'open_current_workspace', 'open_workspace', 'tree', 'search', 'load_skill', 'read', 'write', 'edit', 'bash', 'show_changes', 'read_handoff', 'wait_for_handoff', 'export_pro_context', 'handoff_to_agent'], ['codexpro_inventory', 'workspace_snapshot', 'git_status', 'git_diff', 'codex_context', 'handoff_to_codex']);
await assertToolMode('minimal', ['server_config', 'codexpro_self_test', 'open_current_workspace', 'open_workspace', 'read', 'write', 'edit', 'bash', 'show_changes'], ['tree', 'search', 'load_skill', 'read_handoff', 'wait_for_handoff', 'export_pro_context', 'handoff_to_agent', 'codex_context']);

const handoffWriteClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--write', 'handoff'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_MODE: '' }
});
await handoffWriteClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-write-handoff-smoke', version: '0.1.0' }
});
handoffWriteClient.notify('notifications/initialized');
const handoffWriteTools = await handoffWriteClient.request('tools/list', {});
const handoffWriteToolNames = handoffWriteTools.tools.map((tool) => tool.name);
for (const hiddenWriteTool of ['write', 'edit']) {
  if (handoffWriteToolNames.includes(hiddenWriteTool)) {
    throw new Error(`--write handoff should not advertise ${hiddenWriteTool} tool; got ${handoffWriteToolNames.join(', ')}`);
  }
}
const handoffWriteConfig = await handoffWriteClient.request('tools/call', { name: 'server_config', arguments: {} });
if (handoffWriteConfig.structuredContent.writeMode !== 'handoff' || handoffWriteConfig.structuredContent.registeredTools?.includes?.('write') || handoffWriteConfig.structuredContent.registeredTools?.includes?.('edit')) {
  throw new Error(`server_config did not report write handoff with hidden edit tools: ${JSON.stringify(handoffWriteConfig.structuredContent)}`);
}
handoffWriteClient.close();

const noBashClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_MODE: '' }
});
await noBashClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-no-bash-smoke', version: '0.1.0' }
});
noBashClient.notify('notifications/initialized');
const noBashTools = await noBashClient.request('tools/list', {});
const noBashToolNames = noBashTools.tools.map((tool) => tool.name);
if (noBashToolNames.includes('bash')) {
  throw new Error(`--bash off should not advertise bash tool; got ${noBashToolNames.join(', ')}`);
}
const noBashConfig = await noBashClient.request('tools/call', { name: 'server_config', arguments: {} });
if (noBashConfig.structuredContent.bashMode !== 'off') {
  throw new Error(`server_config did not report bash off: ${JSON.stringify(noBashConfig.structuredContent)}`);
}
noBashClient.close();

const disabledWriteClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--write', 'off'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_MODE: '' }
});
await disabledWriteClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-write-off-smoke', version: '0.1.0' }
});
disabledWriteClient.notify('notifications/initialized');
const disabledWriteTools = await disabledWriteClient.request('tools/list', {});
const disabledWriteToolNames = disabledWriteTools.tools.map((tool) => tool.name);
for (const hiddenWriteTool of ['write', 'edit']) {
  if (disabledWriteToolNames.includes(hiddenWriteTool)) {
    throw new Error(`--write off should not advertise ${hiddenWriteTool} tool; got ${disabledWriteToolNames.join(', ')}`);
  }
}
const disabledWriteConfig = await disabledWriteClient.request('tools/call', { name: 'server_config', arguments: {} });
if (disabledWriteConfig.structuredContent.writeMode !== 'off') {
  throw new Error(`server_config did not report write off: ${JSON.stringify(disabledWriteConfig.structuredContent)}`);
}
disabledWriteClient.close();

const standardCodexSessionsClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: tmp,
    CODEXPRO_CODEX_SESSIONS: 'metadata',
    CODEXPRO_CODEX_DIR: codexHistoryDir
  }
});
await standardCodexSessionsClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-standard-codex-sessions-smoke', version: '0.1.0' }
});
standardCodexSessionsClient.notify('notifications/initialized');
const standardCodexSessionTools = await standardCodexSessionsClient.request('tools/list', {});
const standardCodexSessionToolNames = standardCodexSessionTools.tools.map((tool) => tool.name);
if (!standardCodexSessionToolNames.includes('codex_sessions')) {
  throw new Error(`standard mode with Codex sessions enabled missed codex_sessions: ${standardCodexSessionToolNames.join(', ')}`);
}
if (standardCodexSessionToolNames.includes('read_codex_session')) {
  throw new Error(`metadata mode should not expose read_codex_session: ${standardCodexSessionToolNames.join(', ')}`);
}
standardCodexSessionsClient.close();

const fullTranscriptClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_BASH_TRANSCRIPT: 'full' }
});
await fullTranscriptClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-full-bash-transcript-smoke', version: '0.1.0' }
});
fullTranscriptClient.notify('notifications/initialized');
const fullTranscriptBash = await fullTranscriptClient.request('tools/call', { name: 'bash', arguments: { command: 'pwd' } });
const fullTranscriptText = fullTranscriptBash.content?.[0]?.text ?? '';
if (!fullTranscriptText.includes('## stdout') || !fullTranscriptText.includes(tmp)) {
  throw new Error(`full bash transcript mode did not preserve raw stdout in chat text: ${fullTranscriptText}`);
}
fullTranscriptClient.close();

const emptyCodexDirClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: tmp,
    CODEXPRO_CODEX_DIR: ''
  }
});
await emptyCodexDirClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-empty-codex-dir-smoke', version: '0.1.0' }
});
emptyCodexDirClient.notify('notifications/initialized');
const emptyCodexDirConfig = await emptyCodexDirClient.request('tools/call', { name: 'server_config', arguments: {} });
const expectedDefaultCodexDir = path.join(os.homedir(), '.codex');
if (emptyCodexDirConfig.structuredContent.codexDir !== expectedDefaultCodexDir) {
  throw new Error(`empty CODEXPRO_CODEX_DIR resolved to ${emptyCodexDirConfig.structuredContent.codexDir}, expected ${expectedDefaultCodexDir}`);
}
emptyCodexDirClient.close();

const invalidContextDir = spawnSync('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_CONTEXT_DIR: 'src' },
  encoding: 'utf8',
  timeout: 5000
});
if (invalidContextDir.status === 0 || !String(invalidContextDir.stderr || invalidContextDir.stdout).includes('CODEXPRO_CONTEXT_DIR')) {
  throw new Error(`invalid CODEXPRO_CONTEXT_DIR=src was not rejected: status=${invalidContextDir.status} stdout=${invalidContextDir.stdout} stderr=${invalidContextDir.stderr}`);
}

const codexSessionsClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: tmp,
    CODEXPRO_CODEX_SESSIONS: 'read',
    CODEXPRO_CODEX_DIR: codexHistoryDir
  }
});
await codexSessionsClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-codex-sessions-smoke', version: '0.1.0' }
});
codexSessionsClient.notify('notifications/initialized');
const codexSessionTools = await codexSessionsClient.request('tools/list', {});
const codexSessionToolNames = codexSessionTools.tools.map((tool) => tool.name);
for (const expectedName of ['codex_sessions', 'read_codex_session']) {
  if (!codexSessionToolNames.includes(expectedName)) {
    throw new Error(`codex session opt-in mode missing ${expectedName}: ${codexSessionToolNames.join(', ')}`);
  }
}
const codexSessions = await codexSessionsClient.request('tools/call', { name: 'codex_sessions', arguments: { max_sessions: 5 } });
const session = codexSessions.structuredContent.sessions?.[0];
if (!session || session.session_id !== '019cc369-bd7c-7891-b371-7b20b4fe0b18' || session.title !== 'Fix the smoke session browser' || session.project_dir !== tmp) {
  throw new Error(`codex_sessions did not return parsed Codex metadata: ${JSON.stringify(codexSessions.structuredContent)}`);
}
if (session.resume_command !== 'codex resume 019cc369-bd7c-7891-b371-7b20b4fe0b18') {
  throw new Error(`codex_sessions returned wrong resume command: ${JSON.stringify(session)}`);
}
const codexTranscript = await codexSessionsClient.request('tools/call', {
  name: 'read_codex_session',
  arguments: { session_id: '019cc369-bd7c-7891-b371-7b20b4fe0b18', max_messages: 10 }
});
if (!codexTranscript.content?.[0]?.text?.includes('Fix the smoke session browser') || !codexTranscript.content?.[0]?.text?.includes('[Tool: bash]')) {
  throw new Error(`read_codex_session did not return bounded transcript text: ${codexTranscript.content?.[0]?.text}`);
}
const topOneSessions = await codexSessionsClient.request('tools/call', { name: 'codex_sessions', arguments: { max_sessions: 1 } });
if (topOneSessions.structuredContent.sessions?.some?.((item) => item.session_id === olderCodexSessionId)) {
  throw new Error(`codex_sessions max_sessions did not limit visible results: ${JSON.stringify(topOneSessions.structuredContent)}`);
}
const olderCodexTranscript = await codexSessionsClient.request('tools/call', {
  name: 'read_codex_session',
  arguments: { session_id: olderCodexSessionId, max_messages: 10 }
});
if (!olderCodexTranscript.content?.[0]?.text?.includes('Older session still readable by id')) {
  throw new Error(`read_codex_session only searched visible list window: ${olderCodexTranscript.content?.[0]?.text}`);
}
const largeTailSessions = await codexSessionsClient.request('tools/call', { name: 'codex_sessions', arguments: { query: 'Large tail summary', max_sessions: 5 } });
const largeTailSession = largeTailSessions.structuredContent.sessions?.find?.((item) => item.session_id === largeCodexSessionId);
if (!largeTailSession || largeTailSession.summary !== 'Large tail summary') {
  throw new Error(`codex_sessions did not parse summary from bounded tail window: ${JSON.stringify(largeTailSessions.structuredContent)}`);
}
codexSessionsClient.close();

const sessionGuardClient = new McpStdioClient('node', [
  'dist/stdio.js',
  '--root',
  tmp,
  '--allow-root',
  tmp,
  '--bash',
  'safe',
  '--bash-session',
  'codex-main',
  '--require-bash-session'
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: tmp,
    CODEXPRO_BASH_SESSION_ID: '',
    CODEXPRO_REQUIRE_BASH_SESSION: ''
  }
});
await sessionGuardClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-bash-session-smoke', version: '0.1.0' }
});
sessionGuardClient.notify('notifications/initialized');
const guardedConfig = await sessionGuardClient.request('tools/call', { name: 'server_config', arguments: {} });
if (guardedConfig.structuredContent.bashSessionId !== 'codex-main' || guardedConfig.structuredContent.requireBashSession !== true) {
  throw new Error(`server_config did not expose bash session guard: ${JSON.stringify(guardedConfig.structuredContent)}`);
}
await expectToolError('bash', { command: 'pwd' }, /bash session/i, sessionGuardClient);
await expectToolError('bash', { command: 'pwd', session_id: 'other-session' }, /codex-main/i, sessionGuardClient);
const guardedBash = await sessionGuardClient.request('tools/call', { name: 'bash', arguments: { command: 'pwd', session_id: 'codex-main' } });
if (guardedBash.structuredContent.bash_session_id !== 'codex-main' || !guardedBash.content?.[0]?.text?.includes('Exit: 0')) {
  throw new Error(`bash session guard did not allow matching session id: ${JSON.stringify(guardedBash.structuredContent)}`);
}
const guardedSelfTest = await sessionGuardClient.request('tools/call', {
  name: 'codexpro_self_test',
  arguments: { write_probe: false, pro_context_probe: false }
});
if (guardedSelfTest.structuredContent.status === 'fail') {
  throw new Error(`codexpro_self_test failed under bash session guard: ${JSON.stringify(guardedSelfTest.structuredContent.checks)}`);
}
sessionGuardClient.close();

const nonGitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-non-git-'));
await fs.writeFile(path.join(nonGitRoot, 'README.md'), '# Non-git fixture\n', 'utf8');
const nonGitClient = new McpStdioClient('node', ['dist/stdio.js', '--root', nonGitRoot, '--allow-root', nonGitRoot, '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: nonGitRoot, CODEXPRO_ALLOWED_ROOTS: nonGitRoot }
});
await nonGitClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-non-git-smoke', version: '0.1.0' }
});
nonGitClient.notify('notifications/initialized');
const nonGitDiff = await nonGitClient.request('tools/call', { name: 'git_diff', arguments: { include_diff: false } });
const nonGitPayload = JSON.stringify(nonGitDiff);
if (!nonGitDiff.structuredContent.diff_error || !nonGitDiff.structuredContent.diff || nonGitDiff.structuredContent.changed) {
  throw new Error(`git_diff include_diff=false hid non-git diagnostics: ${nonGitPayload}`);
}
if (!/not a git repository|git unavailable|fatal:/i.test(nonGitPayload)) {
  throw new Error(`git_diff include_diff=false did not preserve the git diagnostic text: ${nonGitPayload}`);
}
nonGitClient.close();

const lowerAgentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-lower-agents-'));
await fs.writeFile(path.join(lowerAgentsRoot, 'agents.md'), '# Lowercase agents\n\n- Lowercase instruction file loaded.\n', 'utf8');
await fs.mkdir(path.join(lowerAgentsRoot, 'src'));
await fs.writeFile(path.join(lowerAgentsRoot, 'src', 'demo.ts'), 'export const demo = true;\n', 'utf8');
const lowerClient = new McpStdioClient('node', ['dist/stdio.js', '--root', lowerAgentsRoot, '--allow-root', lowerAgentsRoot, '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: lowerAgentsRoot, CODEXPRO_ALLOWED_ROOTS: lowerAgentsRoot }
});
await lowerClient.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-lower-agents-smoke', version: '0.1.0' }
});
lowerClient.notify('notifications/initialized');
const lowerOpened = await lowerClient.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
if (lowerOpened.structuredContent.agents_path !== 'agents.md') {
  throw new Error(`lowercase agents.md was reported as ${lowerOpened.structuredContent.agents_path}`);
}
const lowerContext = await lowerClient.request('tools/call', { name: 'codex_context', arguments: { target_path: 'src/demo.ts', include_ai_bridge: false, include_git: false } });
if (!lowerContext.structuredContent.agents_files.includes('agents.md')) {
  throw new Error(`codex_context did not preserve lowercase agents.md: ${lowerContext.structuredContent.agents_files.join(', ')}`);
}
if (!lowerContext.content?.[0]?.text?.includes('Lowercase instruction file loaded.')) {
  throw new Error('codex_context did not include lowercase agents.md content');
}
lowerClient.close();
console.log('✓ smoke test passed');
