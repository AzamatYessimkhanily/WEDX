import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingSeconds, elapsedSeconds, pauseSetTimer, resumeSetTimer } from '../src/features/timer/set-timer.js';

test('working time follows deadlines through backgrounding, excludes pauses, and caps at target', () => {
  const running = { total: 40, remaining: 40, endAt: 41000 };
  assert.equal(remainingSeconds(running, 1000), 40);
  assert.equal(elapsedSeconds(running, 10250), 9);
  const paused = pauseSetTimer(running, 10250);
  assert.equal(elapsedSeconds(paused, 90000), 9);
  const resumed = resumeSetTimer(JSON.parse(JSON.stringify(paused)), 90000);
  assert.equal(remainingSeconds(resumed, 100000), 20.75);
  assert.equal(elapsedSeconds(resumed, 100000), 19);
  assert.equal(remainingSeconds(resumed, 300000), 0);
  assert.equal(elapsedSeconds(resumed, 300000), 40);
});
