import { test, expect } from '@playwright/test';
import { ownerA, ownerB } from '../fixtures.js';

async function connect(page) {
  const state = {
    owner: ownerA, requests: [], fail: false, hold: null,
    days: [{ day: '2026-10-21', calories_kcal: 2100, protein_grams: 150, updated_at: '2026-10-22T07:00:00Z' }],
  };
  await page.clock.install({ time: new Date('2026-10-22T07:00:00Z') });
  await page.route('http://127.0.0.1:54321/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/auth/v1/verify') {
      state.owner = route.request().postDataJSON().token_hash === 'a'.repeat(64) ? ownerA : ownerB;
      return json({ access_token: 'mock', refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: 3600,
        user: { id: state.owner, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} } });
    }
    if (pathname === '/rest/v1/rpc/save_workout_state') return json({ status: 'saved', revision: 1 });
    if (pathname === '/rest/v1/nutrition_daily') {
      state.requests.push(Object.fromEntries(searchParams));
      const days = structuredClone(state.days);
      if (state.hold) { const hold = state.hold; state.hold = null; await hold; }
      return state.fail ? json({ message: 'temporarily unavailable' }, 400) : json(days);
    }
    return json([]);
  });
  await page.goto('/?view=health#connect=' + 'a'.repeat(64));
  await page.getByRole('button', { name: 'Подключить это устройство', exact: true }).click();
  await expect(page.locator('.nutrition-day')).toContainText('2 100 ккал');
  await expect(page.locator('.nutrition-status')).toContainText('автоматически');
  return state;
}

test('nutrition loads without a button and picks up new imports and corrections while open', async ({ page }) => {
  const state = await connect(page);
  state.days[0].calories_kcal = 2300;
  state.days[0].protein_grams = 160;
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-day')).toContainText('2 300 ккал');
  await expect(page.locator('.nutrition-day')).toContainText('160 г белка');
  state.days[0].calories_kcal = 2000; // Correcting an existing day replaces its value.
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-day')).toHaveCount(1);
  await expect(page.locator('.nutrition-day')).toContainText('2 000 ккал');
  expect(state.requests.every(query => query.user_id === `eq.${ownerA}` && query.limit === '8')).toBe(true);
});

test('offline and server failures preserve displayed days and recover automatically', async ({ page, context }) => {
  const state = await connect(page);
  state.fail = true;
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-status')).toContainText('повторим автоматически');
  await expect(page.locator('.nutrition-day')).toContainText('2 100 ккал');
  await context.setOffline(true);
  await expect(page.locator('.nutrition-status')).toContainText('Нет интернета');
  const requests = state.requests.length;
  await page.clock.runFor(45_000);
  expect(state.requests.length).toBe(requests);
  state.fail = false; state.days[0].calories_kcal = 2450;
  await context.setOffline(false);
  await expect(page.locator('.nutrition-day')).toContainText('2 450 ккал');
  await expect(page.locator('.nutrition-status')).toContainText('автоматически');
});

test('returning to the app refreshes immediately and background polling pauses', async ({ page }) => {
  const state = await connect(page);
  await page.evaluate(() => {
    window.testVisibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.testVisibility });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const requests = state.requests.length;
  await page.clock.runFor(45_000);
  expect(state.requests.length).toBe(requests);
  state.days[0].protein_grams = 175;
  await page.evaluate(() => { window.testVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.nutrition-day')).toContainText('175 г белка');
  state.days[0].protein_grams = 180;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.nutrition-day')).toContainText('180 г белка');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  state.days[0].protein_grams = 185;
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.locator('.nutrition-day')).toContainText('185 г белка');
});

test('an old request cannot overwrite another account after the panel is replaced', async ({ page }) => {
  const state = await connect(page);
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  state.days[0].calories_kcal = 9999;
  const before = state.requests.length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => state.requests.length).toBe(before + 1);
  // More resume events must not start overlapping requests for this panel.
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pageshow')); });
  expect(state.requests.length).toBe(before + 1);
  state.days = [{ day: '2026-10-22', calories_kcal: 1700, protein_grams: 120, updated_at: '2026-10-22T07:00:00Z' }];
  await page.evaluate(() => { location.hash = '#connect=' + 'b'.repeat(64); });
  await page.getByRole('button', { name: 'Подключить это устройство', exact: true }).click();
  await expect.poll(() => state.owner).toBe(ownerB);
  await expect(page.locator('.nutrition-day')).toContainText('1 700 ккал');
  release();
  const after = state.requests.length;
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-day')).not.toContainText('9 999');
  expect(state.requests.slice(after).every(query => query.user_id === `eq.${ownerB}`)).toBe(true);
  expect(state.requests.length - after).toBe(1); // Removed panels no longer poll.
});
