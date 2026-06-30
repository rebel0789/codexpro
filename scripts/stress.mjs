import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

class McpStdioClient {
  constructor(root, env = {}) {
    this.child = spawn(process.execPath, ['dist/stdio.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        ...env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_TOOL_MODE: env.CODEXPRO_TOOL_MODE ?? 'full',
        CODEXPRO_BASH_MODE: env.CODEXPRO_BASH_MODE ?? 'safe',
        CODEXPRO_MAX_SEARCH_RESULTS: '2000',
        CODEXPRO_MAX_OUTPUT_BYTES: '2000000',
        CODEXPRO_TOOL_CARDS: env.CODEXPRO_TOOL_CARDS ?? '0'
      }
    });
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}\n${this.stderr}`));
      this.pending.clear();
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
      if (!msg.id || !this.pending.has(msg.id)) continue;
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}\n${this.stderr}`)), 20000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

async function initClient(root, env) {
  const client = new McpStdioClient(root, env);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-stress', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  return client;
}

async function expectToolError(client, name, args, pattern) {
  const result = await client.request('tools/call', { name, arguments: args });
  assert(result.isError === true, `${name} unexpectedly succeeded`);
  const text = JSON.stringify(result);
  if (pattern) assert(pattern.test(text), `${name} error did not match ${pattern}: ${text}`);
  return result;
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Stress Agents\n\nKeep checks local.\n', 'utf8');
  await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\n--flag root\narrow -> value\n', 'utf8');
  await fs.writeFile(path.join(root, '.hidden.txt'), 'needle hidden\n', 'utf8');
  await fs.writeFile(path.join(root, 'visible:123:file.txt'), 'needle colon path\n', 'utf8');
  await fs.mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8');
  await fs.mkdir(path.join(root, 'many'), { recursive: true });
  for (let file = 0; file < 50; file += 1) {
    const lines = Array.from({ length: 60 }, (_, line) => `file ${file} line ${line} --flag -> stress-needle-${line % 11}`);
    await fs.writeFile(path.join(root, 'many', `hits-${file}.txt`), `${lines.join('\n')}\n`, 'utf8');
  }
  for (let i = 0; i < 140; i += 1) {
    const name = `stress-skill-${String(i).padStart(3, '0')}`;
    const dir = path.join(root, '.codex', 'skills', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Stress skill ${i}.\n---\n\n# Stress Skill ${i}\n`, 'utf8');
  }
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'agent-status.md'), '# Agent Status\n\nPASS stress handoff.\n', 'utf8');
  await fs.writeFile(path.join(root, '.ai-bridge', 'implementation-diff.patch'), 'diff --git a/demo.txt b/demo.txt\n', 'utf8');
  await fs.writeFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'stress' })}\n`, 'utf8');
  return root;
}

async function runFullModeStress(root) {
  const client = await initClient(root);
  try {
    const tools = await client.request('tools/list', {});
    const names = tools.tools.map((tool) => tool.name);
    for (const name of ['codexpro', 'codexpro_inventory', 'open_current_workspace', 'search', 'load_skill', 'wait_for_handoff', 'export_pro_context', 'bash']) {
      assert(names.includes(name), `full mode missing ${name}`);
    }

    const config = await client.request('tools/call', { name: 'server_config', arguments: {} });
    assert(config.structuredContent.toolMode === 'full', `expected full tool mode, got ${config.structuredContent.toolMode}`);
    assert(config.structuredContent.registeredTools.includes('codexpro'), 'server_config missing codexpro supertool');

    const superActions = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'list_actions' }
    });
    assert(superActions.structuredContent.actions.includes('search'), 'supertool actions missing search');
    assert(superActions.structuredContent.actions.includes('export_pro_context'), 'supertool actions missing export_pro_context');

    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    assert(opened.structuredContent.skill_inventory.length === 0, 'default workspace open loaded skills');
    const ws = opened.structuredContent.workspace_id;

    const superOpened = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'open', args: { include_tree: false } }
    });
    assert(superOpened.structuredContent.wrapped_tool === 'open_current_workspace', 'supertool open alias did not wrap open_current_workspace');
    assert(superOpened.structuredContent.skill_inventory.length === 0, 'supertool default workspace open loaded skills');

    const withSkills = await client.request('tools/call', {
      name: 'open_current_workspace',
      arguments: { include_tree: false, include_skills: true, include_global_skills: false }
    });
    assert(withSkills.structuredContent.skill_inventory.length === 120, `expected capped 120 skills, got ${withSkills.structuredContent.skill_inventory.length}`);

    const firstSkill = withSkills.structuredContent.skill_inventory[0];
    const loaded = await client.request('tools/call', {
      name: 'load_skill',
      arguments: { workspace_id: ws, name: firstSkill.name, source: firstSkill.source, path: firstSkill.path }
    });
    assert(loaded.structuredContent.text.includes('# Stress Skill'), 'load_skill did not return skill body');

    const inventory = await client.request('tools/call', {
      name: 'codexpro_inventory',
      arguments: { workspace_id: ws, include_global_skills: false, include_mcp_servers: false, max_skills: 140 }
    });
    assert(inventory.structuredContent.skill_count === 140, `expected 140 inventory skills, got ${inventory.structuredContent.skill_count}`);
    const lastSkill = inventory.structuredContent.skills.find((skill) => skill.name === 'stress-skill-139');
    assert(lastSkill, 'inventory did not include stress-skill-139');
    const loadedLast = await client.request('tools/call', {
      name: 'load_skill',
      arguments: { workspace_id: ws, name: lastSkill.name, source: lastSkill.source, path: lastSkill.path }
    });
    assert(loadedLast.structuredContent.text.includes('# Stress Skill 139'), 'load_skill did not load high-cap inventory skill');

    const largeSearch = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: ws, query: '--flag', path: 'many', max_results: 2000 }
    });
    assert(largeSearch.structuredContent.matches.length === 2000, `expected 2000 search matches, got ${largeSearch.structuredContent.matches.length}`);
    assert(largeSearch.structuredContent.truncated === true, 'large search did not report truncation');
    assert(!('text' in largeSearch.structuredContent), 'search duplicated text in structuredContent with cards off');

    if (spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? ['rg'] : ['-lc', 'command -v rg >/dev/null 2>&1']).status === 0) {
      const rgRegex = await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: ws, query: '(?i)STRESS-NEEDLE-3', path: 'many', regex: true, max_results: 10 }
      });
      assert(rgRegex.structuredContent.used === 'ripgrep' && rgRegex.structuredContent.matches.length === 10, 'ripgrep regex search rejected rg syntax');
    }

    const hiddenSearch = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: ws, query: 'needle hidden', include_hidden: true, max_results: 10 }
    });
    assert(hiddenSearch.structuredContent.matches.some((match) => match.path === '.hidden.txt'), 'include_hidden search missed hidden file');

    const colonSearch = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: ws, query: 'needle colon path', max_results: 10 }
    });
    assert(colonSearch.structuredContent.matches.some((match) => match.path === 'visible:123:file.txt' && match.line === 1), `colon path search parsed incorrectly: ${JSON.stringify(colonSearch.structuredContent.matches)}`);

    const superRead = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'read', args: { workspace_id: ws, path: 'demo.txt', start_line: 1, end_line: 3 } }
    });
    assert(superRead.structuredContent.codexpro_tool === 'read' && superRead.structuredContent.wrapped_tool === 'read' && superRead.structuredContent.text.includes('--flag root'), 'supertool read failed');

    const superSearch = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'search', args: { workspace_id: ws, query: 'stress-needle-3', path: 'many', max_results: 20 } }
    });
    assert(superSearch.structuredContent.codexpro_tool === 'search' && superSearch.structuredContent.wrapped_tool === 'search', 'supertool search did not report wrapped tool');
    assert(superSearch.structuredContent.matches.length === 20, `supertool search returned ${superSearch.structuredContent.matches.length} matches`);

    const safePwd = await client.request('tools/call', {
      name: 'bash',
      arguments: { workspace_id: ws, command: 'pwd' }
    });
    assert(safePwd.isError !== true && safePwd.structuredContent.exitCode === 0, 'safe bash rejected allowed pwd command');

    const newlineDirectTarget = path.join(root, 'newline-direct-owned');
    const blockedNewline = await client.request('tools/call', {
      name: 'bash',
      arguments: { workspace_id: ws, command: 'pwd\ntouch newline-direct-owned' }
    });
    assert(blockedNewline.isError === true && String(blockedNewline.structuredContent.error).includes('blocked'), 'safe bash allowed newline command chaining');
    assert(!(await pathExists(newlineDirectTarget)), 'safe bash newline command created a file');

    const newlineSuperTarget = path.join(root, 'newline-supertool-owned');
    const blockedSuperNewline = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'bash', args: { workspace_id: ws, command: 'pwd\ntouch newline-supertool-owned' } }
    });
    assert(blockedSuperNewline.isError === true && blockedSuperNewline.structuredContent.codexpro_tool === 'bash', 'supertool safe bash newline error was not tagged as bash');
    assert(!(await pathExists(newlineSuperTarget)), 'supertool safe bash newline command created a file');

    const blockedOutputFlag = await client.request('tools/call', {
      name: 'bash',
      arguments: { workspace_id: ws, command: 'git diff "--output=safe-bash-owned.patch"' }
    });
    assert(blockedOutputFlag.isError === true && String(blockedOutputFlag.structuredContent.error).includes('blocked'), 'safe bash allowed quoted git output path');
    assert(!(await pathExists(path.join(root, 'safe-bash-owned.patch'))), 'safe bash git output path created a file');

    const blockedDollarExpansion = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'bash', args: { workspace_id: ws, command: "git diff $'--output=supertool-owned.patch'" } }
    });
    assert(blockedDollarExpansion.isError === true && blockedDollarExpansion.structuredContent.codexpro_tool === 'bash', 'supertool safe bash allowed dollar-quoted expansion');
    assert(!(await pathExists(path.join(root, 'supertool-owned.patch'))), 'supertool dollar-quoted git output path created a file');

    const blockedFindFprint0 = await client.request('tools/call', {
      name: 'bash',
      arguments: { workspace_id: ws, command: 'find . "-fprint0" find-owned.txt' }
    });
    assert(blockedFindFprint0.isError === true && String(blockedFindFprint0.structuredContent.error).includes('blocked'), 'safe bash allowed quoted find -fprint0 path write');
    assert(!(await pathExists(path.join(root, 'find-owned.txt'))), 'safe bash find -fprint0 created a file');

    const blockedEnvWrite = await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: ws, path: '.env/notes.txt', content: 'not a literal secret\n' }
    });
    assert(blockedEnvWrite.isError === true, 'write allowed .env descendant path');
    assert(!(await pathExists(path.join(root, '.env', 'notes.txt'))), 'blocked .env descendant write created a file');

    const arrows = await Promise.all(Array.from({ length: 12 }, () =>
      client.request('tools/call', { name: 'search', arguments: { workspace_id: ws, query: '->', path: 'many', max_results: 25 } })
    ));
    assert(arrows.every((result) => result.structuredContent.matches.length === 25), 'concurrent arrow searches failed');

    await fs.writeFile(path.join(root, '.ai-bridge', 'handoff-run-state.json'), `${JSON.stringify({
      version: 1,
      state: 'completed',
      iteration: 7,
      plan_hash: 'stress-plan',
      executor: 'codex',
      model: 'local-test',
      exit_code: 0,
      timed_out: false,
      started_at: new Date(Date.now() - 1000).toISOString(),
      finished_at: new Date().toISOString(),
      status_file: '.ai-bridge/agent-status.md',
      diff_file: '.ai-bridge/implementation-diff.patch',
      log_file: '.ai-bridge/execution-log.jsonl'
    }, null, 2)}\n`, 'utf8');
    const completed = await client.request('tools/call', {
      name: 'wait_for_handoff',
      arguments: { workspace_id: ws, plan_hash: 'stress-plan', since_iteration: 6, max_wait_seconds: 1, poll_ms: 250 }
    });
    assert(completed.structuredContent.awaited_completed === true && completed.structuredContent.state === 'completed', 'wait_for_handoff did not complete expected state');
    assert(String(completed.structuredContent.status_excerpt ?? '').includes('PASS stress handoff'), 'wait_for_handoff missed status excerpt');

    const superWait = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'handoff_poll', args: { workspace_id: ws, plan_hash: 'stress-plan', since_iteration: 6, max_wait_seconds: 1, poll_ms: 250 } }
    });
    assert(superWait.structuredContent.codexpro_tool === 'wait_for_handoff' && superWait.structuredContent.wrapped_tool === 'wait_for_handoff' && superWait.structuredContent.succeeded === true, 'supertool handoff_poll failed');

    const mismatch = await client.request('tools/call', {
      name: 'wait_for_handoff',
      arguments: { workspace_id: ws, plan_hash: 'wrong-plan', max_wait_seconds: 1, poll_ms: 250 }
    });
    assert(mismatch.structuredContent.awaited_completed === false && mismatch.structuredContent.plan_hash_mismatch === true, 'wait_for_handoff mismatch did not fail closed');

    await fs.rm(path.join(root, '.ai-bridge', 'handoff-run-state.json'), { force: true });
    const slowPollStart = Date.now();
    await client.request('tools/call', {
      name: 'wait_for_handoff',
      arguments: { workspace_id: ws, max_wait_seconds: 1, poll_ms: 5000 }
    });
    assert(Date.now() - slowPollStart < 2500, 'wait_for_handoff exceeded max_wait_seconds by a full poll interval');

    const exactExport = await client.request('tools/call', {
      name: 'export_pro_context',
      arguments: {
        workspace_id: ws,
        selected_paths: ['demo.txt'],
        include_important_files: false,
        include_changed_files: false,
        include_diff: false,
        include_ai_bridge: false,
        max_files: 1,
        max_total_bytes: 20000
      }
    });
    assert(exactExport.structuredContent.files_included.length === 1 && exactExport.structuredContent.files_included[0] === 'demo.txt', `exact Pro export included wrong files: ${JSON.stringify(exactExport.structuredContent.files_included)}`);

    const superExport = await client.request('tools/call', {
      name: 'codexpro',
      arguments: {
        action: 'pro_export',
        args: {
          workspace_id: ws,
          selected_paths: ['demo.txt'],
          include_important_files: false,
          include_changed_files: false,
          include_diff: false,
          include_ai_bridge: false,
          max_files: 1,
          max_total_bytes: 20000
        }
      }
    });
    assert(superExport.structuredContent.codexpro_tool === 'export_pro_context' && superExport.structuredContent.wrapped_tool === 'export_pro_context', 'supertool pro_export did not wrap export_pro_context');
    assert(superExport.structuredContent.files_included.length === 1 && superExport.structuredContent.files_included[0] === 'demo.txt', `supertool Pro export included wrong files: ${JSON.stringify(superExport.structuredContent.files_included)}`);

    const hiddenGlobExport = await client.request('tools/call', {
      name: 'export_pro_context',
      arguments: {
        workspace_id: ws,
        extra_globs: ['.github/**/*.yml'],
        include_important_files: false,
        include_changed_files: false,
        include_diff: false,
        include_ai_bridge: false,
        max_files: 4,
        max_total_bytes: 20000
      }
    });
    assert(hiddenGlobExport.structuredContent.files_included.includes('.github/workflows/ci.yml'), `Pro export extra_globs missed hidden path: ${JSON.stringify(hiddenGlobExport.structuredContent.files_included)}`);

    const selfTest = await client.request('tools/call', { name: 'codexpro_self_test', arguments: { workspace_id: ws } });
    assert(selfTest.structuredContent.status !== 'fail', `codexpro_self_test failed: ${JSON.stringify(selfTest.structuredContent.checks)}`);
  } finally {
    client.close();
  }
}

async function runGlobalSkillStress(root) {
  void root;
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-global-root-'));
  const name = `000-codexpro-global-stress-${Date.now()}`;
  const dir = path.join(os.homedir(), '.codex', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Global stress skill.\n---\n\n# Global Only Skill\n`, 'utf8');
  let client;
  try {
    client = await initClient(isolatedRoot);
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const inventory = await client.request('tools/call', {
      name: 'codexpro_inventory',
      arguments: { workspace_id: opened.structuredContent.workspace_id, include_mcp_servers: false, max_skills: 500 }
    });
    const skill = inventory.structuredContent.skills.find((item) => item.name === name);
    assert(skill, 'default inventory did not include global skill');
    const loaded = await client.request('tools/call', {
      name: 'load_skill',
      arguments: { workspace_id: opened.structuredContent.workspace_id, name: skill.name, source: skill.source, path: skill.path }
    });
    assert(loaded.structuredContent.text.includes('# Global Only Skill'), 'default load_skill did not load inventory global skill');
    const loadedByName = await client.request('tools/call', {
      name: 'load_skill',
      arguments: { workspace_id: opened.structuredContent.workspace_id, name }
    });
    assert(loadedByName.structuredContent.text.includes('# Global Only Skill'), 'load_skill did not load unique user skill by name');
  } finally {
    client?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runRedactionStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-redact-'));
  const ngrokToken = '2redactDEFghiJKLmnopQRSTuvWXyz_1234567890';
  const cloudflareToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ0dW5uZWwiOiJzdHJlc3MifQ.signature1234567890';
  const tokenFile = '/Users/rebel/.codexpro/cloudflare-tunnel-token';
  await fs.writeFile(path.join(root, 'tokens.txt'), [
    `ngrok config add-authtoken ${ngrokToken}`,
    `cloudflared tunnel run --token ${cloudflareToken}`,
    `cloudflared tunnel run --token-file ${tokenFile}`
  ].join('\n'), 'utf8');

  const client = await initClient(root);
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    for (const request of [
      { name: 'read', arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'tokens.txt' } },
      { name: 'codexpro', arguments: { action: 'read', args: { workspace_id: opened.structuredContent.workspace_id, path: 'tokens.txt' } } }
    ]) {
      const result = await client.request('tools/call', request);
      const payload = JSON.stringify(result);
      assert(!payload.includes(ngrokToken), 'read leaked ngrok authtoken');
      assert(!payload.includes(cloudflareToken), 'read leaked cloudflared token');
      assert(payload.includes(tokenFile), 'redaction hid non-secret token-file path');
    }
  } finally {
    client.close();
  }
}

async function runMcpInventoryStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-mcp-root-'));
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-mcp-home-'));
  await fs.mkdir(path.join(fakeHome, '.codex'), { recursive: true });
  await fs.mkdir(path.join(fakeHome, '.cursor'), { recursive: true });
  const toml = Array.from({ length: 80 }, (_, i) =>
    `[mcp_servers.codex_${String(i).padStart(3, '0')}]\ncommand = "secret-command"\nargs = ["secret-arg"]\n`
  ).join('\n');
  const cursorServers = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [
    `cursor_${String(i).padStart(3, '0')}`,
    { command: 'secret-command', args: ['secret-arg'] }
  ]));
  await fs.writeFile(path.join(fakeHome, '.codex', 'config.toml'), toml, 'utf8');
  await fs.writeFile(path.join(fakeHome, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: cursorServers }), 'utf8');

  const client = await initClient(root, { HOME: fakeHome });
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const inventory = await client.request('tools/call', {
      name: 'codexpro_inventory',
      arguments: { workspace_id: opened.structuredContent.workspace_id, include_global_skills: false, include_mcp_servers: true }
    });
    const superInventory = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'inventory', args: { workspace_id: opened.structuredContent.workspace_id, include_global_skills: false, include_mcp_servers: true } }
    });
    assert(inventory.structuredContent.mcp_server_count === 120, `MCP inventory was not capped: ${inventory.structuredContent.mcp_server_count}`);
    assert(superInventory.structuredContent.codexpro_tool === 'codexpro_inventory' && superInventory.structuredContent.mcp_server_count === 120, 'supertool MCP inventory was not capped');
    const payload = JSON.stringify([inventory, superInventory]);
    for (const leaked of [fakeHome, '~/.codex', '~/.cursor', '.cursor/mcp.json', '.codex/config.toml', 'secret-command', 'secret-arg']) {
      assert(!payload.includes(leaked), `MCP inventory leaked ${leaked}`);
    }
  } finally {
    client.close();
  }
}

async function runSupertoolModeStress(root) {
  const client = await initClient(root, {
    CODEXPRO_TOOL_MODE: 'minimal',
    CODEXPRO_BASH_MODE: 'off'
  });
  try {
    const tools = await client.request('tools/list', {});
    const names = tools.tools.map((tool) => tool.name);
    assert(names.includes('codexpro'), 'minimal mode missing codexpro supertool');
    assert(!names.includes('bash'), 'minimal no-bash mode exposed bash');
    assert(!names.includes('search'), 'minimal mode exposed search');

    const actions = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'list_actions' } });
    assert(actions.structuredContent.actions.includes('read'), 'minimal supertool actions missing read');
    assert(!actions.structuredContent.actions.includes('bash'), 'minimal no-bash supertool actions exposed bash');
    assert(!actions.structuredContent.actions.includes('search'), 'minimal supertool actions exposed search');

    const opened = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'open', args: { include_tree: false } }
    });
    const read = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'read', args: { workspace_id: opened.structuredContent.workspace_id, path: 'demo.txt', start_line: 1, end_line: 2 } }
    });
    assert(read.structuredContent.codexpro_tool === 'read' && read.structuredContent.wrapped_tool === 'read' && read.structuredContent.text.includes('alpha'), 'minimal supertool read failed');

    const blockedSearch = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'search', args: { workspace_id: opened.structuredContent.workspace_id, query: 'alpha' } }
    });
    assert(blockedSearch.isError === true && String(blockedSearch.structuredContent.error).includes('not available'), 'supertool allowed disabled search action');

    const missingRead = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'read', args: { workspace_id: opened.structuredContent.workspace_id, path: 'missing.txt' } }
    });
    assert(missingRead.isError === true && missingRead.structuredContent.codexpro_tool === 'read' && missingRead.structuredContent.wrapped_tool === 'read', 'supertool failed read was not tagged as read');

    const malformedRead = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'read', args: { workspace_id: opened.structuredContent.workspace_id, path: ['demo.txt'] } }
    });
    const malformedReadError = String(malformedRead.structuredContent.error ?? '');
    assert(malformedRead.isError === true && malformedRead.structuredContent.codexpro_tool === 'read' && malformedRead.structuredContent.wrapped_tool === 'read', 'supertool malformed read was not tagged as read');
    assert(malformedReadError.includes('Invalid arguments for read') && !malformedReadError.includes('TypeError'), `supertool malformed read leaked raw handler error: ${malformedReadError}`);

    const blockedBash = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'bash', args: { workspace_id: opened.structuredContent.workspace_id, command: 'pwd' } }
    });
    assert(blockedBash.isError === true && String(blockedBash.structuredContent.error).includes('not available'), 'supertool allowed disabled bash action');
  } finally {
    client.close();
  }
}

async function runMaxReadSearchStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-max-read-'));
  await fs.writeFile(path.join(root, 'large.txt'), `needle in large file\n${'x'.repeat(5000)}\n`, 'utf8');
  const client = await initClient(root, { CODEXPRO_MAX_READ_BYTES: '1000' });
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const search = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: opened.structuredContent.workspace_id, query: 'needle in large file', max_results: 10 }
    });
    assert(search.structuredContent.matches.length === 0, `search ignored maxReadBytes: ${JSON.stringify(search.structuredContent.matches)}`);
  } finally {
    client.close();
  }
}

async function runNodeFallbackSearchLimitStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-node-search-'));
  await fs.writeFile(path.join(root, 'exact.txt'), 'needle one\nneedle two\n', 'utf8');
  await fs.writeFile(path.join(root, 'overflow.txt'), 'needle one\nneedle two\nneedle three\n', 'utf8');
  const client = await initClient(root, { PATH: '/usr/bin:/bin' });
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const exact = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: opened.structuredContent.workspace_id, query: 'needle', path: 'exact.txt', max_results: 2 }
    });
    assert(exact.structuredContent.used === 'node', `expected node fallback, got ${exact.structuredContent.used}`);
    assert(exact.structuredContent.matches.length === 2, `node fallback exact-limit search returned ${exact.structuredContent.matches.length} matches`);
    assert(exact.structuredContent.truncated === false, `node fallback exact-limit search was incorrectly truncated: ${JSON.stringify(exact.structuredContent)}`);

    const overflow = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: opened.structuredContent.workspace_id, query: 'needle', path: 'overflow.txt', max_results: 2 }
    });
    assert(overflow.structuredContent.matches.length === 2 && overflow.structuredContent.truncated === true, `node fallback overflow search did not report truncation: ${JSON.stringify(overflow.structuredContent)}`);
  } finally {
    client.close();
  }
}

async function runGuardEdgeStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-guard-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-outside-'));
  await fs.writeFile(path.join(root, 'visible.txt'), 'needle visible\n', 'utf8');
  await fs.writeFile(path.join(root, 'late-null.txt'), Buffer.concat([
    Buffer.from('needle before\n'),
    Buffer.alloc(5000, 65),
    Buffer.from([0]),
    Buffer.from('\nneedle after\n')
  ]));
  await fs.mkdir(path.join(root, '.env'), { recursive: true });
  await fs.writeFile(path.join(root, '.env', 'secret.txt'), 'needle blocked env\n', 'utf8');
  await fs.mkdir(path.join(outside, 'outside-dir'), { recursive: true });
  await fs.writeFile(path.join(outside, 'outside-dir', 'secret.txt'), 'needle outside\n', 'utf8');

  let outsideDirLink;
  let aliasRoot;
  try {
    outsideDirLink = path.join(root, 'outside-dir-link');
    await fs.symlink(path.join(outside, 'outside-dir'), outsideDirLink, 'dir');
    aliasRoot = path.join(outside, 'workspace-alias');
    await fs.symlink(root, aliasRoot, 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    outsideDirLink = undefined;
    aliasRoot = undefined;
  }

  const client = await initClient(root);
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const ws = opened.structuredContent.workspace_id;

    await expectToolError(client, 'read', { workspace_id: ws, path: 'late-null.txt' }, /binary/i);
    await expectToolError(client, 'edit', { workspace_id: ws, path: 'late-null.txt', old_text: 'needle before', new_text: 'changed' }, /binary/i);

    const blockedSearch = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: ws, query: 'needle blocked env', glob: '.env/**', include_hidden: true, max_results: 10 }
    });
    assert(blockedSearch.structuredContent.matches.length === 0, `blocked search glob leaked matches: ${JSON.stringify(blockedSearch.structuredContent.matches)}`);
    assert(blockedSearch.structuredContent.truncated === false, `blocked-only search reported truncation: ${JSON.stringify(blockedSearch.structuredContent)}`);

    if (outsideDirLink) {
      await expectToolError(client, 'tree', { workspace_id: ws, path: 'outside-dir-link', include_hidden: true }, /symlink|outside/i);
      await expectToolError(client, 'search', { workspace_id: ws, query: 'needle outside', path: 'outside-dir-link', include_hidden: true }, /symlink|outside/i);
      await expectToolError(client, 'read', { workspace_id: ws, path: 'outside-dir-link/secret.txt' }, /symlink|outside/i);
    }

    if (aliasRoot) {
      const aliasVisible = path.join(aliasRoot, 'visible.txt');
      const aliasRead = await client.request('tools/call', { name: 'read', arguments: { workspace_id: ws, path: aliasVisible } });
      assert(aliasRead.isError !== true && aliasRead.structuredContent.path === 'visible.txt', `absolute realpath-inside read failed: ${JSON.stringify(aliasRead.structuredContent)}`);
      const aliasSearch = await client.request('tools/call', { name: 'search', arguments: { workspace_id: ws, query: 'needle visible', path: aliasVisible, max_results: 10 } });
      assert(aliasSearch.structuredContent.matches.some((match) => match.path === 'visible.txt'), `absolute realpath-inside search failed: ${JSON.stringify(aliasSearch.structuredContent)}`);
      await expectToolError(client, 'write', { workspace_id: ws, path: path.join(aliasRoot, '.env', 'created.txt'), content: 'blocked\n' }, /blocked/i);
      assert(!(await pathExists(path.join(root, '.env', 'created.txt'))), 'absolute alias write created a blocked file');
    }
  } finally {
    client.close();
  }
}

async function runShowChangesStatsStress() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-git-'));
  await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\n', 'utf8');
  await fs.writeFile(path.join(root, 'other.txt'), 'one\n', 'utf8');
  await fs.writeFile(path.join(root, 'staged file.txt'), 'one\n', 'utf8');
  spawnSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'stress@example.com'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Stress Test'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', 'demo.txt'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', 'other.txt'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['add', 'staged file.txt'], { cwd: root, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  await fs.appendFile(path.join(root, 'demo.txt'), 'beta\n', 'utf8');
  await fs.appendFile(path.join(root, 'other.txt'), 'two\n', 'utf8');
  await fs.appendFile(path.join(root, 'staged file.txt'), 'two\n', 'utf8');
  spawnSync('git', ['add', 'staged file.txt'], { cwd: root, stdio: 'ignore' });
  const client = await initClient(root);
  try {
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const scopedStatus = await client.request('tools/call', {
      name: 'git_status',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'demo.txt' }
    });
    assert(scopedStatus.structuredContent.changed_files.length === 1 && scopedStatus.structuredContent.changed_files[0].includes('demo.txt'), `git_status path leaked unrelated files: ${JSON.stringify(scopedStatus.structuredContent.changed_files)}`);
    const superScopedStatus = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'git_status', args: { workspace_id: opened.structuredContent.workspace_id, path: 'demo.txt' } }
    });
    assert(superScopedStatus.structuredContent.codexpro_tool === 'git_status' && superScopedStatus.structuredContent.changed_files.length === 1 && superScopedStatus.structuredContent.changed_files[0].includes('demo.txt'), `supertool git_status path leaked unrelated files: ${JSON.stringify(superScopedStatus.structuredContent.changed_files)}`);
    const changes = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'demo.txt', include_diff: false }
    });
    assert(changes.structuredContent.additions === 1 && changes.structuredContent.deletions === 0 && changes.structuredContent.diff === '', `show_changes include_diff=false lost stats: ${JSON.stringify(changes.structuredContent)}`);
    const fullChanges = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: './demo.txt' }
    });
    assert(fullChanges.structuredContent.changed && fullChanges.structuredContent.diff.includes('demo.txt') && fullChanges.structuredContent.review_checkpoint_hit !== true, `show_changes include_diff=false consumed full diff: ${JSON.stringify(fullChanges.structuredContent)}`);
    const statsOnlyAfterCheckpoint = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'demo.txt', include_diff: false }
    });
    assert(statsOnlyAfterCheckpoint.structuredContent.changed && statsOnlyAfterCheckpoint.structuredContent.additions === 1 && statsOnlyAfterCheckpoint.structuredContent.diff === '', `show_changes include_diff=false lost stats after checkpoint: ${JSON.stringify(statsOnlyAfterCheckpoint.structuredContent)}`);
    assert(statsOnlyAfterCheckpoint.structuredContent.review_marked === false, `show_changes include_diff=false claimed checkpoint was marked: ${JSON.stringify(statsOnlyAfterCheckpoint.structuredContent)}`);
    const stagedDiff = await client.request('tools/call', {
      name: 'git_diff',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'staged file.txt', staged: true, include_diff: false }
    });
    assert(stagedDiff.structuredContent.additions === 1 && stagedDiff.structuredContent.deletions === 0 && stagedDiff.structuredContent.diff === '', `git_diff staged path stats failed: ${JSON.stringify(stagedDiff.structuredContent)}`);
    const stagedChanges = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, staged: true }
    });
    assert(stagedChanges.structuredContent.changed && stagedChanges.structuredContent.diff.includes('staged file.txt') && !stagedChanges.structuredContent.diff.includes('demo.txt'), `show_changes staged review mixed unstaged files: ${JSON.stringify(stagedChanges.structuredContent)}`);
    const defaultStagedPathChanges = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'staged file.txt' }
    });
    assert(!defaultStagedPathChanges.structuredContent.changed && defaultStagedPathChanges.structuredContent.additions === 0 && defaultStagedPathChanges.structuredContent.diff === '', `default show_changes reported staged-only changes: ${JSON.stringify(defaultStagedPathChanges.structuredContent)}`);
    await fs.writeFile(path.join(root, 'new-review.txt'), 'new file\n', 'utf8');
    const untrackedChanges = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'new-review.txt' }
    });
    assert(untrackedChanges.structuredContent.changed && untrackedChanges.structuredContent.changed_files.some((line) => line.includes('new-review.txt')), `show_changes did not report untracked new file: ${JSON.stringify(untrackedChanges.structuredContent)}`);
    await fs.writeFile(path.join(root, 'new-review.txt'), 'new file changed\n', 'utf8');
    const changedUntrackedChanges = await client.request('tools/call', {
      name: 'show_changes',
      arguments: { workspace_id: opened.structuredContent.workspace_id, path: 'new-review.txt' }
    });
    assert(changedUntrackedChanges.structuredContent.changed && changedUntrackedChanges.structuredContent.review_checkpoint_hit !== true, `show_changes checkpoint hid changed untracked file content: ${JSON.stringify(changedUntrackedChanges.structuredContent)}`);
  } finally {
    client.close();
  }
}

async function runMinimalHandoffStress(root) {
  const client = await initClient(root, {
    CODEXPRO_TOOL_MODE: 'minimal',
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'handoff'
  });
  try {
    const tools = await client.request('tools/list', {});
    const names = tools.tools.map((tool) => tool.name);
    assert(names.includes('handoff_to_agent'), 'minimal handoff mode missing handoff_to_agent');
    assert(!names.includes('write') && !names.includes('edit') && !names.includes('apply_patch'), 'minimal handoff mode exposed write/edit/apply_patch');
    const actions = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'list_actions' } });
    assert(actions.structuredContent.actions.includes('handoff_to_agent'), 'minimal handoff supertool actions missing handoff_to_agent');
    assert(!actions.structuredContent.actions.includes('write') && !actions.structuredContent.actions.includes('edit') && !actions.structuredContent.actions.includes('apply_patch'), 'minimal handoff supertool actions exposed write/edit/apply_patch');
    const handoff = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'agent_handoff', args: { title: 'Stress Plan', plan: '- keep it narrow' } }
    });
    assert(handoff.structuredContent.codexpro_tool === 'handoff_to_agent' && handoff.structuredContent.wrapped_tool === 'handoff_to_agent', 'minimal handoff supertool did not write plan');
    const blockedWrite = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'write', args: { path: 'demo.txt', content: 'bypass\n' } }
    });
    assert(blockedWrite.isError === true && String(blockedWrite.structuredContent.error).includes('not available'), 'minimal handoff supertool allowed disabled write');
  } finally {
    client.close();
  }
}

async function runCardStress(root) {
  const client = await initClient(root, { CODEXPRO_TOOL_CARDS: '1' });
  try {
    await client.request('tools/list', {});
    const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    const search = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: opened.structuredContent.workspace_id, query: '--flag', path: 'many', max_results: 10 }
    });
    assert(typeof search.structuredContent.text === 'string' && search.structuredContent.text.includes('--flag'), 'tool-card search did not include structured text');
  } finally {
    client.close();
  }
}

const root = await makeFixture();
await runFullModeStress(root);
await runGlobalSkillStress(root);
await runRedactionStress();
await runMcpInventoryStress();
await runMaxReadSearchStress();
await runNodeFallbackSearchLimitStress();
await runGuardEdgeStress();
await runSupertoolModeStress(root);
await runShowChangesStatsStress();
await runMinimalHandoffStress(root);
await runCardStress(root);
console.log(`✓ stress test passed (${root})`);
