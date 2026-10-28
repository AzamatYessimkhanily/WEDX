import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDailyTotals } from '../supabase/functions/health-import/totals.js';
import { createHandler } from '../supabase/functions/health-import/handler.js';
import { dailyMetrics } from '../src/features/integrations/metrics.js';
const total = (value, unit = 'g', date = '2026-10-23') => ({ date, value, unit });
const snapshot = changes => ({ version: 5, activitySelection: { mode: 'single-source', source: 'Apple Watch (Test)' }, source: 'apple-health', aggregation: 'day', startDate: '2026-10-16', endDate: '2026-10-23',
  energyTotals: [total(1321, 'kcal')], proteinTotals: [total(58)], carbsTotals: [total(121)], fatTotals: [total(70)], activityTotals: [total(90, 'kcal')], ...changes });
test('native daily totals retain provenance, precision and the seven requested metrics', () => {
  const result = summarizeDailyTotals(snapshot());
  assert.deepEqual(result, { skipped: [], days: [{ date: '2026-10-23', caloriesKcal: 1321, proteinGrams: 58,
    carbsGrams: 121, fatGrams: 70, nutritionOrigin: 'apple-health', activityStatus: 'verified', caloriesBurned: 90 }] });
  const m = dailyMetrics({ day: '2026-10-23', calories_kcal: 1321, protein_grams: 58, carbs_grams: 121, fat_grams: 70,
    calories_burned: 90, activity_status: 'verified', nutrition_origin: 'apple-health' },
  [{ effective_from: '2026-10-22', base_calorie_goal: 2296, include_activity: true }]);
  assert.equal(m.calories_remaining, 1065);
  assert.equal(m.nutrition_origin, 'apple-health');
  assert.equal(summarizeDailyTotals(snapshot({ activityTotals: [total(418.4, 'kJ')], proteinTotals: [total(58500, 'mg')] })).days[0].caloriesBurned, 100);
  assert.equal(summarizeDailyTotals(snapshot({ proteinTotals: [total(58500, 'mg')] })).days[0].proteinGrams, 58.5);
});
test('missing access or totals never become zero and native totals are never summed twice', () => {
  const missing = summarizeDailyTotals(snapshot({ fatTotals: [], activityTotals: [] })).days[0];
  assert.equal(missing.activityStatus, 'no_data'); assert.equal(missing.caloriesBurned, null);
  assert.equal(Object.hasOwn(missing, 'fatGrams'), false);
  assert.deepEqual(summarizeDailyTotals(snapshot({ proteinTotals: [] })), { days: [], skipped: ['2026-10-23'] });
  assert.equal(summarizeDailyTotals(snapshot({ activityTotals: [total(0, 'kcal')] })).days[0].caloriesBurned, 0);
  for (const changes of [{ aggregation: 'raw' }, { energyTotals: [total(1, 'kcal'), total(2, 'kcal')] },
    { activityTotals: [total(-1, 'kcal')] }, { fatTotals: [total('70')] }, { carbsTotals: [total(1, 'unknown')] },
    { startDate: '2026-02-30' }, { endDate: '2026-10-15' }, { activityTotals: undefined }]) {
    assert.throws(() => summarizeDailyTotals(snapshot(changes)));
  }
  assert.deepEqual(summarizeDailyTotals(snapshot({ energyTotals: [total(500, 'kcal', '2026-10-15'), total(1321, 'kcal')] })).days.length, 1);
});
test('v5 handler writes corrected full totals with native Health provenance', async () => {
  const writes = [];
  const handler = createHandler(async (_, args) => { writes.push(args); return { data: { records: args.p_days.length } }; });
  const request = body => new Request('https://example.com', { method: 'POST', headers: { Authorization: 'Bearer wedx_' + 'a'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await handler(request(snapshot()))).status, 200);
  assert.equal(writes[0].p_days[0].nutritionOrigin, 'apple-health');
  assert.equal(writes[0].p_days[0].activityStatus, 'verified');
  assert.equal((await handler(request(snapshot({ energyTotals: [total(1200, 'kcal')] })))).status, 200);
  assert.equal(writes[1].p_days[0].caloriesKcal, 1200);
  assert.notEqual(writes[0].p_request_id, writes[1].p_request_id);
});

test('invalid phone totals identify the field without echoing health measurements or the payload', () => {
  assert.throws(() => summarizeDailyTotals(snapshot({ activityTotals: [total(90, 'ккал/день')] })), /Активная энергия: неизвестная единица "ккал\/день"/);
  assert.throws(() => summarizeDailyTotals(snapshot({ proteinTotals: [total('58321')] })), error => error.message.includes('Белок: неверное значение (текст)') && !error.message.includes('58321'));
  assert.throws(() => summarizeDailyTotals(snapshot({ fatTotals: [total(70, 'g', null)] })), /Жиры: неверная дата \(пусто\)/);
});

test('HealthKit large calories retain their magnitude while small calories convert separately', () => {
  for (const unit of ['kcal', 'kCal', 'Cal']) {
    const row = summarizeDailyTotals(snapshot({ energyTotals: [total(1321, unit)], activityTotals: [total(90, unit)] })).days[0];
    assert.equal(row.caloriesKcal, 1321); assert.equal(row.caloriesBurned, 90);
  }
  const small = summarizeDailyTotals(snapshot({ activityTotals: [total(90000, 'cal')] })).days[0];
  assert.equal(small.caloriesBurned, 90);
  const belowOne = summarizeDailyTotals(snapshot({ activityTotals: [total(90, 'cal')] })).days[0];
  assert.equal(belowOne.caloriesBurned, 0.09);
  assert.throws(() => summarizeDailyTotals(snapshot({ activityTotals: [total(90, 'CAL')] })), /неизвестная единица/);
});

test('old all-source 775 kcal cannot replace a corrected 549 kcal Watch day', async () => {
  const writes = [];
  const handler = createHandler(async (_, args) => { writes.push(args.p_days[0]); return { data: { records: 1 } }; });
  const request = body => new Request('https://example.com', { method: 'POST', headers: {
    Authorization: 'Bearer wedx_' + 'a'.repeat(64), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await handler(request(snapshot({ activityTotals: [total(549, 'kcal')] })));
  const legacy = await handler(request(snapshot({ version: 4, activityTotals: [total(775, 'kcal')] })));
  assert.equal(writes[0].caloriesBurned, 549);
  assert.equal(writes[0].activityStatus, 'verified');
  assert.equal(Object.hasOwn(writes[1], 'caloriesBurned'), false);
  assert.equal(Object.hasOwn(writes[1], 'activityStatus'), false);
  assert.equal(writes[1].caloriesKcal, 1321);
  assert.equal((await legacy.json()).updateRequired, true);
  // The old stored total is not used for the remaining calorie allowance.
  const m = dailyMetrics({ day: '2026-10-23', calories_kcal: 1321, calories_burned: 775, activity_status: 'health_total' },
    [{ effective_from: '2026-10-22', base_calorie_goal: 2018, include_activity: true }]);
  assert.equal(m.calories_burned, null); assert.equal(m.calories_remaining, null);
});

test('Watch totals require one identified source and missing data never becomes zero', () => {
  for (const activitySelection of [undefined, { mode: 'all', source: 'Apple Watch' },
    { mode: 'single-source', source: 'iPhone' }, { mode: 'single-source', source: '' }]) {
    assert.throws(() => summarizeDailyTotals(snapshot({ activitySelection })));
  }
  const missing = summarizeDailyTotals(snapshot({ activitySelection: { mode: 'single-source', source: '' }, activityTotals: [] })).days[0];
  assert.equal(missing.caloriesBurned, null); assert.equal(missing.activityStatus, 'no_data');
});
