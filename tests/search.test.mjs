import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPercent, searchHits } from '../src/search.ts';

const hits = [
  {id: 'strong', score: .83},
  {id: 'boundary', score: .7},
  {id: 'rounded-boundary', score: .6996},
  {id: 'below', score: .6994},
  {id: 'weak', score: .5},
  {id: 'negative', score: -.2},
];

test('Sorted keeps every valid hit in backend relevance order at any cutoff', () => {
  assert.deepEqual(searchHits(hits, 'sorted', 100), hits);
});
test('Definitive includes the displayed cutoff and excludes scores below it', () => {
  assert.deepEqual(searchHits(hits, 'definitive', 70).map(h => h.id), ['strong', 'boundary', 'rounded-boundary']);
  assert.equal(matchPercent(hits[2].score), 70);
  assert.equal(matchPercent(hits[3].score), 69.9);
});
test('Cutoff extremes produce all or no matches without forcing a best match', () => {
  assert.deepEqual(searchHits(hits, 'definitive', 0), hits);
  assert.deepEqual(searchHits(hits, 'definitive', 100), []);
});
test('Scores are absolute similarity percentages, not normalized to the best result', () => {
  assert.equal(matchPercent(.716841936), 71.7);
  assert.equal(matchPercent(-.2), 0);
  assert.equal(matchPercent(1.0000001), 100);
  assert.deepEqual(searchHits([{id: 'invalid', score: NaN}], 'sorted', 0), []);
});
