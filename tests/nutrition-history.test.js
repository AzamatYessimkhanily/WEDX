import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNutritionHistory } from '../src/data/nutrition-history.js';

function server(days, failAfter = Infinity) {
  const requests = [];
  return { requests, from() {
    const request = {}; requests.push(request);
    const query = {
      select() { return query; },
      eq(column, value) { request[column] = value; return query; },
      order() { return query; },
      range(from, to) { Object.assign(request, { from, to }); return query; },
      async abortSignal(signal) {
        request.signal = signal;
        if (request.from >= failAfter) return { error: new Error('offline'), data: null };
        return { error: null, data: days.slice(request.from, request.to + 1) };
      },
    };
    return query;
  } };
}

test('nutrition history includes older pages with the same owner and cancellation signal', async () => {
  const days = Array.from({ length: 531 }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 31 - i)).toISOString().slice(0, 10) }));
  const client = server(days), signal = new AbortController().signal;
  const result = await loadNutritionHistory(client, 'owner-a', signal);
  assert.deepEqual(result, { data: days, error: null });
  assert.equal(client.requests.length, 2);
  assert.ok(client.requests.every(r => r.user_id === 'owner-a' && r.signal === signal));
  assert.equal(client.requests[1].from, client.requests[0].to + 1);
});

test('a failed later page never replaces the calendar with partial history', async () => {
  const client = server(Array(501).fill({ day: '2026-10-01' }), 500);
  const result = await loadNutritionHistory(client, 'owner-a', new AbortController().signal);
  assert.equal(result.data, null);
  assert.match(result.error.message, /offline/);
  const cancelled = new AbortController(); cancelled.abort();
  const unused = server([]);
  await assert.rejects(loadNutritionHistory(unused, 'owner-b', cancelled.signal), { name: 'AbortError' });
  assert.equal(unused.requests.length, 0);
});
