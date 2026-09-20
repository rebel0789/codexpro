#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chrome2ApiContract, resolveChrome2ApiUrl } from '../dist/chrome2ApiContract.js';
import { chrome2ApiStatus, completeWithChrome2Api } from '../dist/chrome2ApiOps.js';

let completionCalls = 0;
let lastRequest;
const mock = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, undefined);
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'chrome-gemini-nano', object: 'model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    completionCalls += 1;
    const userText = lastRequest.messages.at(-1)?.content;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: `unstable-${completionCalls}`,
      created: Date.now(),
      model: userText === 'wrong-model' ? 'remote-model' : 'chrome-gemini-nano',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: userText === 'oversized-response' ? 'x'.repeat(262_145) : 'local CPU answer' },
        finish_reason: 'stop'
      }]
    }));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const address = mock.address();
assert.ok(address && typeof address === 'object');
const env = { CODEXPRO_CHROME2API_URL: `http://127.0.0.1:${address.port}/v1` };

try {
  const contract = chrome2ApiContract(env);
  assert.equal(contract.schema, 'codexpro.chrome2api.contract.v1');
  assert.equal(contract.endpoint.configuration_valid, true);
  assert.equal(contract.boundaries.loopback_literal_only, true);
  assert.equal(contract.boundaries.local_file_or_media_inputs, false);
  assert.equal(contract.boundaries.authorization_forwarded, false);
  assert.equal(contract.boundaries.proprietary_assets_bundled, false);

  const status = await chrome2ApiStatus(5000, env);
  assert.equal(status.ready, true);
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.advertised_models, ['chrome-gemini-nano']);

  const request = { prompt: 'inventory this node', system: 'Answer locally.', maxTokens: 64, temperature: 0, timeoutMs: 5000 };
  const first = await completeWithChrome2Api(request, env);
  const replay = await completeWithChrome2Api(request, env);
  assert.equal(first.schema, 'codexpro.chrome2api.receipt.v1');
  assert.equal(first.endpoint, `http://127.0.0.1:${address.port}/v1`);
  assert.equal(first.content, 'local CPU answer');
  assert.equal(first.receipt_root, replay.receipt_root, 'unstable upstream ids/timestamps must not alter proof identity');
  assert.match(first.request_root, /^[a-f0-9]{64}$/);
  assert.match(first.response_root, /^[a-f0-9]{64}$/);
  assert.deepEqual(lastRequest, {
    model: 'chrome-gemini-nano',
    messages: [
      { role: 'system', content: 'Answer locally.' },
      { role: 'user', content: 'inventory this node' }
    ],
    max_tokens: 64,
    temperature: 0,
    n: 1,
    stream: false
  });

  assert.throws(
    () => resolveChrome2ApiUrl({ CODEXPRO_CHROME2API_URL: 'https://attacker.example/v1' }),
    /literal loopback/i
  );
  const invalidStatus = await chrome2ApiStatus(5000, { CODEXPRO_CHROME2API_URL: 'https://attacker.example/v1' });
  assert.equal(invalidStatus.ready, false);
  assert.equal(invalidStatus.state, 'invalid-configuration');
  await assert.rejects(
    completeWithChrome2Api({ prompt: 'x'.repeat(65_537) }, env),
    /at most 65536 UTF-8 bytes/i
  );
  await assert.rejects(completeWithChrome2Api({ prompt: 'wrong-model' }, env), /unexpected model identity/i);
  await assert.rejects(completeWithChrome2Api({ prompt: 'oversized-response' }, env), /byte boundary/i);
  assert.equal(completionCalls, 4);
  console.log(`CHROME2API_PASS receipt=${first.receipt_root} loopback_only=yes media=no secrets=no`);
} finally {
  mock.close();
  await once(mock, 'close');
}
