import assert from 'node:assert/strict';

// Tokyo is UTC+9 with no DST, so results don't depend on today's date.
process.env.TZ = 'Asia/Tokyo';
const { describeSchedule } = await import('../src/lib/routines.ts');

assert.equal(describeSchedule('0 0 * * *'), 'Every day at 9:00 AM');
assert.equal(describeSchedule('0 2 * * 6'), 'Every Saturday at 11:00 AM');
assert.equal(describeSchedule('0 22 * * 6'), 'Every Sunday at 7:00 AM'); // crosses midnight
assert.equal(describeSchedule('30 3 * * 1-3,7'), 'Every Sunday, Monday, Tuesday, and Wednesday at 12:30 PM');
for (const raw of ['*/15 * * * *', '0 0 1 * *', 'every 30m', '0 9 * * MON']) assert.equal(describeSchedule(raw), raw);
console.log('routine schedules ok');
