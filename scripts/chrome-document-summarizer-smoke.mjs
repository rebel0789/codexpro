#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import {
  CHROME_DOCUMENT_LIMITS,
  splitUtf8Document,
  summarizeDocumentWithChrome2Api
} from '../dist/chromeDocumentSummarizer.js';

let calls = 0;
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls += 1;
  const fingerprint = createHash('sha256').update(body.messages.at(-1).content).digest('hex').slice(0, 20);
  const content = `candidate-${fingerprint}-${'x'.repeat(8000)}`;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: `dynamic-${Date.now()}-${calls}`,
    created: Date.now(),
    model: 'chrome-gemini-nano',
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
assert.ok(address && typeof address === 'object');
const env = { CODEXPRO_CHROME2API_URL: `http://127.0.0.1:${address.port}/v1` };

try {
  const source = [
    '# Architecture\n\n',
    'UTF-8 boundary: नमस्ते 日本語 é 🚀.\n\n',
    ...Array.from({ length: 2400 }, (_, index) => `## Section ${index}\nParagraph ${index} preserves a source boundary and deterministic identity.\n\n`)
  ].join('');
  const chunks = splitUtf8Document(source, 12_000);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.length <= CHROME_DOCUMENT_LIMITS.maxChunks);
  assert.equal(chunks[0].startByte, 0);
  assert.equal(chunks.at(-1).endByte, Buffer.byteLength(source, 'utf8'));
  for (let index = 1; index < chunks.length; index += 1) assert.equal(chunks[index - 1].endByte, chunks[index].startByte);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), source);

  const beforeSingle = calls;
  const single = await summarizeDocumentWithChrome2Api({
    text: 'One short source must not be summarized twice.',
    documentId: 'single.md',
    type: 'headline',
    timeoutMs: 5000
  }, env);
  assert.equal(calls - beforeSingle, 1, 'single-chunk documents must use one final summarization call');
  assert.equal(single.map_receipt_roots.length, 0);
  assert.equal(single.reduction_depth, 0);

  const input = {
    text: source,
    documentId: 'ChatGPT-Chrome AI MCP Architecture.md',
    chunkBytes: 12_000,
    type: 'key-points',
    format: 'markdown',
    length: 'long',
    preference: 'speed',
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
    timeoutMs: 5000
  };
  const first = await summarizeDocumentWithChrome2Api(input, env);
  const callsBeforeReplay = calls;
  const replay = await summarizeDocumentWithChrome2Api(input, env);
  assert.equal(first.schema, 'codexpro.chrome-document-summary.receipt.v1');
  assert.equal(first.authority_ceiling, 'CANDIDATE_ONLY');
  assert.equal(first.native_browser_api, false);
  assert.equal(first.source_chunks.length, chunks.length);
  assert.equal(first.map_receipt_roots.length, chunks.length);
  assert.ok(first.reduction_receipt_roots.length > 0, 'large intermediate candidates must exercise bounded reduction');
  assert.ok(first.reduction_depth > 0);
  assert.equal(first.receipt_root, replay.receipt_root, 'dynamic provider metadata must not alter semantic identity');
  assert.equal(replay.cache.provider_calls, 0, 'unchanged document summaries must reuse cached provider outputs');
  assert.equal(calls, callsBeforeReplay);
  assert.match(first.receipt_root, /^[a-f0-9]{64}$/);
  assert.equal(first.final.options.type, 'key-points');
  assert.equal(first.final.options.length, 'long');

  await assert.rejects(
    Promise.resolve().then(() => splitUtf8Document('x'.repeat(CHROME_DOCUMENT_LIMITS.maxDocumentBytes + 1))),
    /exceeds 2000000 UTF-8 bytes/
  );
  console.log(`CHROME_DOCUMENT_SUMMARIZER_PASS chunks=${chunks.length} depth=${first.reduction_depth} receipt=${first.receipt_root} authority=${first.authority_ceiling}`);
} finally {
  mock.close();
  await once(mock, 'close');
}
