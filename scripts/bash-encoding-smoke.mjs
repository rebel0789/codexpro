import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { PathGuard } from '../dist/guard.js';
import { decodeBashOutput, resolveBashInvocation, runBash } from '../dist/bashOps.js';

function mustNotDetect() {
  throw new Error('encoding detection must not run');
}

const ascii = Buffer.from('plain ASCII output');
const utf8 = Buffer.from('UTF-8 中文输出');
assert.equal(decodeBashOutput(ascii, 'win32', false, mustNotDetect), 'plain ASCII output');
assert.equal(decodeBashOutput(utf8, 'win32', false, mustNotDetect), 'UTF-8 中文输出');

const gb18030Text = 'Windows GB18030 中文编码检测，重复内容用于提高置信度。'.repeat(8);
const gb18030 = iconv.encode(gb18030Text, 'gb18030');
assert.equal(decodeBashOutput(gb18030, 'win32'), gb18030Text, 'real chardet GB18030 decode failed');
const gbkText = 'Windows GBK 中文编码检测，重复内容用于提高置信度。'.repeat(8);
const gbk = iconv.encode(gbkText, 'gbk');
assert.equal(decodeBashOutput(gbk, 'win32'), gbkText, 'real chardet GBK decode failed');
const shortGbk = iconv.encode('GBK stdout 中文', 'gbk');
assert.equal(decodeBashOutput(shortGbk, 'win32'), 'GBK stdout 中文', 'short Windows GBK output was not decoded');

const legacy = Buffer.from([0x80]);
assert.equal(decodeBashOutput(Buffer.from([0xff, 0xfe, 0x65, 0x00, 0x72, 0x00, 0x72, 0x00, 0x6f, 0x00, 0x72, 0x00]), 'win32'), 'error', 'UTF-16LE BOM output was not decoded');
assert.equal(decodeBashOutput(Buffer.from([0x65, 0x00, 0x72, 0x00, 0x72, 0x00, 0x6f, 0x00, 0x72, 0x00]), 'win32'), 'error', 'UTF-16LE output was not decoded');
assert.equal(
  decodeBashOutput(legacy, 'win32', false, () => [{ name: 'windows-1252', confidence: 80 }]),
  '€',
  'high-confidence supported encoding was not accepted'
);
assert.equal(
  decodeBashOutput(legacy, 'win32', false, () => [{ name: 'windows-1252', confidence: 79 }]),
  legacy.toString('utf8'),
  'low-confidence encoding did not fall back to UTF-8'
);
assert.equal(
  decodeBashOutput(legacy, 'win32', false, () => [{ name: 'not-a-real-encoding', confidence: 100 }]),
  legacy.toString('utf8'),
  'unsupported encoding did not fall back to UTF-8'
);
assert.equal(decodeBashOutput(legacy, 'win32', false, () => []), legacy.toString('utf8'), 'empty detection did not fall back');
assert.equal(
  decodeBashOutput(legacy, 'win32', false, () => { throw new Error('detector failure'); }),
  legacy.toString('utf8'),
  'detector failure did not fall back'
);
assert.equal(decodeBashOutput(legacy, 'linux', false, mustNotDetect), legacy.toString('utf8'), 'non-Windows invoked detection');
assert.equal(decodeBashOutput(Buffer.alloc(0), 'win32', false, mustNotDetect), '', 'empty output invoked detection');
assert.equal(
  decodeBashOutput(Buffer.concat([Buffer.from('split '), Buffer.from('中文')]), 'win32', false, mustNotDetect),
  'split 中文',
  'multi-byte UTF-8 output was not decoded correctly'
);
assert.equal(
  decodeBashOutput(Buffer.from([0xe4, 0xb8]), 'win32', true, mustNotDetect),
  '�',
  'truncated UTF-8 tail did not retain fallback behavior'
);

const resolverBase = { bashMode: 'full', maxBashTimeoutMs: 10_000, maxOutputBytes: 100_000, inheritEnv: true, blockedGlobs: [] };
const fakeNativeBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const nativeInvocation = resolveBashInvocation(
  { ...resolverBase, bashRuntime: 'auto' },
  {
    platform: 'win32',
    env: { ProgramW6432: 'C:\\Program Files' },
    exists: (candidate) => candidate === fakeNativeBash,
    pathCommands: () => []
  }
);
assert.equal(nativeInvocation.runtime, 'native-bash', 'auto did not select native Git Bash');
assert.equal(nativeInvocation.executable, fakeNativeBash);
assert.throws(
  () => resolveBashInvocation({ ...resolverBase, bashRuntime: 'auto', bashExecutable: 'C:\\Windows\\System32\\bash.exe' }, { platform: 'win32', exists: () => true }),
  /WSL launcher/,
  'auto accepted the WSL launcher silently'
);
const wslInvocation = resolveBashInvocation(
  { ...resolverBase, bashRuntime: 'wsl' },
  { platform: 'win32', pathCommands: () => ['C:\\Windows\\System32\\wsl.exe'] }
);
assert.equal(wslInvocation.runtime, 'wsl');
assert.deepEqual(wslInvocation.args('printf ok'), ['--exec', 'bash', '-lc', 'printf ok']);

if (process.platform === 'win32') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codexpro-bash-encoding-')));
  const config = { bashMode: 'full', maxBashTimeoutMs: 10_000, maxOutputBytes: 100_000, inheritEnv: true, blockedGlobs: [] };
  const workspace = { id: 'encoding-smoke', root, openedAt: new Date().toISOString() };
  const gbkPayload = iconv.encode('GBK stdout 中文', 'gbk').toString('base64');
  const childScript = [
    `process.stdout.write(Buffer.from(${JSON.stringify(gbkPayload)}, 'base64'));`,
    "process.stderr.write('UTF-8 stderr 中文');"
  ].join('');
  const result = await runBash(config, new PathGuard(config), workspace, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`);
  assert.equal(result.stdout, 'GBK stdout 中文', `Windows stdout decoding failed: ${JSON.stringify(result)}`);
  assert.equal(result.stderr, 'UTF-8 stderr 中文', `Windows stderr decoding failed: ${JSON.stringify(result)}`);
}

console.log('bash encoding smoke passed');
