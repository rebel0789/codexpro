import assert from "node:assert/strict";
import {
  CODEXPRO_BINDING_MARKER_PREFIX,
  bindingMarkerForFingerprint,
  bindingMarkerFromCorrelation
} from "../dist/bindingMarker.js";

const first = bindingMarkerForFingerprint("ABCDEF1234567890");
const same = bindingMarkerForFingerprint("abcdef123456");
const sameLong = bindingMarkerForFingerprint("abcdef1234567890");
const other = bindingMarkerForFingerprint("1111111111111111");

assert.ok(first?.startsWith(CODEXPRO_BINDING_MARKER_PREFIX));
assert.equal(first, same);
assert.equal(first, sameLong);
assert.notEqual(first, other);
assert.equal(first?.length, CODEXPRO_BINDING_MARKER_PREFIX.length + 24);
assert.equal(first?.includes("abcdef1234567890"), false);
assert.equal(bindingMarkerForFingerprint("not-a-fingerprint"), undefined);
assert.equal(
  bindingMarkerFromCorrelation({
    clientCorrelation: { "x-openai-session-fingerprint": "ABCDEF1234567890" }
  }),
  first
);
assert.equal(bindingMarkerFromCorrelation({ clientCorrelation: {} }), undefined);

console.log("✓ binding marker smoke test passed");
