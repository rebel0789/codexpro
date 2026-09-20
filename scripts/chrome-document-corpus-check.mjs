#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalRoot } from '../dist/chrome2ApiContract.js';
import { splitUtf8Document } from '../dist/chromeDocumentSummarizer.js';

const root = path.resolve(process.argv[2] ?? '.');
const entries = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.includes('AI'))
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
if (!entries.length) throw new Error(`No case-sensitive *AI*.md files found directly under ${root}`);

const records = [];
for (const entry of entries) {
  const bytes = await readFile(path.join(root, entry.name));
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Not valid UTF-8: ${entry.name}`);
  const chunks = splitUtf8Document(text);
  records.push({
    name: entry.name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunk_count: chunks.length,
    chunk_manifest_root: canonicalRoot('codexpro.chrome-document.chunks.v1', chunks.flatMap((chunk) => [
      chunk.id,
      String(chunk.startByte),
      String(chunk.endByte),
      chunk.sha256
    ]))
  });
}
const hashGroups = new Map();
for (const record of records) hashGroups.set(record.sha256, [...(hashGroups.get(record.sha256) ?? []), record.name]);
const duplicateGroups = [...hashGroups.entries()]
  .filter(([, names]) => names.length > 1)
  .map(([sha256, names]) => ({ sha256, names }));
const corpusRoot = canonicalRoot('codexpro.chrome-document-corpus.v1', records.flatMap((record) => [
  record.name,
  String(record.bytes),
  record.sha256,
  record.chunk_manifest_root
]));

console.log(JSON.stringify({
  schema: 'codexpro.chrome-document-corpus-check.v1',
  root,
  pattern: '*AI*.md (case-sensitive, top-level)',
  file_count: records.length,
  unique_content_count: hashGroups.size,
  total_bytes: records.reduce((total, record) => total + record.bytes, 0),
  corpus_root: corpusRoot,
  duplicate_groups: duplicateGroups,
  files: records
}, null, 2));
