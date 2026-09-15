import assert from 'node:assert/strict';
import { pullRequestQueues } from '../src/lib/pull-request-queues.ts';
const base = { projects: [{ id: 1 }], repository_id: 42, tasks: [], teams: [], reviewers: [] };
const prs = [
  { ...base, id: 1, reviewers: ['Alice', 'Bob'] },
  { ...base, id: 2, reviewers: ['Bob'] },
  { ...base, id: 3 },
  { ...base, id: 4, teams: ['devs'] },
];
const queues = pullRequestQueues(prs, 'alice');
assert.deepEqual(queues.mine.map(p => p.id), [1]);
assert.deepEqual(queues.others.map(p => p.id), [2, 4]);
assert.deepEqual(queues.unassigned.map(p => p.id), [3]);
assert.equal(queues.all.length, 4);
assert.equal(pullRequestQueues(prs, undefined).mine.length, 0);
assert.equal(pullRequestQueues(prs, 'alice', '1', '42').all.length, 4);
assert.equal(pullRequestQueues(prs, 'alice', '2', '42').all.length, 0);
assert.equal(pullRequestQueues(prs, 'alice', '1', '43').all.length, 0);
console.log('Pull request queues passed');
