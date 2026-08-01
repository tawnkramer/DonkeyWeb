import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipEntries, unzipEntries } from '../utils/zip.js';

test('model ZIP bundles round-trip JSON and binary entries', () => {
  const model = new TextEncoder().encode('{"format":"layers-model"}');
  const weights = new Uint8Array([0, 1, 2, 127, 255]);
  const archive = zipEntries([
    { name: 'model.json', data: model },
    { name: 'weights.bin', data: weights },
  ]);
  const entries = unzipEntries(archive);
  assert.equal(new TextDecoder().decode(entries.get('model.json')), '{"format":"layers-model"}');
  assert.deepEqual([...entries.get('weights.bin')], [...weights]);
});
