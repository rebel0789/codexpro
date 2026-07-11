import { createHash } from 'node:crypto';
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

async function waitForHealthJson(url, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${url}\n${lastError}`);
}

async function expectHttpTokenRequired(name, overrides = {}, options = {}) {
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
  if (!options.keepAllowNoToken) delete env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;

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
  return meta.ui?.resourceUri === uri && meta['openai/outputTemplate'] === uri;
}

function hasToolCardStatusMeta(tools, name) {
  const tool = tools.find((item) => item.name === name);
  const meta = tool?._meta ?? {};
  return Boolean(meta['openai/toolInvocation/invoking'] || meta['openai/toolInvocation/invoked']);
}

await expectHttpTokenRequired('loopback-default');
await expectHttpTokenRequired('non-loopback', { CODEXPRO_HOST: '0.0.0.0' });
await expectHttpTokenRequired('non-loopback-allow-no-token', { CODEXPRO_HOST: '0.0.0.0', CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1' }, { keepAllowNoToken: true });
await expectHttpTokenRequired('tunnel-mode', { CODEXPRO_TUNNEL_MODE: '1' });

async function withClient(url, fn) {
  const client = new Client({ name: 'codexpro-http-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    return await fn(client, transport);
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

async function expectSessionNotFound(response, label) {
  const body = await response.json();
  if (
    response.status !== 404 ||
    !response.headers.get('content-type')?.includes('application/json') ||
    body.error?.code !== -32001 ||
    body.error?.message !== 'Session not found'
  ) {
    throw new Error(`expected ${label} to return JSON-RPC session-not-found 404, got ${response.status} ${JSON.stringify(body)}`);
  }
}

function postToolsListWithSession(baseUrl, token, sessionId) {
  return fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 404, method: 'tools/list', params: {} })
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-smoke-'));
const profileHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-profile-home-'));
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
const genericPort = await getFreePort();
const token = 'codexpro-http-smoke-token';
const runtimeQuerySecret = 'runtimequerysecret1234567890';
const runtimeAccessSecret = 'runtimeaccesssecret1234567890';
const runtimeCloudflareSecret = 'eyJhbGciOiJIUzI1NiJ9.eyJ0dW5uZWwiOiJodHRwLXNtb2tlIn0.signature1234567890';
const staleCloudflareToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ0dW5uZWwiOiJzdGFsZS1odHRwLXNtb2tlIn0.signature1234567890';
const runtimeId = createHash('sha256').update(root).digest('hex').slice(0, 24);
await fs.mkdir(path.join(profileHome, 'runtime'), { recursive: true });
await fs.writeFile(path.join(profileHome, 'runtime', `${runtimeId}.json`), JSON.stringify({
  version: 1,
  root,
  endpoint: `https://runtime.example/mcp?token=${runtimeQuerySecret}`,
  localStatusUrl: `http://127.0.0.1:${port}/?codexpro_token=${token}&access_token=${runtimeAccessSecret}`,
  note: `cloudflared tunnel run --token ${runtimeCloudflareSecret}`
}, null, 2), 'utf8');
const child = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: String(genericPort),
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_BASH_MODE: 'safe',
    CODEXPRO_WRITE_MODE: 'handoff',
    CODEXPRO_TOOL_MODE: 'full',
    CODEXPRO_TOOL_CARDS: '0',
    CODEXPRO_WIDGET_DOMAIN: 'https://widgets.codexpro.test',
    CODEXPRO_HOME: profileHome
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
  const authorizedJson = await authorized.json();
  if (authorizedJson.authRequired !== true) {
    throw new Error(`expected authenticated healthz to report authRequired=true, got ${JSON.stringify(authorizedJson)}`);
  }

  for (const header of [`bearer ${token}`, `Bearer    ${token}`]) {
    const variant = await fetch(`${baseUrl}/healthz`, {
      headers: { Authorization: header }
    });
    if (variant.status !== 200) {
      throw new Error(`expected authorization header variant ${JSON.stringify(header)} to return 200, got ${variant.status}`);
    }
  }

  const queryAuthorized = await fetch(`${baseUrl}/healthz?codexpro_token=${encodeURIComponent(token)}`);
  if (queryAuthorized.status !== 200) {
    throw new Error(`expected URL-token healthz to return 200, got ${queryAuthorized.status}`);
  }

  const badAdminJson = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"tunnel":'
  });
  const badAdminBody = await badAdminJson.json();
  if (badAdminJson.status !== 400 || badAdminBody.error?.code !== 'invalid_json') {
    throw new Error(`expected invalid admin JSON to return structured 400, got ${badAdminJson.status} ${JSON.stringify(badAdminBody)}`);
  }

  const badMcpJson = await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":'
  });
  const badMcpBody = await badMcpJson.json();
  if (badMcpJson.status !== 400 || badMcpBody.error?.code !== -32700) {
    throw new Error(`expected invalid MCP JSON to return JSON-RPC parse error, got ${badMcpJson.status} ${JSON.stringify(badMcpBody)}`);
  }

  const hugeMcpJson = await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { filler: 'x'.repeat(21 * 1024 * 1024) } })
  });
  const hugeMcpBody = await hugeMcpJson.json();
  if (hugeMcpJson.status !== 413 || hugeMcpBody.error?.code !== -32000) {
    throw new Error(`expected oversized MCP body to return JSON-RPC payload error, got ${hugeMcpJson.status} ${JSON.stringify(hugeMcpBody)}`);
  }

  const favicon = await fetch(`${baseUrl}/favicon.ico`);
  if (favicon.status !== 200 || !favicon.headers.get('content-type')?.includes('image/svg+xml')) {
    throw new Error(`expected unauthenticated favicon to return SVG 200, got ${favicon.status} ${favicon.headers.get('content-type')}`);
  }

  const home = await fetch(`${baseUrl}/?codexpro_token=${encodeURIComponent(token)}`);
  const homeText = await home.text();
  if (home.status !== 200 || !home.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`expected authenticated onboarding page to return HTML 200, got ${home.status}`);
  }
  if (!homeText.includes('CodexPro Local Control') || !homeText.includes('CLI controls') || !homeText.includes('Connect ChatGPT') || !homeText.includes('Runtime guardrails')) {
    throw new Error('onboarding page did not include expected admin setup copy');
  }
  if (!homeText.includes('Connection profile') || !homeText.includes('data-profile-form')) {
    throw new Error('onboarding page did not include the saved profile editor');
  }
  for (const fieldName of ['tunnelName', 'ngrokConfig', 'cloudflareConfig', 'cloudflareTokenFile', 'toolCards', 'noInstallCloudflared']) {
    if (!homeText.includes(`name="${fieldName}"`)) {
      throw new Error(`onboarding page did not include profile field ${fieldName}`);
    }
  }
  if (homeText.includes(token)) {
    throw new Error('onboarding page leaked the raw auth token');
  }
  for (const leaked of [runtimeQuerySecret, runtimeAccessSecret, runtimeCloudflareSecret]) {
    if (homeText.includes(leaked)) throw new Error(`onboarding page leaked runtime secret: ${leaked}`);
  }

  const profileBefore = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`);
  const profileBeforeJson = await profileBefore.json();
  if (profileBefore.status !== 200 || profileBeforeJson.exists !== false) {
    throw new Error(`expected empty admin profile response, got ${profileBefore.status} ${JSON.stringify(profileBeforeJson)}`);
  }
  if (JSON.stringify(profileBeforeJson).includes(token)) {
    throw new Error('admin profile GET leaked the raw auth token');
  }
  for (const leaked of [runtimeQuerySecret, runtimeAccessSecret, runtimeCloudflareSecret]) {
    if (JSON.stringify(profileBeforeJson).includes(leaked)) throw new Error(`admin profile GET leaked runtime secret: ${leaked}`);
  }

  const invalidProfile = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'codexpro-http-smoke.ngrok-free.app',
      requireBashSession: true,
      bashSession: ''
    })
  });
  if (invalidProfile.status !== 400) {
    throw new Error(`expected invalid guarded profile to return 400, got ${invalidProfile.status}`);
  }
  await fs.mkdir(path.join(profileHome, 'profiles'), { recursive: true });
  await fs.writeFile(path.join(profileHome, 'profiles', `${runtimeId}.json`), JSON.stringify({
    version: 1,
    root,
    tunnel: 'cloudflare-named',
    hostname: 'stale.example.com',
    cloudflareToken: staleCloudflareToken,
    cloudflareTokenFile: path.join(root, 'stale-cloudflare-token')
  }, null, 2), 'utf8');

  const profileSave = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tunnel: 'ngrok',
      hostname: 'https://codexpro-http-smoke.ngrok-free.app/mcp',
      port,
      mode: 'agent',
      bash: 'safe',
      bashTranscript: 'full',
      codexSessions: 'metadata',
      codexDir: path.join(root, '.codex'),
      bashSession: 'http-main',
      requireBashSession: true,
      write: 'workspace',
      toolMode: 'full',
      toolCards: true,
      widgetDomain: 'https://widgets.codexpro.test',
      ngrokConfig: path.join(root, 'ngrok.yml'),
      cloudflareTokenFile: 'cloudflare-token',
      noInstallCloudflared: true
    })
  });
  const profileSaveJson = await profileSave.json();
  if (profileSave.status !== 200 || profileSaveJson.saved !== true) {
    throw new Error(`expected admin profile save to pass, got ${profileSave.status} ${JSON.stringify(profileSaveJson)}`);
  }
  if (JSON.stringify(profileSaveJson).includes(token)) {
    throw new Error('admin profile save response leaked the raw auth token');
  }
  const savedProfile = JSON.parse(await fs.readFile(profileSaveJson.profile_path, 'utf8'));
  if (
    savedProfile.tunnel !== 'ngrok' ||
    savedProfile.hostname !== 'codexpro-http-smoke.ngrok-free.app' ||
    savedProfile.bashTranscript !== 'full' ||
    savedProfile.codexSessions !== 'metadata' ||
    savedProfile.bashSession !== 'http-main' ||
    savedProfile.requireBashSession !== true ||
    savedProfile.toolCards !== true ||
    savedProfile.ngrokConfig !== path.join(root, 'ngrok.yml') ||
    savedProfile.noInstallCloudflared !== true ||
    savedProfile.token !== token
  ) {
    throw new Error(`admin profile save wrote unexpected profile: ${JSON.stringify(savedProfile)}`);
  }
  if (savedProfile.cloudflareToken || savedProfile.cloudflareTokenFile) {
    throw new Error(`admin profile save kept cloudflare token config on ngrok profile: ${JSON.stringify(savedProfile)}`);
  }

  const localProfile = await fetch(`${baseUrl}/admin/profile?codexpro_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tunnel: 'none' })
  });
  const localProfileJson = await localProfile.json();
  const localSavedProfile = JSON.parse(await fs.readFile(localProfileJson.profile_path, 'utf8'));
  if (
    localProfile.status !== 200 ||
    localSavedProfile.hostname ||
    localSavedProfile.ngrokConfig ||
    localSavedProfile.tunnelName ||
    localSavedProfile.cloudflareConfig ||
    localSavedProfile.cloudflareToken ||
    localSavedProfile.cloudflareTokenFile ||
    localProfileJson.profile?.hostname ||
    localProfileJson.profile?.ngrokConfig ||
    localProfileJson.profile?.cloudflareToken ||
    localProfileJson.profile?.cloudflareTokenFile ||
    localProfileJson.effective?.hostname ||
    localProfileJson.effective?.ngrokConfig ||
    localProfileJson.effective?.cloudflareToken ||
    localProfileJson.effective?.cloudflareTokenFile
  ) {
    throw new Error(`admin profile local-only save kept stale tunnel config: ${JSON.stringify(localProfileJson)} ${JSON.stringify(localSavedProfile)}`);
  }

  const queryTools = await listTools(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`);
  const queryToolNames = toolNames(queryTools);
  for (const expected of ['server_config', 'codexpro_self_test', 'codexpro_inventory', 'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'tree', 'search', 'load_skill', 'git_status', 'git_diff', 'show_changes', 'read_handoff', 'wait_for_handoff', 'codex_context', 'handoff_to_agent', 'handoff_to_codex', 'export_pro_context']) {
    if (!queryToolNames.includes(expected)) {
      throw new Error(`URL-token MCP tools/list missing ${expected}; got ${queryToolNames.join(', ')}`);
    }
  }
  for (const hidden of ['write', 'edit']) {
    if (queryToolNames.includes(hidden)) {
      throw new Error(`HTTP handoff mode should not advertise ${hidden}; got ${queryToolNames.join(', ')}`);
    }
  }
  const toolCardUri = 'ui://widget/codexpro-tool-card-v9.html';
  for (const visualTool of queryToolNames) {
    if (hasWidgetMeta(queryTools, visualTool, toolCardUri) || hasToolCardStatusMeta(queryTools, visualTool)) {
      throw new Error(`${visualTool} exposed widget metadata while CODEXPRO_TOOL_CARDS is off`);
    }
  }

  const headerTools = await listTools(`${baseUrl}/mcp`, token);
  const headerToolNames = toolNames(headerTools);
  if (!headerToolNames.includes('server_config')) {
    throw new Error(`bearer MCP tools/list missing server_config; got ${headerToolNames.join(', ')}`);
  }

  const mcpUrl = `${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`;
  const unknownSession = '00000000-0000-4000-8000-000000000000';
  await expectSessionNotFound(await postToolsListWithSession(baseUrl, token, unknownSession), 'unknown POST session');
  await expectSessionNotFound(await fetch(`${baseUrl}/mcp?codexpro_token=${encodeURIComponent(token)}`, {
    headers: {
      accept: 'text/event-stream',
      'mcp-session-id': unknownSession
    }
  }), 'unknown GET session');
  await withClient(mcpUrl, async (client, transport) => {
    await client.listTools();
    const staleSession = transport.sessionId;
    if (!staleSession) throw new Error('HTTP MCP client did not receive a session id');
    await transport.terminateSession();
    await expectSessionNotFound(await postToolsListWithSession(baseUrl, token, staleSession), 'stale POST session');
  });

  await withClient(mcpUrl, async (client) => {
    const resources = await client.listResources();
    const toolCard = resources.resources.find((resource) => resource.uri === toolCardUri);
    if (!toolCard) throw new Error(`HTTP MCP resources/list missing ${toolCardUri}`);
    if (toolCard.mimeType !== 'text/html;profile=mcp-app') {
      throw new Error(`unexpected HTTP tool-card mime type: ${toolCard.mimeType}`);
    }
    const legacyToolCardUri = 'ui://widget/codexpro-tool-card-v8.html';
    const legacyToolCard = resources.resources.find((resource) => resource.uri === legacyToolCardUri);
    if (!legacyToolCard) throw new Error(`HTTP MCP resources/list missing legacy ${legacyToolCardUri}`);
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
    const legacyWidget = await client.readResource({ uri: legacyToolCardUri });
    if (legacyWidget.contents?.[0]?.uri !== legacyToolCardUri) {
      throw new Error('HTTP legacy tool-card widget resource did not preserve requested URI');
    }
    if (!(legacyWidget.contents?.[0]?.text ?? '').includes('Waiting for tool result')) {
      throw new Error('HTTP legacy tool-card widget resource did not serve widget HTML');
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
    if (result.structuredContent.skill_inventory?.length) {
      throw new Error('HTTP open_current_workspace discovered skills by default');
    }
    const withSkills = await callTool(client, 'open_current_workspace', {
      include_tree: false,
      include_skills: true
    });
    if (!withSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_current_workspace did not discover workspace skill inventory when requested');
    }
    return result.structuredContent.workspace_id;
  });

  await withClient(mcpUrl, async (client) => {
    const result = await callTool(client, 'open_workspace', {
      root,
      include_tree: false
    });
    if (result.structuredContent.skill_inventory?.length) {
      throw new Error('HTTP open_workspace discovered skills by default');
    }
    const withSkills = await callTool(client, 'open_workspace', {
      root,
      include_tree: false,
      include_skills: true
    });
    if (!withSkills.structuredContent.skill_inventory?.some?.((skill) => skill.name === 'http-smoke-skill')) {
      throw new Error('HTTP open_workspace did not discover workspace skill inventory when requested');
    }
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
  await waitForExit(child).catch(() => {});
}

const disabledRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-http-disabled-tools-'));
const disabledPort = await getFreePort();
const disabledToken = 'codexpro-http-disabled-token';
const disabledChild = spawn('node', ['dist/http.js'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: disabledRoot,
    CODEXPRO_ALLOWED_ROOTS: disabledRoot,
    CODEXPRO_PORT: String(disabledPort),
    CODEXPRO_HTTP_TOKEN: disabledToken,
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_TOOL_MODE: 'full'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForListening(disabledChild);
  const disabledBase = `http://127.0.0.1:${disabledPort}`;
  const disabledTools = await listTools(`${disabledBase}/mcp?codexpro_token=${encodeURIComponent(disabledToken)}`);
  const disabledToolNames = toolNames(disabledTools);
  for (const hiddenTool of ['bash', 'write', 'edit']) {
    if (disabledToolNames.includes(hiddenTool)) {
      throw new Error(`HTTP disabled mode should not advertise ${hiddenTool}; got ${disabledToolNames.join(', ')}`);
    }
  }
  await withClient(`${disabledBase}/mcp?codexpro_token=${encodeURIComponent(disabledToken)}`, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.bashMode !== 'off' || config.structuredContent.writeMode !== 'off') {
      throw new Error(`HTTP disabled mode server_config mismatch: ${JSON.stringify(config.structuredContent)}`);
    }
  });
} finally {
  disabledChild.kill('SIGTERM');
  await waitForExit(disabledChild).catch(() => {});
}

const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-smoke-'));
await fs.mkdir(path.join(cliRoot, '.codex'), { recursive: true });
const cliPort = await getFreePort();
const badNoAuth = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'start',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--host',
  '0.0.0.0',
  '--port',
  String(cliPort)
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-bad-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const badNoAuthExit = await waitForExit(badNoAuth);
if (badNoAuthExit.code === 0 || !badNoAuthExit.stderr.includes('--no-auth is only allowed')) {
  throw new Error(`non-loopback --no-auth was not rejected\n${badNoAuthExit.stderr}`);
}
const cliChild = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'start',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--port',
  String(cliPort),
  '--codex-sessions',
  'metadata',
  '--codex-dir',
  '.codex'
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-cli-http-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
try {
  await waitForHealthJson(`http://127.0.0.1:${cliPort}/healthz`);
  const expectedCliCodexDir = path.join(await fs.realpath(cliRoot), '.codex');
  await withClient(`http://127.0.0.1:${cliPort}/mcp`, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.codexDir !== expectedCliCodexDir) {
      throw new Error(`relative --codex-dir resolved to ${config.structuredContent.codexDir}, expected ${expectedCliCodexDir}`);
    }
  });
} finally {
  cliChild.kill('SIGTERM');
  await waitForExit(cliChild).catch(() => {});
}

const connectionTestPort = await getFreePort();
let connectionTestStderr = '';
const connectionTestChild = spawn(process.execPath, [
  'scripts/codexpro.mjs',
  'connection-test',
  '--root',
  cliRoot,
  '--tunnel',
  'none',
  '--no-auth',
  '--no-profile',
  '--port',
  String(connectionTestPort)
], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-connection-test-home-'))
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
connectionTestChild.stderr.on('data', (chunk) => {
  connectionTestStderr += String(chunk);
});
try {
  await waitForHealthJson(`http://127.0.0.1:${connectionTestPort}/healthz`);
  const tools = await listTools(`http://127.0.0.1:${connectionTestPort}/mcp`);
  const names = toolNames(tools);
  for (const expected of ['read', 'tree', 'search', 'load_skill']) {
    if (!names.includes(expected)) throw new Error(`connection-test missing ${expected}; got ${names.join(', ')}`);
  }
  for (const hidden of ['codexpro', 'codexpro_self_test', 'write', 'edit', 'apply_patch', 'bash', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
    if (names.includes(hidden)) throw new Error(`connection-test exposed ${hidden}; got ${names.join(', ')}`);
  }
  for (const tool of tools) {
    const annotations = tool.annotations ?? {};
    if (annotations.readOnlyHint !== true || annotations.openWorldHint !== false || annotations.destructiveHint !== false) {
      throw new Error(`connection-test exposed non-read-only annotations for ${tool.name}: ${JSON.stringify(annotations)}`);
    }
  }
  await withClient(`http://127.0.0.1:${connectionTestPort}/mcp`, async (client) => {
    const config = await callTool(client, 'server_config');
    if (config.structuredContent.connectionTest !== true || config.structuredContent.toolCards !== false) {
      throw new Error(`unexpected connection-test config: ${JSON.stringify(config.structuredContent)}`);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (!connectionTestStderr.includes('[CodexPro] POST /mcp received')) {
    throw new Error(`connection-test did not print request-arrival logs\n${connectionTestStderr}`);
  }
} finally {
  connectionTestChild.kill('SIGTERM');
  await waitForExit(connectionTestChild).catch(() => {});
}

console.log('✓ http smoke test passed');
