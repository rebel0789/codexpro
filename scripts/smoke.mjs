import { spawn } from 'node:child_process';
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-smoke-'));
await fs.writeFile(path.join(tmp, 'demo.txt'), 'alpha\nread\nread\nomega\n', 'utf8');
await fs.writeFile(path.join(tmp, 'config.txt'), 'OPENAI_API_KEY=sk-realSecretValue123\n', 'utf8');
await fs.writeFile(path.join(tmp, 'AGENTS.md'), '# Smoke Agents\n\n- Preserve demo.txt.\n', 'utf8');
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-outside-'));
await fs.writeFile(path.join(outside, 'secret.txt'), 'do-not-read', 'utf8');
let symlinkEscapePath = 'secret-link.txt';
try {
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(tmp, symlinkEscapePath));
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  symlinkEscapePath = 'secret-link-dir/secret.txt';
  await fs.symlink(outside, path.join(tmp, 'secret-link-dir'), 'junction');
}

const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp }
});

await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-smoke', version: '0.1.0' }
});
client.notify('notifications/initialized');
const tools = await client.request('tools/list', {});
const toolNames = tools.tools.map((tool) => tool.name);
for (const expected of ['server_config', 'codexpro_inventory', 'list_workspaces', 'open_current_workspace', 'open_workspace', 'tree', 'search', 'read', 'write', 'edit', 'bash', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
  if (!toolNames.includes(expected)) throw new Error(`missing tool: ${expected}`);
}
const toolCardUri = 'ui://widget/codexpro-tool-card-v5.html';
const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
function hasWidgetMeta(name) {
  const meta = toolsByName.get(name)?._meta ?? {};
  return meta.ui?.resourceUri === toolCardUri || meta['openai/outputTemplate'] === toolCardUri;
}
async function expectToolError(name, args, pattern) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (!result.isError) {
    throw new Error(`${name} unexpectedly succeeded`);
  }
  const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
  if (pattern && !pattern.test(text)) {
    throw new Error(`${name} error did not match ${pattern}: ${text}`);
  }
}
for (const visualTool of ['write', 'edit', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
  if (!hasWidgetMeta(visualTool)) throw new Error(`${visualTool} should render the CodexPro widget`);
}
for (const quietTool of ['server_config', 'codexpro_inventory', 'list_workspaces', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'tree', 'search', 'read', 'bash', 'git_status', 'git_diff', 'read_handoff', 'codex_context']) {
  if (hasWidgetMeta(quietTool)) throw new Error(`${quietTool} should stay data-only without widget metadata`);
}
const resources = await client.request('resources/list', {});
const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
if (!toolCard) throw new Error(`missing tool-card resource: ${toolCardUri}`);
if (toolCard.mimeType !== 'text/html;profile=mcp-app') throw new Error(`unexpected tool-card mime type: ${toolCard.mimeType}`);
const widget = await client.request('resources/read', { uri: toolCardUri });
const widgetText = widget.contents?.[0]?.text ?? '';
const widgetMeta = widget.contents?.[0]?._meta ?? {};
if (!widgetText.includes('Working in the workspace') || !widgetText.includes('ui/notifications/tool-result')) {
  throw new Error('tool-card widget resource did not include expected Apps bridge code');
}
if (!widgetMeta.ui?.csp || !widgetMeta['openai/widgetCSP']) {
  throw new Error('tool-card widget resource did not expose standard and ChatGPT CSP metadata');
}
const current = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
const realTmp = await fs.realpath(tmp);
if (current.structuredContent.root !== realTmp) throw new Error(`open_current_workspace opened ${current.structuredContent.root}, expected ${realTmp}`);
if (current.structuredContent.codexpro_tool !== 'open_current_workspace') throw new Error('tool result was not tagged for widget rendering');
const inventory = await client.request('tools/call', { name: 'codexpro_inventory', arguments: { include_global_skills: false, include_mcp_servers: false } });
if (inventory.structuredContent.codexpro_tool !== 'codexpro_inventory') throw new Error('inventory result was not tagged for widget rendering');
const opened = await client.request('tools/call', { name: 'open_workspace', arguments: { root: tmp, include_tree: true } });
const ws = opened.structuredContent.workspace_id;
await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'demo.txt' } });
const secretRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: 'config.txt' } });
const secretPayload = JSON.stringify(secretRead);
if (secretPayload.includes('sk-realSecretValue123') || !secretPayload.includes('[REDACTED_SECRET]')) {
  throw new Error('read did not redact secret-looking content');
}
await expectToolError('write', { workspace_id: ws, path: 'notes.md', content: 'OPENAI_API_KEY=sk-realSecretValue123\n' }, /Secret-looking content is blocked/);
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
await client.request('tools/call', { name: 'edit', arguments: { workspace_id: ws, path: 'demo.txt', old_text: 'read\nread', new_text: 'read\nwrite' } });
const codexContext = await client.request('tools/call', { name: 'codex_context', arguments: { workspace_id: ws, target_path: 'demo.txt' } });
if (!codexContext.structuredContent.agents_files.includes('AGENTS.md')) throw new Error('codex_context did not include AGENTS.md');
if (codexContext.structuredContent.agents_files.length !== 1) throw new Error(`codex_context returned duplicate AGENTS files: ${codexContext.structuredContent.agents_files.join(', ')}`);
if (!codexContext.content?.[0]?.text?.includes('Smoke Agents')) throw new Error('codex_context did not include AGENTS.md content');
await client.request('tools/call', { name: 'bash', arguments: { workspace_id: ws, command: 'pwd' } });
await expectToolError('bash', { workspace_id: ws, command: 'find /tmp' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'find . -fprint leaked.txt' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'git show HEAD:.env' }, /blocked/i);
await expectToolError('bash', { workspace_id: ws, command: 'ls $HOME' }, /blocked/i);
const exported = await client.request('tools/call', { name: 'export_pro_context', arguments: { workspace_id: ws, selected_paths: ['demo.txt'], max_files: 4, max_total_bytes: 80000 } });
if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') throw new Error('export_pro_context wrote an unexpected path');
await fs.stat(path.join(tmp, '.ai-bridge', 'pro-context.md'));
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
console.log('✓ smoke test passed');
