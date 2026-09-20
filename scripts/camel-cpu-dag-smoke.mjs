#!/usr/bin/env node
import assert from 'node:assert/strict';
import { camelDagContract, runCamelDag } from '../dist/camelDagOps.js';

const contract = camelDagContract();
assert.equal(contract.schema, 'codexpro.camel-cpu-dag.contract.v1');
assert.equal(contract.runtime.jar_present, true, 'run npm run build:camel first');
assert.equal(contract.runtime.java_present, true);
assert.equal(contract.planner.endpoint_uris_allowed, false);
assert.equal(contract.planner.shell_allowed, false);
assert.match(contract.compiler.policy_root, /^[a-f0-9]{64}$/);
assert.ok(contract.physical_limits.max_workers <= 8);

const plan = JSON.stringify({
  planId: 'node-inventory-smoke',
  items: [
    { id: 'host-b', capability: 'inventory.canonicalize', payload: '  Windows\r\nNode  ' },
    { id: 'host-a', capability: 'hash.sha256', payload: 'cpu=16;ram=64GiB' }
  ]
});
const first = await runCamelDag(plan, 30000);
const replay = await runCamelDag(plan, 30000);
assert.equal(first.schema, 'codexpro.camel-cpu-dag.receipt.v1');
assert.equal(first.receiptRoot, replay.receiptRoot);
assert.deepEqual(first.outputs.map((item) => item.id), ['host-b', 'host-a']);
assert.equal(first.outputs[0].output, 'Windows\nNode');
assert.match(first.receiptRoot, /^[a-f0-9]{64}$/);

await assert.rejects(
  runCamelDag(JSON.stringify({ planId: 'reject-shell', items: [{ id: 'x', capability: 'shell.unrestricted', payload: 'whoami' }] }), 30000),
  /not admitted/i
);

console.log(`CAMEL_CPU_DAG_PASS receipt=${first.receiptRoot} workers=${first.workerLimit} queue=${first.queueLimit}`);
