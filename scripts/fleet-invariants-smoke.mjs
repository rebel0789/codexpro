#!/usr/bin/env node
import assert from 'node:assert/strict';
import { FLEET_CAPABILITY_INVARIANTS, fleetCapabilityContract } from '../dist/fleetInvariants.js';

const expected = [
  'authenticated-coordinator',
  'self-similar-node-contract',
  'capability-before-execution',
  'ai-plan-data-only',
  'logical-routing-physical-bounds',
  'node-local-resources',
  'bounded-fanout',
  'receipt-required',
  'fail-closed-drift',
  'local-browser-provider',
  'no-secret-propagation'
];

assert.deepEqual(FLEET_CAPABILITY_INVARIANTS.map((item) => item.id), expected);
assert.ok(Object.isFrozen(FLEET_CAPABILITY_INVARIANTS));

const contract = fleetCapabilityContract({
  sshTargets: ['BlackPearl', 'soliwallaptop', 'blackpearl', ''],
  sshExecMode: 'read',
  browserProviderEnabled: true
});

assert.equal(contract.schema, 'codexpro.fleet-capability-invariants.v1');
assert.deepEqual(contract.ssh.configured_targets, ['blackpearl', 'soliwallaptop']);
assert.equal(contract.ssh.transport_only, true);
assert.equal(contract.ssh.arbitrary_public_shell, false);
assert.equal(contract.ssh.max_lanes, 8);
assert.equal(contract.cpu.max_worker_fraction, 0.8);
assert.equal(contract.dag.planner_is_data_only, true);
assert.equal(contract.dag.endpoint_uris_from_model, false);
assert.equal(contract.dag.physical_execution_is_bounded, true);
assert.equal(contract.browser.local_only, true);
assert.equal(contract.browser.unrestricted_tools_publicly_exposed, false);
assert.equal(contract.browser.automatic_extension_installation, false);
assert.equal(contract.proof.terminal_receipt_required, true);
assert.equal(contract.proof.queue_submission_is_completion, false);
assert.equal(contract.secrets.remain_node_local, true);
assert.equal(contract.secrets.copied_to_packets_or_receipts, false);
assert.doesNotMatch(JSON.stringify(contract), /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._~-]{16,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/, 'contract must contain laws, not secret values');

console.log('FLEET_INVARIANTS_PASS count=11 ssh_transport_only=yes receipt_required=yes browser_local_only=yes dag_bounded=yes');
