import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout waiting for process exit\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

async function expectHttpTokenRequired(name, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `codexpro-http-no-token-${name}-`));
  const port = await getFreePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    ...overrides
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;

  const child = spawn('node', ['dist/http.js'], {
    cwd: path.resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = await waitForExit(child);
  if (result.code === 0) {
    throw new Error(`expected ${name} HTTP server without token to fail closed`);
  }
  if (!result.stderr.includes('CODEXPRO_HTTP_TOKEN is required')) {
    throw new Error(`expected ${name} missing-token failure, got:\n${result.stderr}`);
  }
}

async function listTools(url, token) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close();
  }
}

function toolNames(tools) {
  return tools.map((tool) => tool.name);
}

function hasWidgetMeta(tools, name, uri) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return meta.ui?.resourceUri === uri || meta['openai/outputTemplate'] === uri;
}

await expectHttpTokenRequired('non-loopback', { CODEXPRO_HOST: '0.0.0.0' });
await expectHttpTokenRequired('tunnel-mode', { CODEXPRO_TUNNEL_MODE: '1' });

async function withClient(url, fn) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
    throw new Error(`${name} failed: ${text}`);
  }
  return result;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-smoke-'));
await fs.mkdir(path.join(root, '.codex', 'skills', 'http-smoke-skill'), { recursive: true });
await fs.writeFile(path.join(root, '.codex', 'skills', 'http-smoke-skill', 'SKILL.md'), [
  '---',
  'name: http-smoke-skill',
  'description: HTTP smoke test skill discovery.',
  '---',
  '',
  '# HTTP Smoke Skill',
  ''
].join('\n'), 'utf8');
const port = await getFreePort();
const token = 'codexpro-http-smoke-token';
const child = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_WIDGET_DOMAIN: 'https://widgets.codexpro.test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

try {
  await waitForListening(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${baseUrl}/healthz`);
  if (unauthorized.status !== 401) {
    throw new Error(`expected unauthenticated healthz to return 401, got ${unauthorized.status}`);
  }

  const authorized = await fetch(`${baseUrl}/healthz`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (authorized.status !== 200) {
    throw new Error(`expected authenticated healthz to return 200, got ${authorized.status}`);
  }

  const queryAuthorized = await fetch(`${baseUrl}/healthz?codexpro_token=${encodeURIComponent(token)}`);
  if (queryAuthorized.status !== 200) {
    throw new Error(`expected URL-token healthz to return 200, got ${queryAuthorized.status}`);
  }

  const home = await fetch(`${baseUrl}/?codexpro_token=${encodeURIComponent(token)}`);
  const homeText = await home.text();
  if (home.status !== 200 || !home.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`expected authenticated onboarding page to return HTML 200, got ${home.status}`);
  }
  if (!homeText.includes('CodexPro local bridge') || !homeText.includes('ChatGPT setup')) {
    throw new Error('onboarding page did not include expected setup copy');
  }

  const queryTools = await listTools(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`);
  const queryToolNames = toolNames(queryTools);
  for (const expected of ['server_config', 'codexpro_self_test', 'codexpro_inventory', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'load_skill', 'show_changes', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
    if (!queryToolNames.includes(expected)) {
      throw new Error(`URL-token MCP tools/list missing ${expected}; got ${queryToolNames.join(', ')}`);
    }
  }
  const toolCardUri = 'ui://widget/codexpro-tool-card-v9.html';
  for (const visualTool of queryToolNames) {
    if (!hasWidgetMeta(queryTools, visualTool, toolCardUri)) {
      throw new Error(`${visualTool} should render the CodexPro widget`);
    }
  }

  const headerTools = await listTools(`${baseUrl}/mcp`, token);
  const headerToolNames = toolNames(headerTools);
  if (!headerToolNames.includes('server_config')) {
    throw new Error(`bearer MCP tools/list missing server_config; got ${headerToolNames.join(', ')}`);
  }

  const mcpUrl = `${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`;
  await withClient(mcpUrl, async (client) => {
    const resources = await client.listResources();
    const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
    if (!toolCard) throw new Error(`HTTP MCP resources/list missing ${toolCardUri}`);
    if (toolCard.mimeType !== 'text/html;profile=mcp-app') {
      throw new Error(`unexpected HTTP tool-card mime type: ${toolCard.mimeType}`);
    }
    const widget = await client.readResource({ uri: toolCardUri });
    const widgetText = widget.contents?.[0]?.text ?? '';
    const widgetMeta = widget.contents?.[0]?._meta ?? {};
    if (!widgetText.includes('Waiting for tool result') || !widgetText.includes('renderWorkspace') || !widgetText.includes('renderSelfTest') || !widgetText.includes('details class="fold"') || !widgetText.includes('ui/notifications/tool-result')) {
      throw new Error('HTTP tool-card widget resource did not include expected Apps bridge code');
    }
    if (!widgetMeta.ui?.csp || !widgetMeta['openai/widgetCSP']) {
      throw new Error('HTTP tool-card widget resource did not expose standard and ChatGPT CSP metadata');
    }
    if (widgetMeta.ui?.domain !== 'https://widgets.codexpro.test' || widgetMeta['openai/widgetDomain'] !== 'https://widgets.codexpro.test') {
      throw new Error('HTTP tool-card widget resource did not expose standard and ChatGPT widget domain metadata');
    }
  });

  const currentOpened = await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_current_workspace', { include_tree: false });
    if (result.structuredContent.codexpro_tool !== 'open_current_workspace') {
      throw new Error('HTTP tool result was not tagged for widget rendering');
    }
    if (result.structuredContent.tool_mode !== 'full') {
      throw new Error(`open_current_workspace did not expose tool_mode: ${result.structuredContent.tool_mode}`);
    }
    if (!result.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_current_workspace did not discover workspace skill inventory');
    }
    return result.structuredContent.workspace_id;
  });

  await withClient(mcpUrl, async (client) => {
    const inventory = await callTool(client, 'codexpro_inventory', {
      include_global_skills: false,
      include_mcp_servers: false
    });
    if (inventory.structuredContent.codexpro_tool !== 'codexpro_inventory') {
      throw new Error('HTTP inventory result was not tagged for widget rendering');
    }
    const loadedSkill = await callTool(client, 'load_skill', {
      name: 'http-smoke-skill',
      source: 'workspace'
    });
    if (loadedSkill.structuredContent.skill?.name !== 'http-smoke-skill' || !loadedSkill.structuredContent.text?.includes('# HTTP Smoke Skill')) {
      throw new Error('HTTP load_skill did not return bounded SKILL.md content');
    }
  });

  const opened = await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_workspace', { include_tree: false });
    return result.structuredContent.workspace_id;
  });
  if (opened !== currentOpened) {
    throw new Error(`open_current_workspace returned ${currentOpened}, open_workspace default returned ${opened}`);
  }

  await withClient(mcpUrl, async (client) => {
    const list = await callTool(client, 'list_workspaces');
    const ids = list.structuredContent.workspaces.map((workspace) => workspace.id);
    if (!ids.includes(opened)) {
      throw new Error(`cross-session list_workspaces missing ${opened}; got ${ids.join(', ')}`);
    }

    const snapshot = await callTool(client, 'workspace_snapshot', { workspace_id: opened, max_depth: 1 });
    if (snapshot.structuredContent.workspace_id !== opened) {
      throw new Error(`workspace_snapshot returned ${snapshot.structuredContent.workspace_id}, expected ${opened}`);
    }

    const tree = await callTool(client, 'tree', { workspace_id: opened, max_depth: 1, max_entries: 10 });
    if (tree.structuredContent.workspace_id !== opened) {
      throw new Error(`tree returned ${tree.structuredContent.workspace_id}, expected ${opened}`);
    }

    const codexContext = await callTool(client, 'codex_context', { workspace_id: opened });
    if (codexContext.structuredContent.workspace_id !== opened) {
      throw new Error(`codex_context returned ${codexContext.structuredContent.workspace_id}, expected ${opened}`);
    }
  });

  try {
    await fs.stat(path.join(root, '.ai-bridge'));
    throw new Error('read-only HTTP smoke path created .ai-bridge unexpectedly');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await withClient(mcpUrl, async (client) => {
    const exported = await callTool(client, 'export_pro_context', {
      workspace_id: opened,
      max_files: 4,
      max_total_bytes: 80000
    });
    if (exported.structuredContent.path !== '.ai-bridge/pro-context.md') {
      throw new Error(`unexpected pro context path: ${exported.structuredContent.path}`);
    }
  });
  await fs.stat(path.join(root, '.ai-bridge', 'pro-context.md'));
} finally {
  child.kill('SIGTERM');
}

console.log('✓ http smoke test passed');
