#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { BoundedAsyncCache } from '../dist/boundedAsyncCache.js';
import {
  CHROME_CORPUS_LIMITS,
  summarizeCorpusWithChrome2Api
} from '../dist/chromeCorpusSummarizer.js';

let calls = 0;
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls += 1;
  const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: `unstable-${Date.now()}-${calls}`,
    created: Date.now(),
    model: 'chrome-gemini-nano',
    choices: [{ message: { role: 'assistant', content: `summary-${fingerprint}` }, finish_reason: 'stop' }]
  }));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
assert.ok(address && typeof address === 'object');
const env = { CODEXPRO_CHROME2API_URL: `http://127.0.0.1:${address.port}/v1` };

const documents = [
  { documentId: 'z-AI-copy.md', text: 'Shared exact source for deterministic deduplication.' },
  { documentId: 'a-AI-original.md', text: 'Shared exact source for deterministic deduplication.' },
  { documentId: 'm-AI-unique.md', text: 'A different source must receive its own summary.' }
];

try {
  const tinyCache = new BoundedAsyncCache(2, 1000);
  let tinyComputes = 0;
  const compute = async (value) => { tinyComputes += 1; return { value }; };
  assert.equal((await tinyCache.getOrCompute('a', () => compute('a'))).disposition, 'miss');
  assert.equal((await tinyCache.getOrCompute('b', () => compute('b'))).disposition, 'miss');
  assert.equal((await tinyCache.getOrCompute('a', () => compute('never'))).disposition, 'hit');
  await tinyCache.getOrCompute('c', () => compute('c'));
  assert.equal((await tinyCache.getOrCompute('b', () => compute('b-again'))).disposition, 'miss', 'least-recently-used entry must be evicted');
  const beforeJoin = tinyComputes;
  const joined = await Promise.all([
    tinyCache.getOrCompute('joined', () => compute('joined')),
    tinyCache.getOrCompute('joined', () => compute('duplicate'))
  ]);
  assert.equal(tinyComputes - beforeJoin, 1);
  assert.deepEqual(joined.map((item) => item.disposition).sort(), ['joined', 'miss']);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(tinyCache.getOrCompute('failure', async () => { throw new Error('not cached'); }), /not cached/);
  }

  const input = { documents, type: 'key-points', format: 'markdown', length: 'medium', timeoutMs: 5000 };
  const first = await summarizeCorpusWithChrome2Api(input, env);
  assert.equal(first.schema, 'codexpro.chrome-corpus-summary.receipt.v1');
  assert.equal(first.authority_ceiling, 'CANDIDATE_ONLY');
  assert.equal(first.document_count, 3);
  assert.equal(first.unique_content_count, 2);
  assert.equal(first.cache.provider_calls, 2, 'first corpus pass must call the provider once per unique content');
  assert.equal(calls, 2);
  assert.deepEqual(first.aliases.map((alias) => alias.document_id), [
    'a-AI-original.md',
    'm-AI-unique.md',
    'z-AI-copy.md'
  ]);
  assert.equal(first.aliases[0].summary_receipt_root, first.aliases[2].summary_receipt_root);
  assert.notEqual(first.aliases[0].alias_receipt_root, first.aliases[2].alias_receipt_root);

  const replay = await summarizeCorpusWithChrome2Api(input, env);
  assert.equal(replay.receipt_root, first.receipt_root);
  assert.equal(replay.cache.provider_calls, 0, 'unchanged session inputs must reuse exact cached summaries');
  assert.equal(calls, 2);

  const beforeConcurrent = calls;
  const concurrentInput = { ...input, type: 'teaser' };
  const [left, right] = await Promise.all([
    summarizeCorpusWithChrome2Api(concurrentInput, env),
    summarizeCorpusWithChrome2Api(concurrentInput, env)
  ]);
  assert.equal(calls - beforeConcurrent, 2, 'concurrent identical corpora must join one provider call per unique content');
  assert.equal(left.receipt_root, right.receipt_root);

  await assert.rejects(
    summarizeCorpusWithChrome2Api({ documents: [documents[0], documents[0]] }, env),
    /duplicate document id/i
  );
  await assert.rejects(
    summarizeCorpusWithChrome2Api({ documents: [{ documentId: 'empty.md', text: '   ' }] }, env),
    /must be non-empty/i
  );
  await assert.rejects(
    summarizeCorpusWithChrome2Api({
      documents: Array.from({ length: CHROME_CORPUS_LIMITS.maxDocuments + 1 }, (_, index) => ({
        documentId: `doc-${index}.md`,
        text: 'bounded'
      }))
    }, env),
    /exceeds 64 documents/i
  );

  console.log(`CHROME_CORPUS_SUMMARIZER_PASS documents=${first.document_count} unique=${first.unique_content_count} provider_calls=${first.cache.provider_calls} replay_calls=${replay.cache.provider_calls} receipt=${first.receipt_root}`);
} finally {
  mock.close();
  await once(mock, 'close');
}
