import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyMetrics } from '../src/features/integrations/metrics.js';
const day = { day: '2026-10-21', calories_kcal: 2300, protein_grams: 140, carbs_grams: null, activity_status: 'verified', calories_burned: 150 };
const goals = [{ effective_from: '2026-10-20', base_calorie_goal: 2000, protein_goal_g: 120, include_activity: true, source: 'manual' },
  { effective_from: '2026-10-22', base_calorie_goal: 2100, protein_goal_g: 150, include_activity: false, source: 'manual' }];
test('dated goals produce signed remaining values, preserve unknowns and never backfill an earlier day', () => {
  const m = dailyMetrics(day, goals);
  assert.equal(m.adjusted_calorie_goal, 2150); assert.equal(m.calories_remaining, -150); assert.equal(m.calorie_balance, 150);
  assert.equal(m.protein_remaining_g, -20); assert.equal(m.carbs_g, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-19' }, goals).base_calorie_goal, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-22' }, goals).adjusted_calorie_goal, 2100);
  assert.equal(dailyMetrics({ ...day, activity_status: 'multiple_sources' }, goals).adjusted_calorie_goal, null);
  assert.equal(dailyMetrics({ ...day, day: '2026-10-22', activity_status: 'no_data' }, goals).calories_remaining, -200);
  assert.equal(dailyMetrics(day).protein_goal_g, null);
});
