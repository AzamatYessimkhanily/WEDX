import { test } from 'node:test';
import assert from 'node:assert/strict';
import { technique, techniqueText, compareTechnique, techniquePercent, techniqueProgress, techniqueReadiness } from '../src/domain/technique.js';
import { parseState } from '../src/domain/state.js';
import { workoutDays } from '../supabase/functions/wedx-coach/data.js';

const rec = (clean, weight = 20, reps = 10) => ({ d: '2026-10-20', w: weight, r: reps, v: weight * reps, n: 1, s: [[weight, reps]], q: [{ clean }] });
test('clean repetitions determine technique progress at equal or greater workload, including assisted and timed sets', () => {
  assert.equal(techniqueProgress(rec(9), rec(8), { weighted: true }), 1);
  assert.equal(techniqueProgress(rec(10), rec(8), { weighted: true }), 1);
  assert.equal(techniqueProgress(rec(10, 10), rec(8, 20), { weighted: true }), 0);
  assert.equal(techniqueProgress(rec(8, 20, 8), rec(8), { weighted: true }), 0);
  assert.equal(techniqueProgress(rec(10, 10), rec(8, 20), { weighted: true, assisted: true }), 1);
  assert.equal(techniqueProgress(rec(10, 30), rec(8, 20), { weighted: true, assisted: true }), 0);
  assert.equal(techniqueProgress(rec(40, 0, 40), rec(30, 0, 40)), 1);
  assert.equal(compareTechnique({ clean: 8 }, { clean: 6 }, 10, 8), 1);
  assert.equal(compareTechnique({ clean: 6 }, { clean: 3 }, 8, 4), 0);
});
test('old scores do not affect comparison or invent clean counts; all-clean requires an explicit count', () => {
  assert.equal(compareTechnique({ score: 5, clean: 7 }, { score: 2, clean: 9 }, 10, 10), -1);
  assert.equal(compareTechnique({ score: 1, clean: 9 }, { score: 5, clean: 7 }, 10, 10), 1);
  assert.equal(compareTechnique({ clean: 10 }, { score: 5, clean: null }, 10, 10), null);
  assert.equal(technique({ score: 5, clean: null }, 10), null);
  assert.equal(techniquePercent({ s: [[20, 10]], q: [{ score: 5, clean: null }] }), null);
  assert.equal(techniqueReadiness({ s: [[20, 10]], q: [{ score: 5, clean: null }] }), 'unknown');
  assert.equal(techniqueReadiness(rec(8)), 'hold');
  assert.equal(techniqueReadiness(rec(10)), 'ready');
  assert.equal(techniqueReadiness({ s: [[20, 10]] }), 'unknown');
  assert.equal(techniqueText({ clean: 6 }, 8), 'Чисто 6 из 8');
  assert.equal(techniqueText({ clean: 30 }, 40, true), 'Чисто 30 из 40 сек');
});
test('percentage weights assessed repetitions, omits unknown and skipped sets, and retains explicit zero', () => {
  assert.equal(techniquePercent({ s: [[20, 10], null, [20, 20], [20, 5]], q: [{ clean: 10 }, { clean: 20 }, { clean: 5 }, null] }), 50);
  assert.equal(techniquePercent(rec(0)), 0);
  assert.equal(techniquePercent({ s: [[20, 0]], q: [{ clean: 0 }] }), null);
  const previous = rec(8), current = rec(9);
  previous.s.push([20, 10]); previous.q.push({ clean: 10 });
  current.s.push([20, 10]); current.q.push({ clean: 9 });
  assert.equal(techniqueProgress(current, previous), -1);
});
test('both backup formats retain sparse sets and drop sets; new data and coach responses need no score', () => {
  const history = rec(8); history.s.push(null, [18, 8, 12, 3]); history.q.push(null, { score: 3, clean: 6 }); history.n = 2;
  const state = { hist: { 'mon|0': [history] } };
  assert.deepEqual(parseState(JSON.stringify(state)), state);
  const sets = workoutDays(state, { start: '2026-10-01', end: '2026-10-31' })[0].exercises[0].sets;
  assert.deepEqual(sets[0].technique, { clean: 8 });
  assert.deepEqual(sets[1].technique, { clean: 6 });
  assert.deepEqual(sets[1].extra_set, { recorded_weight_kg: 12, repetitions: 3 });
  history.q[0].clean = -1;
  assert.throws(() => parseState(JSON.stringify(state)));
  history.q[0].clean = 2.5;
  assert.throws(() => parseState(JSON.stringify(state)));
  assert.deepEqual(technique({ score: 4, clean: 10 }, 6), { clean: 6 });
});
