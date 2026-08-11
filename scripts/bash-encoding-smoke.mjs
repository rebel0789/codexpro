import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { PathGuard } from '../dist/guard.js';
import { decodeBashOutput, runBash } from '../dist/bashOps.js';

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

const legacy = Buffer.from([0x80]);
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
  'combined multi-byte chunks were not decoded as UTF-8'
);
assert.equal(
  decodeBashOutput(Buffer.from([0xe4, 0xb8]), 'win32', true, mustNotDetect),
  '�',
  'truncated UTF-8 tail did not retain UTF-8 fallback behavior'
);

if (process.platform === 'win32') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codexpro-bash-encoding-'));
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
