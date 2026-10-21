import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/health-import/handler.js';
import { nutrition } from './fixtures.js';

function request(body = nutrition, token = 'wedx_' + 'a'.repeat(64)) {
  return new Request('https://example.com/health-import', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
test('the public endpoint rejects unauthenticated, invalid and oversized imports before the DB', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; return {}; });
  assert.equal((await handler(request(nutrition, 'bad'))).status, 401);
  assert.equal((await handler(request({ ...nutrition, days: [nutrition.days[0], nutrition.days[0]] }))).status, 400);
  assert.equal((await handler(request({ ...nutrition, days: [{ ...nutrition.days[0], date: '2026-02-30' }] }))).status, 400);
  assert.equal((await handler(request({ ...nutrition, extra: 'x'.repeat(66000) }))).status, 413);
  assert.equal(calls, 0);
});
test('the endpoint hashes the secret token and passes only normalized daily values', async () => {
  let call;
  const handler = createHandler(async (name, args) => { call = { name, args }; return { data: { status: 'imported', records: 1 } }; });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(call.args.p_token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(call).includes('wedx_'));
  assert.deepEqual(call.args.p_days, nutrition.days);
});
test('revoked tokens, duplicate-id conflicts and rate limits return useful HTTP statuses', async () => {
  for (const [code, status] of [['28000', 401], ['23505', 409], ['P0001', 429]]) {
    const handler = createHandler(async () => ({ error: { code } }));
    assert.equal((await handler(request())).status, status);
  }
});
