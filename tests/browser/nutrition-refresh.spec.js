import { test, expect } from '@playwright/test';
import { ownerA, ownerB } from '../fixtures.js';

async function connect(page, { time = '2026-10-22T07:00:00Z', sessionSeconds = 3600 } = {}) {
  await page.addInitScript(() => localStorage.setItem('gym-log-v1', JSON.stringify({
    hist: {}, bw: [{ d: '2026-10-01', w: 80 }, { d: '2026-10-22', w: 100 }],
  })));
  const state = {
    owner: ownerA, requests: [], fail: false, hold: null, goals: [], goalWrites: [],
    days: [{ day: '2026-10-21', calories_kcal: 2100, protein_grams: 150, updated_at: '2026-10-22T07:00:00Z' }],
  };
  await page.clock.install({ time: new Date(time) });
  await page.route('http://127.0.0.1:54321/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/auth/v1/verify') {
      state.owner = route.request().postDataJSON().token_hash === 'a'.repeat(64) ? ownerA : ownerB;
      return json({ access_token: 'mock', refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: sessionSeconds,
        user: { id: state.owner, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} } });
    }
    if (pathname === '/rest/v1/rpc/save_workout_state') return json({ status: 'saved', revision: 1 });
    if (pathname === '/rest/v1/nutrition_goals') {
      if (route.request().method() === 'POST') { const goal = route.request().postDataJSON(); state.goalWrites.push(goal); state.goals.push(goal); return json(null); }
      return json(state.goals);
    }
    if (pathname === '/rest/v1/nutrition_daily') {
      state.requests.push(Object.fromEntries(searchParams));
      const offset = Number(searchParams.get('offset') || 0), limit = Number(searchParams.get('limit') || 1000);
      const days = structuredClone(state.days).sort((a, b) => b.day.localeCompare(a.day)).slice(offset, offset + limit);
      if (state.hold) { const hold = state.hold; state.hold = null; await hold; }
      return state.fail ? json({ message: 'temporarily unavailable' }, 400) : json(days);
    }
    return json([]);
  });
  await page.goto('/?view=health#connect=' + 'a'.repeat(64));
  await page.getByRole('button', { name: 'Подключить это устройство', exact: true }).click();
  await expect(page.locator('.nutrition-day')).toContainText('2 100 ккал');
  await expect(page.locator('.nutrition-status')).toBeHidden();
  return state;
}

test('nutrition loads without a button and picks up new imports and corrections while open', async ({ page }) => {
  const state = await connect(page);
  state.days[0].calories_kcal = 2300;
  state.days[0].protein_grams = 160;
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-day')).toContainText('2 300 ккал');
  await expect(page.locator('.nutrition-day')).toContainText('160 г');
  state.days[0].calories_kcal = 2000; // Correcting an existing day replaces its value.
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-day')).toHaveCount(1);
  await expect(page.locator('.nutrition-day')).toContainText('2 000 ккал');
  expect(state.requests.every(query => query.user_id === `eq.${ownerA}`)).toBe(true);
});

test('the whole October stays selectable after new November imports', async ({ page }) => {
  const state = await connect(page, { time: '2026-10-31T07:00:00Z', sessionSeconds: 40 * 86400 });
  state.days = Array.from({ length: 31 }, (_, i) => ({ day: `2026-10-${String(31 - i).padStart(2, '0')}`,
    calories_kcal: 1800 + i, protein_grams: 150, calories_burned: 549, activity_status: 'verified' }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const day = date => page.locator(`.nutrition-calendar-day[data-date="${date}"]`);
  const row = page.locator('.nutrition-day');
  await expect(row).toHaveAttribute('data-day', '2026-10-31');
  await expect(page.locator('.nutrition-calendar-day:enabled')).toHaveCount(31);
  await day('2026-10-01').click();
  await expect(row).toHaveAttribute('data-day', '2026-10-01');
  await expect(row).toContainText('1 830 ккал');
  await page.clock.setSystemTime(new Date('2026-11-01T07:00:00Z'));
  state.days.unshift({ ...state.days[0], day: '2026-11-01', calories_kcal: 1900 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row).toHaveAttribute('data-day', '2026-10-01');
  await page.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
  await expect(row).toHaveAttribute('data-day', '2026-11-01');
  await page.getByRole('button', { name: 'Предыдущий месяц', exact: true }).click();
  await expect(day('2026-10-01')).toBeEnabled();
  await expect(page.locator('.nutrition-calendar-day:enabled')).toHaveCount(31);
});

test('missing remaining calories explain the dated goal or activity gap and recalculate after correction', async ({ page }) => {
  const state = await connect(page);
  state.goals = [{ effective_from: '2026-10-16', base_calorie_goal: 2018, include_activity: true }];
  const earlier = { day: '2026-10-01', calories_kcal: 1500, protein_grams: 100, calories_burned: 100, activity_status: 'verified' };
  state.days.push(earlier);
  await page.clock.runFor(15_100);
  await page.locator('.nutrition-calendar-day[data-date="2026-10-01"]').click();
  const remaining = page.locator('.nutrition-remaining .metric-value');
  const explanation = page.locator('.nutrition-explanation');
  await expect(remaining).toHaveText('—');
  await expect(explanation).toContainText('норма, действовавшая в эту дату');
  // An explicit earlier goal fixes the gap; a later goal must not fill it silently.
  const historical = { effective_from: '2026-10-01', base_calorie_goal: 2200, include_activity: true };
  state.goals.push(historical);
  await page.clock.runFor(15_100);
  await expect(remaining).toHaveText('800');
  await expect(explanation).toHaveCount(0);
  earlier.calories_burned = null; earlier.activity_status = 'no_data';
  await page.clock.runFor(15_100);
  await expect(remaining).toHaveText('—');
  await expect(explanation).toContainText('данные об активности');
  historical.include_activity = false;
  await page.clock.runFor(15_100);
  await expect(remaining).toHaveText('700');
  await expect(explanation).toHaveCount(0);
});

test('offline and server failures preserve displayed days and recover automatically', async ({ page, context }) => {
  const state = await connect(page);
  state.fail = true;
  await page.clock.runFor(15_100);
  await expect(page.locator('.nutrition-status')).toContainText('Повторим автоматически');
  await expect(page.locator('.nutrition-day')).toContainText('2 100 ккал');
  await context.setOffline(true);
  await expect(page.locator('.nutrition-status')).toContainText('Нет интернета');
  const requests = state.requests.length;
  await page.clock.runFor(45_000);
  expect(state.requests.length).toBe(requests);
  state.fail = false; state.days[0].calories_kcal = 2450;
  await context.setOffline(false);
  await expect(page.locator('.nutrition-day')).toContainText('2 450 ккал');
  await expect(page.locator('.nutrition-status')).toBeHidden();
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
  await expect(page.locator('.nutrition-day')).toContainText('175 г');
  state.days[0].protein_grams = 180;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.nutrition-day')).toContainText('180 г');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  state.days[0].protein_grams = 185;
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect(page.locator('.nutrition-day')).toContainText('185 г');
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


test('nutrition dashboard exposes seven metrics, hides setup and retains dated goal controls on mobile', async ({ page }) => {
  const state = await connect(page);
  state.days[0] = { ...state.days[0], carbs_grams: 190.5, fat_grams: 45.25,
    calories_burned: 200, activity_status: 'verified', nutrition_origin: 'apple-health', metric_synced_at: { carbs: '2026-10-22T07:00:00Z' } };
  await page.clock.runFor(15_100);
  const row = page.locator('.nutrition-day');
  await expect(row.locator('dt')).toHaveCount(7);
  for (const metric of await row.locator('dt').all()) await expect(metric).toBeVisible();
  await expect(page.getByRole('link', { name: 'Установить команду', exact: true })).toBeHidden();
  await expect(row).toContainText('190,5 г'); await expect(row).toContainText('45,3 г');
  await expect(row).toContainText('200 ккал'); await expect(row).toContainText('Дневная норма не задана');
  await page.getByText('Настройки', { exact: true }).click();
  await page.getByText('Настроить норму', { exact: true }).click();
  await page.getByLabel('Действует с даты').fill('2026-10-21');
  await page.getByLabel('Дневная норма без активности, ккал').fill('2000');
  await expect(page.getByLabel('Белок, г на кг веса')).toHaveValue('2');
  await page.getByLabel('Белок, г на кг веса').fill('1.6');
  await page.getByLabel('Прибавлять активность к дневной норме').check();
  await page.getByRole('button', { name: 'Сохранить норму', exact: true }).click();
  await expect(page.getByText('Норма сохранена.', { exact: true })).toBeVisible();
  expect(state.goalWrites[0].user_id).toBe(ownerA);
  expect(state.goalWrites[0].protein_per_kg).toBe(1.6);
  await expect(row.locator('.nutrition-protein')).toContainText('150 / 128 г');
  await expect(row).toContainText('2 000 ккал'); await expect(row).toContainText('100 ккал');
  await expect(row.locator('dt')).toHaveCount(7);
  await expect(page.getByLabel('Цель белка, г', { exact: true })).toHaveCount(0);
  state.days[0].activity_status = 'multiple_sources'; state.days[0].calories_burned = null;
  await page.clock.runFor(15_100);
  await expect(row).toContainText('несколько источников активности');
  await expect(row).not.toContainText('2 200 ккал');
  await page.getByText('Настройки', { exact: true }).click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  state.days[0].activity_status = 'health_total'; state.days[0].calories_burned = 200;
  await page.clock.runFor(15_100);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/nutrition-clean-mobile.png', fullPage: true });
});

test('calendar selects real days, keeps selection on sync, marks calorie and protein status and navigates months', async ({ page }) => {
  const state = await connect(page);
  state.goals = [{ effective_from: '2026-09-01', base_calorie_goal: 2018, include_activity: true, protein_per_kg: 2 }];
  state.days = Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-${22 - i}`, calories_kcal: 2000, protein_grams: 170,
    carbs_grams: 210, fat_grams: 70, calories_burned: 200, activity_status: 'verified', updated_at: '2026-10-22T07:00:00Z' }));
  state.days[0].protein_grams = 50;
  state.days[2].calories_kcal = 2500;
  state.days[3].protein_grams = 120;
  state.days[4].protein_grams = 120; state.days[4].calories_kcal = 2500;
  await page.clock.runFor(15_100);
  const day = date => page.locator(`.nutrition-calendar-day[data-date="${date}"]`);
  const row = page.locator('.nutrition-day');
  await expect(day('2026-10-21')).toHaveAccessibleName(/В пределах калорий, белок набран/);
  await expect(day('2026-10-20')).toHaveAccessibleName(/Перебор калорий/);
  await expect(day('2026-10-19')).toHaveAccessibleName(/Мало белка/);
  await expect(day('2026-10-18')).toHaveAccessibleName(/Перебор калорий, мало белка/);
  await expect(day('2026-10-22')).toHaveAccessibleName(/День ещё идёт/);
  await expect(day('2026-10-22').locator('.protein-mark')).toHaveCount(0);
  await expect(day('2026-10-14')).toBeDisabled();
  await expect(day('2026-10-23')).toBeDisabled();
  await day('2026-10-19').click();
  await expect(day('2026-10-19')).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toHaveAttribute('data-day', '2026-10-19');
  await expect(row.locator('.nutrition-protein')).toContainText('Недобор 40 г');
  state.days[3].protein_grams = 165;
  await page.clock.runFor(15_100);
  await expect(row).toHaveAttribute('data-day', '2026-10-19');
  await expect(row.locator('.nutrition-protein')).toContainText('Цель набрана');
  await expect(day('2026-10-19')).toHaveAccessibleName(/В пределах калорий, белок набран/);
  await expect(day('2026-10-19')).toBeFocused();
  await day('2026-10-22').click();
  await expect(row.locator('.nutrition-protein')).toContainText('50 / 200 г');
  await expect(row.locator('.nutrition-protein')).toContainText('Ещё 150 г');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/nutrition-calendar-mobile.png', scale: 'css' });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/nutrition-calendar-narrow.png', scale: 'css' });
  state.days[7].day = '2026-09-30';
  await page.clock.runFor(15_100);
  await page.getByRole('button', { name: 'Предыдущий месяц', exact: true }).click();
  await expect(day('2026-09-30')).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toHaveAttribute('data-day', '2026-09-30');
  await expect(row.locator('.nutrition-protein')).toContainText('добавь замер веса');
  await expect(page.getByRole('button', { name: 'Предыдущий месяц', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
  await expect(row).toHaveAttribute('data-day', '2026-10-22');
});

test('unfiltered activity prompts an update, then a corrected Watch import replaces it', async ({ page }) => {
  const state = await connect(page);
  state.goals = [{ effective_from: '2026-10-01', base_calorie_goal: 2018, include_activity: true }];
  Object.assign(state.days[0], { calories_burned: 775, activity_status: 'health_total' });
  await page.clock.runFor(15_100);
  const activity = page.locator('.nutrition-metric').filter({ has: page.locator('dt', { hasText: /^Активность$/ }) });
  await expect(activity.locator('.metric-value')).toHaveText('—');
  await expect(page.getByRole('link', { name: 'Обновить команду', exact: true })).toBeVisible();
  Object.assign(state.days[0], { calories_burned: 549, activity_status: 'verified' });
  await page.clock.runFor(15_100);
  await expect(activity.locator('.metric-value')).toHaveText('549');
  await expect(page.locator('.nutrition-remaining .metric-value')).toHaveText('467');
  await expect(page.getByRole('link', { name: 'Обновить команду', exact: true })).toHaveCount(0);
});
