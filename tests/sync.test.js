import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine } from '../src/data/sync-engine.js';
import { parseState, stateContent } from '../src/domain/state.js';
import { workout } from './fixtures.js';

function harness({ local = workout, remote = null, meta = null, read, write } = {}) {
  let state = structuredClone(local), server = structuredClone(remote), status, savedMeta = meta, writes = 0;
  const engine = createSyncEngine({
    getState: () => state, applyState: value => { state = structuredClone(value); },
    readRemote: read || (async () => server),
    writeRemote: write || (async (snapshot, revision) => { writes++; server = { snapshot, revision: revision + 1 }; return { status: 'saved', revision: revision + 1 }; }),
    loadMeta: () => savedMeta, saveMeta: value => { savedMeta = value; }, status: value => { status = value; },
  });
  return { engine, get state() { return state; }, set state(value) { state = value; }, get status() { return status; }, get writes() { return writes; }, get server() { return server; }, get meta() { return savedMeta; } };
}
test('legacy state roundtrip retains all history, gym and unknown future fields', () => {
  const input = { ...workout, future: { preserved: true } };
  assert.deepEqual(parseState(JSON.stringify(input)), input);
  assert.throws(() => parseState('{"hist":{"mon|0":[{"d":"2026-02-30"}]}}'));
});
test('PostgreSQL jsonb key ordering does not create false edits or conflicts', async () => {
  const reordered = JSON.parse(JSON.stringify(workout, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, value[key]])) : value));
  assert.equal(stateContent(workout), stateContent(reordered));
  const h = harness({ remote: { snapshot: reordered, revision: 1 } });
  await h.engine.sync();
  assert.equal(h.status, 'saved'); assert.equal(h.writes, 0);
});
test('first upload migrates local history once; reload does not duplicate it', async () => {
  const h = harness(); await h.engine.sync(); await h.engine.sync();
  assert.equal(h.writes, 1); assert.equal(h.status, 'saved');
  assert.deepEqual(h.server.snapshot, workout);
});
test('technique edits roundtrip through sync and reach a second device with sparse sets intact', async () => {
  const local = structuredClone(workout);
  local.hist['mon|0'][1].q = [{ clean: 8 }, null, { score: 5, clean: 9 }];
  const first = harness({ local }); await first.engine.sync();
  const second = harness({ local: { hist: {} }, remote: first.server }); await second.engine.sync();
  assert.deepEqual(second.state.hist, local.hist);
  assert.equal(second.status, 'saved');
  second.state.hist['mon|0'][1].q[0] = { clean: 10 };
  await second.engine.sync();
  assert.deepEqual(second.server.snapshot.hist['mon|0'][1].q, [{ clean: 10 }, null, { score: 5, clean: 9 }]);
});
test('two existing differing copies require resolution, with no automatic overwrite', async () => {
  const remote = { snapshot: { ...workout, bw: [{ d: '2026-10-20', w: 83 }] }, revision: 3 };
  const h = harness({ remote }); await h.engine.sync();
  assert.equal(h.status, 'conflict'); assert.equal(h.writes, 0);
  assert.deepEqual(h.state, workout);
  await h.engine.resolve('remote');
  assert.deepEqual(h.state, remote.snapshot); assert.equal(h.status, 'saved');
});
test('edits during remote fetch cannot be overwritten by a newer remote copy', async () => {
  let finish;
  const h = harness({ meta: { revision: 1, baseline: stateContent(workout) }, read: () => new Promise(resolve => { finish = resolve; }) });
  const pending = h.engine.sync();
  h.state = { ...workout, bw: [{ d: '2026-10-20', w: 86 }] };
  finish({ snapshot: { ...workout, bw: [{ d: '2026-10-20', w: 82 }] }, revision: 2 });
  await pending;
  assert.equal(h.status, 'conflict'); assert.equal(h.state.bw[0].w, 86);
});
test('offline edits survive and reconnect uses the last acknowledged revision', async () => {
  let unavailable = true;
  const h = harness({ read: async () => { if (unavailable) throw new Error('offline'); return null; } });
  await h.engine.sync(); assert.equal(h.status, 'offline'); assert.deepEqual(h.state, workout);
  unavailable = false; await h.engine.sync(); assert.equal(h.status, 'saved');
});
test('a stopped account cannot apply in-flight remote results after logout', async () => {
  let finish;
  const h = harness({ local: { hist: {} }, read: () => new Promise(resolve => { finish = resolve; }) });
  const request = h.engine.sync(); h.engine.stop(); finish({ snapshot: workout, revision: 1 }); await request;
  assert.deepEqual(h.state, { hist: {} });
});
