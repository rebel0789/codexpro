import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

class McpStdioClient {
  constructor(root, env = {}) {
    this.child = spawn('node', ['dist/stdio.js'], {
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

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-stress-'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Stress Agents\n\nKeep checks local.\n', 'utf8');
  await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\n--flag root\narrow -> value\n', 'utf8');
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

    const largeSearch = await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: ws, query: '--flag', path: 'many', max_results: 2000 }
    });
    assert(largeSearch.structuredContent.matches.length === 2000, `expected 2000 search matches, got ${largeSearch.structuredContent.matches.length}`);
    assert(largeSearch.structuredContent.truncated === true, 'large search did not report truncation');
    assert(!('text' in largeSearch.structuredContent), 'search duplicated text in structuredContent with cards off');

    const superRead = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'read', args: { workspace_id: ws, path: 'demo.txt', start_line: 1, end_line: 3 } }
    });
    assert(superRead.structuredContent.wrapped_tool === 'read' && superRead.structuredContent.text.includes('--flag root'), 'supertool read failed');

    const superSearch = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'search', args: { workspace_id: ws, query: 'stress-needle-3', path: 'many', max_results: 20 } }
    });
    assert(superSearch.structuredContent.wrapped_tool === 'search', 'supertool search did not report wrapped tool');
    assert(superSearch.structuredContent.matches.length === 20, `supertool search returned ${superSearch.structuredContent.matches.length} matches`);

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
    assert(superWait.structuredContent.wrapped_tool === 'wait_for_handoff' && superWait.structuredContent.succeeded === true, 'supertool handoff_poll failed');

    const mismatch = await client.request('tools/call', {
      name: 'wait_for_handoff',
      arguments: { workspace_id: ws, plan_hash: 'wrong-plan', max_wait_seconds: 1, poll_ms: 250 }
    });
    assert(mismatch.structuredContent.awaited_completed === false && mismatch.structuredContent.plan_hash_mismatch === true, 'wait_for_handoff mismatch did not fail closed');

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
    assert(superExport.structuredContent.wrapped_tool === 'export_pro_context', 'supertool pro_export did not wrap export_pro_context');
    assert(superExport.structuredContent.files_included.length === 1 && superExport.structuredContent.files_included[0] === 'demo.txt', `supertool Pro export included wrong files: ${JSON.stringify(superExport.structuredContent.files_included)}`);

    const selfTest = await client.request('tools/call', { name: 'codexpro_self_test', arguments: { workspace_id: ws } });
    assert(selfTest.structuredContent.status !== 'fail', `codexpro_self_test failed: ${JSON.stringify(selfTest.structuredContent.checks)}`);
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
    assert(read.structuredContent.wrapped_tool === 'read' && read.structuredContent.text.includes('alpha'), 'minimal supertool read failed');

    const blockedSearch = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'search', args: { workspace_id: opened.structuredContent.workspace_id, query: 'alpha' } }
    });
    assert(blockedSearch.isError === true && String(blockedSearch.structuredContent.error).includes('not available'), 'supertool allowed disabled search action');

    const blockedBash = await client.request('tools/call', {
      name: 'codexpro',
      arguments: { action: 'bash', args: { workspace_id: opened.structuredContent.workspace_id, command: 'pwd' } }
    });
    assert(blockedBash.isError === true && String(blockedBash.structuredContent.error).includes('not available'), 'supertool allowed disabled bash action');
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
await runSupertoolModeStress(root);
await runCardStress(root);
console.log(`✓ stress test passed (${root})`);
