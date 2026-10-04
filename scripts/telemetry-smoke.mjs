import assert from 'node:assert/strict';

import {
  recordTelemetry,
  resetTelemetryForTest,
  telemetrySnapshot
} from '../dist/telemetry.js';

resetTelemetryForTest();

recordTelemetry({
  ts: '2026-10-03T10:00:00.000Z',
  kind: 'tool',
  event: 'start',
  tool: 'bash',
  callId: 1,
  clientSessionFingerprint: 'aaaaaaaaaaaa',
  args: { command: 'printf ok' }
});
recordTelemetry({
  ts: '2026-10-03T10:00:01.000Z',
  kind: 'tool',
  event: 'finish',
  tool: 'bash',
  callId: 1,
  status: 'ok',
  clientSessionFingerprint: 'aaaaaaaaaaaa',
  result: { exitCode: 0 }
});
recordTelemetry({
  ts: '2026-10-03T10:00:02.000Z',
  kind: 'session',
  event: 'heartbeat',
  state: 'idle_between_requests',
  clientSessionFingerprint: 'bbbbbbbbbbbb'
});

const all = telemetrySnapshot({ limit: 10 });
assert.equal(all.events.length, 3);
assert.equal(all.latestSeq, 3);
assert.equal(all.firstSeq, 1);

const filtered = telemetrySnapshot({
  sinceSeq: 1,
  clientSessionFingerprint: 'aaaaaaaaaaaa',
  limit: 10
});
assert.equal(filtered.events.length, 1);
assert.equal(filtered.events[0].event, 'finish');
assert.equal(filtered.events[0].status, 'ok');

const otherSession = telemetrySnapshot({
  clientSessionFingerprint: 'bbbbbbbbbbbb',
  limit: 10
});
assert.equal(otherSession.events.length, 1);
assert.equal(otherSession.events[0].kind, 'session');

resetTelemetryForTest();
assert.equal(telemetrySnapshot({ limit: 10 }).events.length, 0);

console.log('✓ telemetry smoke test passed');
