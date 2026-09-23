const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, daysInMonth, addDays, addMonths, weekday, monthGrid, allowed, clamp, localToday } = require('../date-picker.js');

test('date-only validation respects Gregorian leap years and rejects normalized invalid input', () => {
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(1900, 2), 28);
  assert.deepEqual(parse('2024-02-29'), { year: 2024, month: 2, day: 29 });
  for (const value of ['2023-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-9-1', '2026-09-01T00:00:00Z']) assert.equal(parse(value), null, value);
});

test('day navigation crosses leap days and year boundaries without timezone conversion', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2023-03-01', -1), '2023-02-28');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('0001-01-01', -1), null);
  assert.equal(addDays('9999-12-31', 1), null);
});

test('month and year navigation clamps the day rather than overflowing into another month', () => {
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2026-01-31', -1), '2025-12-31');
  assert.equal(addMonths('0001-01-01', -1), null);
  assert.equal(addMonths('9999-12-01', 1), null);
});

test('calendar weeks start on Monday including Sunday-starting and leap months', () => {
  assert.equal(weekday('2026-09-21'), 0);
  assert.equal(weekday('2026-09-27'), 6);
  const grid = monthGrid('2026-02-01');
  assert.equal(grid.length, 42);
  assert.equal(grid[0], '2026-01-26');
  assert.equal(grid[6], '2026-02-01');
  assert.equal(grid[7], '2026-02-02');
  assert.equal(new Set(grid).size, 42);
  assert.ok(monthGrid('2024-02-01').includes('2024-02-29'));
  assert.equal(monthGrid('0001-01-01')[0], '0001-01-01');
});

test('min and max constraints are inclusive and malformed bounds follow native input behavior', () => {
  assert.equal(allowed('2026-09-23', '2026-09-23', '2026-09-30'), true);
  assert.equal(allowed('2026-09-30', '2026-09-23', '2026-09-30'), true);
  assert.equal(allowed('2026-09-22', '2026-09-23', '2026-09-30'), false);
  assert.equal(allowed('2026-10-01', '2026-09-23', '2026-09-30'), false);
  assert.equal(allowed('2026-09-23', 'invalid', ''), true);
  assert.equal(allowed('', '', ''), false);
  assert.equal(clamp('2026-09-01', '2026-09-23', ''), '2026-09-23');
  assert.equal(clamp('2026-10-01', '', '2026-09-30'), '2026-09-30');
  assert.equal(clamp('2026-09-25', '2026-09-30', '2026-09-23'), null);
});

test('today uses browser local calendar parts, including near-midnight dates', () => {
  const localClock = { getFullYear: () => 2026, getMonth: () => 8, getDate: () => 24, toISOString: () => '2026-09-23T21:15:00.000Z' };
  assert.equal(localToday(localClock), '2026-09-24');
});
