import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { workout, ownerA, ownerB, nutrition } from './fixtures.js';

let db;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    insert into auth.users values('${ownerA}'),('${ownerB}');
  `);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(new URL(file, migrations), 'utf8'));
  }
});
after(async () => { await db?.close(); });
async function identity(id, role = 'authenticated') {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function save(state, revision) {
  return (await db.query('select public.save_workout_state($1::jsonb,$2,$3) result', [JSON.stringify(state), revision, ownerA])).rows[0].result;
}
const tokenHash = 'a'.repeat(64), payloadHash = 'b'.repeat(64);
async function ingest(request = nutrition.requestId, hash = payloadHash, days = nutrition.days) {
  return (await db.query('select public.ingest_nutrition($1,$2,$3,$4::jsonb) result', [tokenHash, request, hash, JSON.stringify(days)])).rows[0].result;
}

test('migration preserves the full legacy snapshot and projects only recorded sets', async () => {
  await identity(ownerA);
  assert.deepEqual(await save(workout, 0), { status: 'saved', revision: 1 });
  assert.deepEqual((await db.query('select snapshot from public.workout_state')).rows[0].snapshot, workout);
  assert.equal((await db.query('select * from public.exercise_history')).rows.length, 2);
  assert.equal((await db.query('select * from public.exercise_sets')).rows.length, 2);
  assert.equal(Number((await db.query('select weight_kg from public.body_measurements')).rows[0].weight_kg), 84.5);
});
test('RLS isolates owners; anon cannot read; authenticated cannot bypass the write RPC', async () => {
  await identity(ownerB);
  assert.equal((await db.query('select * from public.workout_state')).rows.length, 0);
  assert.equal((await db.query('select * from public.exercise_sets')).rows.length, 0);
  await assert.rejects(db.query('delete from public.workout_state'));
  await assert.rejects(save(workout, 0));
  await assert.rejects(db.query('insert into public.integration_tokens(user_id,label,source,token_hash) values($1,$2,$3,$4)', [ownerA, 'wrong owner', 'apple-health', 'f'.repeat(64)]));
  await identity('', 'anon');
  await assert.rejects(db.query('select * from public.workout_state'));
  await assert.rejects(save(workout, 0));
});
test('revision conflicts do not overwrite data; accepted edits keep a backup', async () => {
  await identity(ownerA);
  const edited = { ...workout, savedAt: 456 };
  assert.deepEqual(await save(edited, 0), { status: 'conflict', revision: 1 });
  assert.equal((await db.query('select snapshot from public.workout_state')).rows[0].snapshot.savedAt, 123);
  assert.deepEqual(await save(edited, 1), { status: 'saved', revision: 2 });
  assert.deepEqual((await db.query('select snapshot from public.workout_backups')).rows[0].snapshot, workout);
});
test('a malformed projection rolls back the state, backup and all tables', async () => {
  await identity(ownerA);
  await assert.rejects(save({ ...workout, bw: [{ d: 'invalid', w: 90 }] }, 2));
  assert.equal((await db.query('select revision from public.workout_state')).rows[0].revision, 2);
  assert.equal((await db.query('select * from public.workout_backups')).rows.length, 1);
  assert.equal((await db.query('select * from public.exercise_sets')).rows.length, 2);
});
test('integration token imports are scoped, idempotent, correctable and revocable', async () => {
  await identity(ownerA);
  await db.query('insert into public.integration_tokens(user_id,label,source,token_hash) values($1,$2,$3,$4)', [ownerA, 'iPhone', 'apple-health', tokenHash]);
  await assert.rejects(ingest());
  await identity('', 'service_role');
  assert.deepEqual(await ingest(), { status: 'imported', records: 1 });
  assert.deepEqual(await ingest(), { status: 'duplicate', records: 1 });
  await assert.rejects(ingest(nutrition.requestId, 'c'.repeat(64)));
  assert.deepEqual(await ingest('44444444-4444-4444-8444-444444444444', 'c'.repeat(64), [{ ...nutrition.days[0], caloriesKcal: 2300 }]), { status: 'imported', records: 1 });
  await identity(ownerB);
  assert.equal((await db.query('select * from public.nutrition_daily')).rows.length, 0);
  await identity(ownerA);
  const rows = (await db.query('select * from public.nutrition_daily')).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].calories_kcal), 2300);
  await db.query('delete from public.integration_tokens where token_hash=$1', [tokenHash]);
  await identity('', 'service_role');
  await assert.rejects(ingest());
});

test('new metrics survive legacy updates; ambiguous activity is cleared and targets are owner-isolated', async () => {
  await identity(ownerA);
  await db.query('insert into public.integration_tokens(user_id,label,source,token_hash) values($1,$2,$3,$4)', [ownerA, 'expanded', 'apple-health', tokenHash]);
  await db.query('insert into public.nutrition_goals(user_id,effective_from,base_calorie_goal,protein_goal_g) values($1,$2,2000,130)', [ownerA,'2026-10-21']);
  await identity('', 'service_role');
  const expanded = [{ ...nutrition.days[0], carbsGrams: 210.75, fatGrams: 0, activityStatus: 'verified', caloriesBurned: 159.5 }];
  await ingest('55555555-4444-4444-8444-444444444444', 'd'.repeat(64), expanded);
  await ingest('66666666-4444-4444-8444-444444444444', 'e'.repeat(64));
  await identity(ownerA);
  let row = (await db.query('select * from public.nutrition_daily')).rows[0];
  assert.equal(Number(row.carbs_grams), 210.75); assert.equal(Number(row.fat_grams), 0); assert.equal(Number(row.calories_burned), 159.5);
  assert.ok(row.metric_synced_at.carbs);
  await identity('', 'service_role');
  await ingest('77777777-4444-4444-8444-444444444444', 'f'.repeat(64), [{ ...nutrition.days[0], activityStatus: 'multiple_sources', caloriesBurned: null }]);
  await identity(ownerA);
  row = (await db.query('select * from public.nutrition_daily')).rows[0];
  assert.equal(row.calories_burned, null); assert.equal(row.activity_status, 'multiple_sources');
  assert.equal(Number(row.carbs_grams), 210.75);
  await identity(ownerB);
  assert.equal((await db.query('select * from public.nutrition_goals')).rows.length, 0);
  await assert.rejects(db.query('insert into public.nutrition_goals(user_id,effective_from,base_calorie_goal,protein_goal_g) values($1,$2,2000,130)',[ownerA,'2026-10-22']));
  await identity('', 'anon'); await assert.rejects(db.query('select * from public.nutrition_goals'));
});
