import assert from 'node:assert/strict';
import { reviewQueues, fetchReviewTasks } from '../src/lib/review-queues.ts';

const task = (id, reviewer, overrides = {}) => ({
  id, reviewer: reviewer == null ? null : { id: reviewer }, project: 1,
  column: { kind: 'review', is_done: false },
  updated_at: '2026-09-15T12:00:00Z', linked_prs: [], ...overrides,
});
const mine = task(1, 10);
const other = task(2, 20);
const unassigned = task(3, null);
const closed = task(4, 10, { column: { kind: 'done', is_done: true } });
let result = reviewQueues([[mine, closed], [unassigned], [mine, other, unassigned]], 10);
assert.deepEqual(result.queues.mine.map(t => t.id), [1]);
assert.deepEqual(result.queues.others.map(t => t.id), [2]);
assert.deepEqual(result.queues.unassigned.map(t => t.id), [3]);
assert.equal(result.queues.all.length, 3);

// A stale unassigned poll must not override the new reviewer after claiming.
const claimed = task(3, 10, { updated_at: '2026-09-15T13:00:00Z' });
result = reviewQueues([[claimed], [unassigned], [other]], 10);
assert.equal(result.queues.unassigned.length, 0);
assert.equal(result.queues.mine[0].id, 3);
const pr = (repo, state = 'open') => ({ state, merged: false, repository: { repo_id: repo } });
const withPR = task(5, 20, { project: 2, linked_prs: [pr(42), pr(43, 'closed')] });
assert.equal(reviewQueues([[withPR, mine]], 10, '2', '42').queues.all.length, 1);
assert.equal(reviewQueues([[withPR, mine]], 10, '1', '42').queues.all.length, 0);
assert.equal(reviewQueues([[withPR]], 10, '', '43').queues.all.length, 0);
assert.equal(reviewQueues([[mine]], undefined).queues.mine.length, 0);
console.log('Review queues: deduplication, claiming, completion, and filters passed.');

const offsets = [];
const fetched = await fetchReviewTasks('/api/tasks/?reviewer=me', async path => {
  offsets.push(path);
  return offsets.length === 1 ? { results: [mine], next: 'page2' } : { results: [other], next: null };
});
assert.deepEqual(fetched.map(t => t.id), [1, 2]);
assert.equal(offsets[1], '/api/tasks/?reviewer=me&offset=1');
await assert.rejects(fetchReviewTasks('/api/tasks/?reviewer=me', async () => ({ results: [], next: 'page2' })), /empty page/);
console.log('Review pagination: multiple pages and empty-page guard passed.');
