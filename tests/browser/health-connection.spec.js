import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { ownerA } from '../fixtures.js';

test('Apple Health is reachable on a rest day before connecting the device', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-22T12:00:00+05:00'));
  const requests = [];
  await page.route('http://127.0.0.1:54321/**', route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/');
  await page.locator('#days button').filter({ hasText: 'Чт' }).click();
  await expect(page.getByText('День отдыха', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('button', { name: 'Apple Health', exact: true }).click();
  await expect(page.getByText('Подключить Apple Health', { exact: true })).toBeVisible();
  await expect(page.getByText(/Сначала подключи этот iPhone/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Создать ключ для iPhone' })).toHaveCount(0);
  expect(requests.filter(url => url.includes('/rest/'))).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Тренировка', exact: true }).click();
  await expect(page.getByText('День отдыха', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apple Health', exact: true }).click();
  await page.reload();
  await expect(page.getByText(/Сначала подключи этот iPhone/)).toBeVisible();
  await page.screenshot({ path: 'test-results/health-unlinked-mobile.png' });
  await page.getByRole('button', { name: 'Тренировка', exact: true }).click();
  await page.getByRole('button', { name: 'Прогресс', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Обзор', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apple Health', exact: true }).click();
  await expect(page.getByText(/Сначала подключи этот iPhone/)).toBeVisible();
});

test('iPhone setup installs a public template, scopes the secret to nutrition, and shows imported days', async ({ page, request }) => {
  const tokens = []; let showNutrition = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedKey = text; } } });
  });
  await page.route('http://127.0.0.1:54321/**', async route => {
    const { pathname } = new URL(route.request().url());
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname === '/auth/v1/verify') return json({ access_token: 'mock', refresh_token: 'mock-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: ownerA, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString(), app_metadata: {}, user_metadata: {} } });
    if (pathname === '/rest/v1/rpc/save_workout_state') return json({ status: 'saved', revision: 1 });
    if (pathname === '/rest/v1/integration_tokens') {
      if (route.request().method() === 'POST') {
        tokens.push({ id: 'connection-1', created_at: new Date().toISOString(), ...route.request().postDataJSON() }); return json(null);
      }
      if (route.request().method() === 'DELETE') { tokens.length = 0; return json(null); }
      return json(tokens);
    }
    if (pathname === '/rest/v1/nutrition_daily') return json(showNutrition ? [
      { day: '2026-10-21', calories_kcal: 2150.5, protein_grams: 153.25, updated_at: '2026-10-21T12:00:00Z' },
      { day: '2026-10-19', calories_kcal: 2000, protein_grams: 0, updated_at: '2026-10-21T12:00:00Z' },
    ] : []);
    return json([]);
  });
  await page.goto('/?view=health#connect=' + 'a'.repeat(64));
  await page.getByRole('button', { name: 'Подключить это устройство', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apple Health', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\?view=health$/);
  await expect(page.getByText(/Импортов пока нет/)).toBeVisible();
  const download = page.getByRole('link', { name: 'Установить команду', exact: true });
  const file = await request.get(await download.getAttribute('href'));
  expect(file.status()).toBe(200);
  expect((await file.body()).subarray(0, 4).toString()).toBe('AEA1');
  await page.getByRole('button', { name: 'Создать ключ для iPhone', exact: true }).click();
  const secret = await page.getByRole('textbox', { name: 'Ключ команды iPhone', exact: true }).inputValue();
  expect(secret).toMatch(/^wedx_[a-f0-9]{64}$/);
  expect(tokens[0].user_id).toBe(ownerA);
  expect(tokens[0].source).toBe('apple-health');
  expect(tokens[0].token_hash).toBe(createHash('sha256').update(secret).digest('hex'));
  expect(JSON.stringify(tokens)).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
  await page.getByRole('button', { name: 'Скопировать ключ', exact: true }).click();
  expect(await page.evaluate(() => window.copiedKey)).toBe(secret);
  await page.getByRole('button', { name: 'Скрыть ключ', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ключ команды iPhone', exact: true })).toHaveCount(0);
  showNutrition = true;
  await page.getByRole('button', { name: 'Обновить питание', exact: true }).click();
  await expect(page.locator('.nutrition-day')).toHaveCount(2); // The absent 20th is not manufactured as zero.
  await expect(page.locator('.nutrition-day').first()).toContainText('153,3 г белка');
  await expect(page.locator('.nutrition-day').last()).toContainText('0 г белка');
  await expect(page.getByText(/Последнее обновление:/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.integrations-panel').screenshot({ path: 'test-results/health-connection-mobile.png' });
  await page.getByRole('button', { name: 'Отозвать', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Отозвать', exact: true })).toHaveCount(0);
});
