import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyMetrics, nutritionStatus } from '../src/features/integrations/metrics.js';
import { monthCells } from '../src/features/integrations/calendar.js';
const day = { day: '2026-10-21', calories_kcal: 2300, protein_grams: 140, carbs_grams: null, activity_status: 'verified', calories_burned: 150 };
const goals = [{ effective_from: '2026-10-20', base_calorie_goal: 2000, protein_goal_g: 120, include_activity: true, source: 'manual' },
  { effective_from: '2026-10-22', base_calorie_goal: 2100, protein_goal_g: 150, include_activity: false, source: 'manual' }];
test('dated goals produce signed remaining values, preserve unknowns and never backfill an earlier day', () => {
  const m = dailyMetrics(day, goals, [{ d: '2026-10-20', w: 80 }]);
  assert.equal(m.adjusted_calorie_goal, 2150); assert.equal(m.calories_remaining, -150); assert.equal(m.calorie_balance, 150);
  assert.equal(m.protein_remaining_g, 20); assert.equal(m.carbs_g, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-19' }, goals).base_calorie_goal, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-22' }, goals).adjusted_calorie_goal, 2100);
  assert.equal(dailyMetrics({ ...day, activity_status: 'multiple_sources' }, goals).adjusted_calorie_goal, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-22', activity_status: 'no_data' }, goals).calories_remaining, -200);
  assert.equal(dailyMetrics(day).protein_goal_g, null);
});

test('protein targets use dated ratios and earlier weights, never future measurements or fixed YAZIO grams', () => {
  const weights = [{ d: '2026-10-19', w: 98.4 }, { d: '2026-10-23', w: 80 }];
  const dated = [...goals, { effective_from: '2026-10-23', base_calorie_goal: 2018, protein_per_kg: 1.6 }];
  assert.equal(dailyMetrics(day, dated, weights).protein_goal_g, 197);
  assert.equal(dailyMetrics(day, dated, weights).protein_weight_date, '2026-10-19');
  assert.equal(dailyMetrics({ ...day, day: '2026-10-23' }, dated, weights).protein_goal_g, 128);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-18' }, dated, weights).protein_goal_g, null);
  assert.equal(dailyMetrics(day, dated, [{ d: '2026-10-20', w: 0 }]).protein_goal_g, null);
});

test('calendar distinguishes completed targets, both overruns, missing data and an unfinished today', () => {
  const m = { date: '2026-10-21', calories_remaining: 50, protein_remaining_g: -10 };
  const today = '2026-10-22';
  assert.equal(nutritionStatus(m, today).kind, 'met');
  assert.equal(nutritionStatus({ ...m, protein_remaining_g: 10 }, today).kind, 'protein');
  const both = nutritionStatus({ ...m, calories_remaining: -1, protein_remaining_g: 10 }, today);
  assert.equal(both.kind, 'over'); assert.equal(both.lowProtein, true);
  assert.equal(nutritionStatus({ ...m, calories_remaining: null }, today).kind, 'unknown');
  assert.equal(nutritionStatus({ ...m, protein_remaining_g: null }, today).kind, 'unknown');
  const partial = nutritionStatus({ ...m, date: today, protein_remaining_g: 100 }, today);
  assert.equal(partial.kind, 'pending'); assert.equal(partial.lowProtein, false);
  assert.equal(nutritionStatus({ ...m, date: today, calories_remaining: -1 }, today).kind, 'over');
  assert.equal(nutritionStatus({ ...m, calories_remaining: 0, protein_remaining_g: 0 }, today).kind, 'met');
});

test('calendar uses Monday-first complete weeks and handles leap days and year boundaries', () => {
  assert.deepEqual(monthCells('2026-10').slice(0, 5), [null, null, null, '2026-10-01', '2026-10-02']);
  assert.equal(monthCells('2024-02').filter(Boolean).length, 29);
  assert.equal(monthCells('2025-02').filter(Boolean).length, 28);
  assert.equal(monthCells('2027-01').filter(Boolean).at(-1), '2027-01-31');
  assert.equal(monthCells('2026-10').length % 7, 0);
});
