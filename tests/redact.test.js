import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSecretValue, redactSensitiveText } from '../src/redact.ts';

test('allows source references without treating them as secret values', () => {
  const sourceReferences = [
    'const secret = env.APPLICATION_SECRET;',
    'const secret = process.env.APPLICATION_SECRET;',
    'const secret = settings.applicationSecret;',
    'type Options = { apiToken: ApplicationCredentialType };',
    'type Options = {\n  apiToken: ApplicationCredentialType;\n};',
    'interface Options {\n  apiToken: ApplicationCredentialType;\n}',
  ];

  for (const source of sourceReferences) {
    assert(hasSecretValue(source) === false);
    assert.equal(redactSensitiveText(source), source, 'redacted source reference: ' + source);
  }
});

test('continues to detect and redact literal secret values', () => {
  const value = 'A'.repeat(24);
  const secretValues = [`API_SECRET=${value}`, `const API_SECRET = "${value}";`];

  for (const source of secretValues) {
    assert.equal(hasSecretValue(source), true);
    assert.match(redactSensitiveText(source), /\[REDACTED_SECRET\]/);
  }
});
