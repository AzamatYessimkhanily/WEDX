import { test, expect } from '@playwright/test';
import { workout, ownerA, ownerB } from '../fixtures.js';

test('old phone history survives upgrade, editing a set and reloading', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(state => {
    if (!localStorage.getItem('test-seeded')) {
      localStorage.setItem('gym-log-v1', JSON.stringify(state));
      localStorage.setItem('test-seeded', '1');
    }
  }, workout);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Программа', exact: true })).toBeVisible();
  await page.locator('#days button').filter({ hasText: 'Пн' }).click();
  const row = page.locator('.ex').first().locator('.srow').first();
  await row.locator('input').nth(0).fill('30');
  await row.locator('input').nth(1).fill('8');
  await row.getByRole('button', { name: 'Подход 1 выполнен', exact: true }).click();
  await expect.poll(async () => {
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('gym-log-v1')));
    return state.hist['mon|0'].some(r => r.w === 30 && r.r === 8);
  }).toBe(true);
  await page.reload();
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('gym-log-v1')));
  expect(state.hist['mon|0'].find(r => r.d === '2026-09-21')).toEqual(workout.hist['mon|0'][0]);
  expect(state.bw).toEqual(workout.bw);
  expect(state.notes).toEqual(workout.notes);
  expect(await page.evaluate(() => Boolean(localStorage.getItem('gym-log-v1-before-v2')))).toBe(true);
  await page.getByRole('button', { name: 'Прогресс', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вес тела' })).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/progress-mobile.png', fullPage: true });
});

test('file import supports existing JSON backups without injecting personal seed data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Прогресс', exact: true }).click();
  await expect(page.getByText('Данных пока нет', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Тренировка', exact: true }).click();
  page.on('dialog', dialog => dialog.accept());
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Из файла', exact: true }).click();
  await (await chooser).setFiles({ name: 'old-wedx.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(workout)) });
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('gym-log-v1'))?.bw?.[0]?.w)).toBe(84.5);
});

test('the installed app reloads and records workouts offline', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Программа', exact: true })).toBeVisible();
  await page.locator('#days button').filter({ hasText: 'Пн' }).click();
  await page.locator('.chk').first().click();
  await expect.poll(async () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('gym-log-v1'))?.hist || {}).length)).toBeGreaterThan(0);
  await context.setOffline(false);
});

test('account login syncs workouts and switching accounts does not upload another owner’s history', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const states = new Map(); let owner = ownerA;
  await page.route('http://127.0.0.1:54321/**', async route => {
    const { pathname } = new URL(route.request().url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/auth/v1/token') {
      owner = route.request().postDataJSON().email === 'a@example.com' ? ownerA : ownerB;
      const user = { id: owner, aud: 'authenticated', role: 'authenticated', email: owner === ownerA ? 'a@example.com' : 'b@example.com', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} };
      return json({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', token_type: 'bearer', expires_in: 3600, user });
    }
    if (pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (pathname === '/rest/v1/workout_state') return json(states.has(owner) ? [states.get(owner)] : []);
    if (pathname === '/rest/v1/rpc/save_workout_state') {
      const args = route.request().postDataJSON();
      const revision = states.get(owner)?.revision || 0;
      if (revision !== args.p_expected_revision) return json({ status: 'conflict', revision });
      states.set(owner, { snapshot: args.p_snapshot, revision: revision + 1 });
      return json({ status: 'saved', revision: revision + 1 });
    }
    return json([]);
  });
  await page.addInitScript(state => localStorage.setItem('gym-log-v1', JSON.stringify(state)), workout);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('a@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('[data-sync-status]')).toHaveText('Сохранено в облаке и в устройстве');
  expect(states.get(ownerA).snapshot.hist['mon|0']).toHaveLength(2);
  await page.getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('b@example.com');
  await page.getByLabel('Пароль', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.locator('[data-sync-status]')).toHaveText('Сохранено в облаке и в устройстве');
  expect(states.get(ownerB).snapshot.hist).toEqual({});
  expect(states.get(ownerA).snapshot.hist['mon|0']).toHaveLength(2);
  expect(errors).toEqual([]);
  await page.locator('summary').filter({ hasText: 'Подключения и питание' }).click();
  await expect(page.getByRole('heading', { name: 'Invictus', exact: true })).toBeVisible();
  await page.locator('[data-cloud-box]').screenshot({ path: 'test-results/connections-mobile.png' });
});
