import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coachData, dateRange, workoutDays, weightTrend } from '../supabase/functions/wedx-coach/data.js';
import { workout } from './fixtures.js';

const now = new Date('2026-10-23T10:00:00Z');
const nutrition = [
  { day: '2026-10-20', calories_kcal: 2000, protein_grams: 150, activity_status: 'unknown', updated_at: '2026-10-23T09:00:00Z' },
  { day: '2026-10-22', calories_kcal: 2100, protein_grams: null, activity_status: 'health_total', calories_burned: 0 },
  { day: '2026-10-23', calories_kcal: 100, protein_grams: 5, activity_status: 'health_total', calories_burned: 90 },
];
const repository = {
  workout: async () => ({ snapshot: { ...workout, bw: [...workout.bw, { d: '2026-10-24', w: 100 }] }, updated_at: '2026-10-23T09:00:00Z' }),
  preferences: async () => ({ goal: 'Снижать жир и сохранять мышцы', timezone: 'Asia/Almaty' }),
  nutrition: async () => nutrition,
  goals: async () => [{ effective_from: '2026-10-20', base_calorie_goal: 2018, include_activity: false, protein_per_kg: 2, source: 'manual' }],
};
test('coach overview preserves missing records and denominators and excludes partial today from past-day means', async () => {
  const data = await coachData('get_fitness_overview', { days: 4 }, repository, now);
  assert.equal(data.today, '2026-10-23');
  assert.equal(data.latest_weight.w, 84.5);
  assert.equal(data.summary.mean_recorded_calories_past_days, 2050);
  assert.equal(data.summary.calories_average_days, 2);
  assert.equal(data.summary.mean_recorded_protein_g_past_days, 150);
  assert.equal(data.summary.protein_average_days, 1);
  assert.deepEqual(data.summary.nutrition_missing_dates, ['2026-10-21']);
  const first = data.days[0].nutrition;
  assert.equal(first.calories_burned, null); assert.equal(first.carbs_g, null);
  assert.equal(first.protein_goal_g, 169); assert.equal(first.calories_remaining, 18);
  assert.equal(data.days.at(-1).nutrition.is_ongoing_day, true);
  assert.match(data.notes.join(' '), /не базовый обмен/);
});
test('coach workouts preserve missing per-set history, drop-set detail, gym boundaries and counterweight semantics', () => {
  const snapshot = structuredClone(workout);
  snapshot.hist['fri|3'] = [{ d: '2026-10-20', w: 30, r: 10, v: 500, n: 1, g: 'other', s: [[30, 10]] }];
  const days = workoutDays(snapshot, { start: '2026-09-01', end: '2026-10-23' });
  assert.equal(days[0].exercises[0].sets, null);
  assert.equal(days[1].exercises[0].sets.length, 2);
  assert.equal(days[1].exercises[0].sets[1].set_number, 3);
  assert.deepEqual(days[1].exercises[0].sets[1].extra_set, { recorded_weight_kg: 20, repetitions: 3 });
  assert.equal(days[1].exercises[0].machine, true);
  assert.equal(days[1].exercises[1].assisted, true);
  assert.equal(workoutDays(snapshot, { start: '2026-10-01', end: '2026-10-23' }, { gym_id: 'mel' })[0].exercises.length, 1);
});
test('coach dates and trends reject impossible periods and do not infer a trend from one measurement', async () => {
  assert.throws(() => dateRange({ start_date: '2026-02-30' }, '2026-10-23'));
  assert.throws(() => dateRange({ start_date: '2020-01-01' }, '2026-10-23'));
  assert.equal(weightTrend(workout.bw, '2026-10-23').mean_change_kg, null);
  const data = await coachData('get_fitness_profile', {}, repository, now);
  assert.ok(data.unavailable_data.includes('сон'));
  assert.equal(data.latest_weight.weight_kg, 84.5);
  assert.equal(JSON.stringify(data).includes('token'), false);
});
