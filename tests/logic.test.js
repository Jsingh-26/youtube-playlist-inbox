const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHUNK_SIZE,
  extractPlaylistId,
  findNewVideoIds,
  nextSeenIds,
  isUnavailable,
  isQuotaError,
  splitIntoChunks,
  migrateLegacySeen,
  pickRecent
} = require('../src/Logic.js');

test('extractPlaylistId reads playlist URLs, watch URLs and bare IDs', () => {
  assert.equal(extractPlaylistId('https://www.youtube.com/playlist?list=PLabc123XYZ_-9'), 'PLabc123XYZ_-9');
  assert.equal(extractPlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123XYZ&index=2'), 'PLabc123XYZ');
  assert.equal(extractPlaylistId('  PLabc123XYZ  '), 'PLabc123XYZ');
});

test('extractPlaylistId rejects input without a playlist', () => {
  assert.equal(extractPlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractPlaylistId('hello'), null);
  assert.equal(extractPlaylistId(''), null);
  assert.equal(extractPlaylistId(undefined), null);
});

test('findNewVideoIds keeps playlist order and drops seen, empty and repeated IDs', () => {
  assert.deepEqual(findNewVideoIds(['a', 'b', 'c', 'b', '', 'd'], ['b']), ['a', 'c', 'd']);
  assert.deepEqual(findNewVideoIds(['a'], ['a']), []);
});

test('findNewVideoIds finds videos past position 50 (the first version missed them)', () => {
  const current = Array.from({ length: 120 }, (_, i) => `v${i}`);
  const seen = current.slice(0, 118);
  assert.deepEqual(findNewVideoIds(current, seen), ['v118', 'v119']);
});

test('nextSeenIds keeps deferred videos out so the next run adds them', () => {
  assert.deepEqual(nextSeenIds(['a', 'b', 'c'], ['c']), ['a', 'b']);
});

test('nextSeenIds forgets videos that left the source playlist, so storage stays bounded', () => {
  assert.deepEqual(nextSeenIds(['b', 'c'], []), ['b', 'c']);
  assert.deepEqual(nextSeenIds(['a', 'a', ''], []), ['a']);
});

test('isUnavailable flags private, deleted and ID-less videos', () => {
  assert.equal(isUnavailable({ videoId: 'a', title: 'Private video' }), true);
  assert.equal(isUnavailable({ videoId: 'a', title: 'Deleted video' }), true);
  assert.equal(isUnavailable({ title: 'Something' }), true);
  assert.equal(isUnavailable({ videoId: 'a', title: 'A real talk' }), false);
});

test('isQuotaError recognises quota failures only', () => {
  assert.equal(isQuotaError(new Error('The request cannot be completed because you have exceeded your quota.')), true);
  assert.equal(isQuotaError('quotaExceeded'), true);
  assert.equal(isQuotaError(new Error('Video not found.')), false);
  assert.equal(isQuotaError(undefined), false);
});

test('splitIntoChunks round-trips and keeps every piece under the property limit', () => {
  const seen = { PL1: Array.from({ length: 2000 }, (_, i) => `vid${String(i).padStart(8, '0')}`) };
  const json = JSON.stringify(seen);
  const chunks = splitIntoChunks(json, CHUNK_SIZE);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= CHUNK_SIZE));
  assert.ok(CHUNK_SIZE < 9 * 1024);
  assert.deepEqual(JSON.parse(chunks.join('')), seen);
  assert.deepEqual(splitIntoChunks('', CHUNK_SIZE), []);
});

test('migrateLegacySeen groups the old single map by source playlist', () => {
  const legacy = {
    v1: { title: 'One', sourcePlaylistId: 'PLa', added: true },
    v2: { title: 'Two', sourcePlaylistId: 'PLb', added: false },
    v3: { title: 'Three', sourcePlaylistId: 'PLa' },
    v4: { title: 'No source' }
  };
  assert.deepEqual(migrateLegacySeen(legacy), { PLa: ['v1', 'v3'], PLb: ['v2'] });
  assert.deepEqual(migrateLegacySeen(null), {});
});

test('pickRecent returns the latest additions, skipping unavailable videos', () => {
  const videos = [
    { videoId: 'old', title: 'Old', publishedAt: '2026-01-01T00:00:00Z' },
    { videoId: 'gone', title: 'Deleted video', publishedAt: '2026-09-01T00:00:00Z' },
    { videoId: 'new', title: 'New', publishedAt: '2026-08-01T00:00:00Z' },
    { videoId: 'mid', title: 'Mid', publishedAt: '2026-05-01T00:00:00Z' }
  ];
  assert.deepEqual(pickRecent(videos, 2).map(v => v.videoId), ['new', 'mid']);
});
