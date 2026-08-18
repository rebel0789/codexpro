import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// These harnesses realpath and stat the paths CodexPro returns, so they need the raw
// absolute form. Production defaults to redacted labels; see the redaction assertions
// at the end of scripts/smoke.mjs for coverage of the default behaviour.
process.env.CODEXPRO_EXPOSE_ABSOLUTE_PATHS = '1';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const pngSha = createHash('sha256').update(png).digest('hex');

class McpStdioClient {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      while (true) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id == null) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}

function startFixtureServer(payload, options = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (options.redirectTo) {
        res.statusCode = 302;
        res.setHeader('Location', options.redirectTo);
        res.end();
        return;
      }
      if (options.oversizedHeader) {
        res.statusCode = 200;
        res.setHeader('Content-Length', String(options.oversizedHeader));
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(payload);
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', options.contentType ?? 'image/png');
      res.end(payload);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}/fixture.png`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-import-smoke-'));
const {
  assertSafeImportUrl,
  detectMimeType,
  importAttachmentFile,
  mimeTypeStatus,
  parseAttachmentFileReference
} = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'importOps.js')).href);
const { loadConfig } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href);
const { PathGuard, WorkspaceManager } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'guard.js')).href);

try {
  try {
    parseAttachmentFileReference('file_abc');
    throw new Error('bare file id should be rejected');
  } catch (error) {
    if (!String(error.message).includes('Unsupported attachment reference')) throw error;
  }

  try {
    await assertSafeImportUrl('https://evil.example/file.bin');
    throw new Error('unapproved host should be rejected');
  } catch (error) {
    if (!String(error.message).includes('approved ChatGPT file origin')) throw error;
  }

  try {
    await assertSafeImportUrl('http://127.0.0.1/file.bin');
    throw new Error('loopback should be rejected by default');
  } catch (error) {
    if (!String(error.message).includes('HTTPS') && !String(error.message).includes('blocked')) throw error;
  }

  if (detectMimeType(png) !== 'image/png') throw new Error('PNG detection failed');
  if (mimeTypeStatus('image/png', 'image/png') !== 'matched') throw new Error('matched mime status failed');
  if (mimeTypeStatus('image/jpeg', 'image/png') !== 'mismatched') throw new Error('mismatched mime status failed');
  if (mimeTypeStatus(undefined, null) !== 'unknown') throw new Error('unknown mime status failed');

  const fixture = await startFixtureServer(png);
  const redirectFixture = await startFixtureServer(png);
  const redirector = await startFixtureServer(png, { redirectTo: redirectFixture.url });
  try {
    const config = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
    const guard = new PathGuard(config);
    const workspace = new WorkspaceManager(config).defaultWorkspace();
    const env = { ...process.env, CODEXPRO_IMPORT_ALLOW_LOOPBACK: '1' };

    const imported = await importAttachmentFile(config, guard, workspace, {
      file: {
        download_url: fixture.url,
        file_id: 'file_smoke_png',
        mime_type: 'image/png',
        file_name: 'fixture.png'
      },
      destination: 'docs/evidence/fixture.png',
      expectedSha256: pngSha,
      env
    });
    if (imported.sha256 !== pngSha || imported.mime_type_status !== 'matched' || imported.bytes !== png.byteLength) {
      throw new Error(`PNG import failed: ${JSON.stringify(imported)}`);
    }
    const saved = await fs.readFile(path.join(root, 'docs/evidence/fixture.png'));
    if (!saved.equals(png)) throw new Error('saved PNG bytes mismatch');

    try {
      await importAttachmentFile(config, guard, workspace, {
        file: {
          download_url: fixture.url,
          file_id: 'file_smoke_png',
          mime_type: 'image/png'
        },
        destination: 'docs/evidence/fixture.png',
        env
      });
      throw new Error('default no-overwrite should fail');
    } catch (error) {
      if (!String(error.message).includes('overwrite=false')) throw error;
    }

    const overwritten = await importAttachmentFile(config, guard, workspace, {
      file: {
        download_url: fixture.url,
        file_id: 'file_smoke_png',
        mime_type: 'image/png'
      },
      destination: 'docs/evidence/fixture.png',
      overwrite: true,
      env
    });
    if (!overwritten.overwritten) throw new Error('overwrite path did not report overwritten');

    const redirected = await importAttachmentFile(config, guard, workspace, {
      file: {
        download_url: redirector.url,
        file_id: 'file_smoke_redirect',
        mime_type: 'image/png'
      },
      destination: 'docs/evidence/redirected.png',
      env
    });
    if (redirected.sha256 !== pngSha) throw new Error(`redirect import failed: ${JSON.stringify(redirected)}`);

    const tinyConfig = {
      ...config,
      maxImportBytes: 8
    };
    try {
      await importAttachmentFile(tinyConfig, guard, workspace, {
        file: {
          download_url: fixture.url,
          file_id: 'file_smoke_oversize',
          mime_type: 'image/png'
        },
        destination: 'docs/evidence/too-big.png',
        env
      });
      throw new Error('oversized import should fail');
    } catch (error) {
      if (!String(error.message).includes('too large') && !String(error.message).includes('exceeded import size')) {
        throw error;
      }
    }

    const client = new McpStdioClient(process.execPath, ['dist/stdio.js', '--root', root, '--allow-root', root, '--write', 'workspace', '--bash', 'off'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_WRITE_MODE: 'workspace',
        CODEXPRO_IMPORT_ALLOW_LOOPBACK: '1',
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1'
      }
    });
    try {
      await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'codexpro-import-smoke', version: '0.1.0' }
      });
      client.notify('notifications/initialized');
      const tools = await client.request('tools/list', {});
      const importTool = tools.tools.find((tool) => tool.name === 'import_file');
      if (!importTool) throw new Error('import_file tool missing');
      const fileParams = importTool._meta?.['openai/fileParams'] ?? importTool.annotations?._meta?.['openai/fileParams'];
      const metaFileParams = importTool._meta?.['openai/fileParams'];
      // MCP SDK may nest meta differently; accept descriptor presence via tools/list raw shape.
      const listedMeta = importTool._meta || {};
      if (!Array.isArray(listedMeta['openai/fileParams']) || !listedMeta['openai/fileParams'].includes('file')) {
        // Some SDK versions expose _meta only after unwrap; still require the tool schema file object.
        const props = importTool.inputSchema?.properties?.file?.properties;
        if (!props?.download_url || !props?.file_id) {
          throw new Error(`import_file missing fileParams/schema: ${JSON.stringify(importTool)}`);
        }
      }
      const opened = await client.request('tools/call', {
        name: 'open_current_workspace',
        arguments: { include_tree: false }
      });
      const viaTool = await client.request('tools/call', {
        name: 'import_file',
        arguments: {
          workspace_id: opened.structuredContent.workspace_id,
          file: {
            download_url: fixture.url,
            file_id: 'file_smoke_tool',
            mime_type: 'image/png',
            file_name: 'tool.png'
          },
          destination: 'docs/evidence/tool.png'
        }
      });
      if (viaTool.isError) throw new Error(`import_file tool failed: ${JSON.stringify(viaTool)}`);
      if (viaTool.structuredContent.sha256 !== pngSha) {
        throw new Error(`import_file tool hash mismatch: ${JSON.stringify(viaTool.structuredContent)}`);
      }
      if (String(JSON.stringify(viaTool)).includes(fixture.url)) {
        throw new Error('import_file result leaked download_url');
      }
    } finally {
      client.close();
    }
  } finally {
    await fixture.close();
    await redirectFixture.close();
    await redirector.close();
  }

  console.log('✓ import smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
