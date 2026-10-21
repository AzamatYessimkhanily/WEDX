import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples } from '../supabase/functions/health-import/samples.js';
import { createHandler } from '../supabase/functions/health-import/handler.js';

const sample = (date, value, unit) => ({ date, value, unit, source: 'YAZIO' });
const payload = overrides => ({ version: 2, source: 'yazio:apple-health', startDate: '2026-10-14', endDate: '2026-10-21',
  energySamples: [sample('2026-10-21', 4184, 'kJ'), sample('2026-10-21', 250.5, 'ккал')],
  proteinSamples: [sample('2026-10-21', 30000, 'mg'), sample('2026-10-21', 45.5, 'г')], ...overrides });

test('Health nutrition uses phone calendar dates, converts units and sums meals without collapsing identical samples', () => {
  const body = payload();
  body.energySamples.push(sample('2026-10-13', 999, 'kcal'), sample('2026-10-22', 999, 'kcal'));
  body.proteinSamples.push(sample('2026-10-21', 45.5, 'g'));
  assert.deepEqual(summarizeSamples(body), { days: [{ date: '2026-10-21', caloriesKcal: 1250.5, proteinGrams: 121 }], skipped: [] });
});

test('missing or inaccessible nutrition does not become zero, but an explicit zero is retained', () => {
  const body = payload({ proteinSamples: [] });
  assert.deepEqual(summarizeSamples(body), { days: [], skipped: ['2026-10-21'] });
  assert.deepEqual(summarizeSamples(payload({ energySamples: [], proteinSamples: [] })), { days: [], skipped: [] });
  body.proteinSamples.push(sample('2026-10-21', 0, 'g'));
  assert.equal(summarizeSamples(body).days[0].proteinGrams, 0);
});

test('unknown sources, units, impossible dates, negative values and excessive batches fail before any write', () => {
  for (const changes of [
    { startDate: '2026-02-30' }, { startDate: '2026-10-22' }, { startDate: '2025-10-01' },
    { energySamples: [sample('2026-10-21', '500', 'kcal')] },
    { energySamples: [sample('2026-10-21', -1, 'kcal')] },
    { energySamples: [sample('2026-10-21', 500, 'unknown')] },
    { energySamples: [{ ...sample('2026-10-21', 500, 'kcal'), source: 'Other App' }] },
    { energySamples: [{ ...sample('2026-10-21', 500, 'kcal'), source: 'YAZIOCopy' }] },
    { energySamples: Array(4001).fill(sample('2026-10-21', 500, 'kcal')) },
    { energySamples: [sample('2026-10-21', 100001, 'kcal')] },
  ]) assert.throws(() => summarizeSamples(payload(changes)));
});

test('the live-contract handler stores only daily totals, accepts corrections and reports skipped days', async () => {
  const calls = [];
  const handler = createHandler(async (name, args) => { calls.push({ name, args }); return { data: { status: 'imported', records: args.p_days.length } }; });
  const request = body => new Request('https://example.com', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wedx_' + 'a'.repeat(64) }, body: JSON.stringify(body) });
  const body = payload(); body.energySamples.push(sample('2026-10-20', 600, 'kcal'));
  const first = await handler(request(body));
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).skippedDays, ['2026-10-20']);
  body.energySamples[1].value = 100;
  await handler(request(body));
  assert.equal(calls[1].args.p_days[0].caloriesKcal, 1100);
  assert.notEqual(calls[0].args.p_request_id, calls[1].args.p_request_id);
  assert.equal(JSON.stringify(calls).includes('energySamples'), false);
  const empty = await handler(request(payload({ energySamples: [], proteinSamples: [] })));
  assert.equal((await empty.json()).status, 'no_data');
  assert.equal(calls.length, 2);
  const invalid = await handler(request(payload({ proteinSamples: [sample('2026-10-21', 20, 'unknown')] })));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).message, /единица/);
  assert.equal(calls.length, 2);
});
