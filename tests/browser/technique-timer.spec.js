import { test, expect } from '@playwright/test';

const previous = { d: '2026-10-20', w: 20, r: 8, v: 640, n: 4,
  s: [[20, 8], [20, 8], [20, 8], [20, 8]], q: Array.from({ length: 4 }, () => ({ score: 3, clean: 6 })) };
const seed = { hist: { 'mon|0': [previous] }, log: {}, last: {}, done: {} };
async function setup(page, state = seed) {
  await page.clock.install({ time: new Date('2026-10-27T10:00:00Z') });
  await page.addInitScript(state => {
    if (!localStorage.getItem('test-seeded')) {
      localStorage.setItem('gym-log-v1', JSON.stringify(state)); localStorage.setItem('test-seeded', '1');
    }
  }, state);
  await page.goto('/');
  await page.locator('#days button').filter({ hasText: 'Пн' }).click();
}
const first = page => page.locator('.ex').first().locator('.sset').first();
const plank = page => page.locator('.ex[data-i="7"]');
async function saved(page) { await page.clock.runFor(400); return page.evaluate(() => JSON.parse(localStorage.getItem('gym-log-v1'))); }

test('technique, clean repetitions and progress survive reload and historical edits without changing old data', async ({ page }) => {
  await setup(page);
  await expect(page.locator('.ex').first().locator('.ready')).toContainText('Сначала закрепи технику');
  let set = first(page);
  await set.getByRole('spinbutton').nth(0).fill('20');
  await set.getByRole('spinbutton').nth(1).fill('8');
  await set.getByRole('button', { name: 'Подход 1 выполнен', exact: true }).click();
  await expect(set.locator('.quality-scale')).toHaveCount(0);
  await expect(set.locator('summary')).toContainText('Не отмечено');
  await set.getByRole('button', { name: 'Всё чисто', exact: true }).click();
  await set.getByRole('slider', { name: 'Чистые повторы' }).press('ArrowLeft');
  await expect(set.getByRole('slider', { name: 'Чистые повторы' })).toHaveValue('7');
  await set.getByRole('slider', { name: 'Чистые повторы' }).press('ArrowLeft');
  await expect(set.getByRole('slider', { name: 'Чистые повторы' })).toHaveValue('6');
  await set.getByRole('slider', { name: 'Чистые повторы' }).press('ArrowRight');
  await expect(set.locator('.srow')).toHaveAttribute('data-improvement', 'Техника лучше');
  const state = await saved(page);
  expect(state.hist['mon|0'].at(-1).q).toEqual([{ clean: 7 }]);
  expect(state.hist['mon|0'][0].q).toEqual(previous.q);
  await page.reload();
  await page.locator('#days button').filter({ hasText: 'Пн' }).click();
  set = first(page);
  await expect(page.getByRole('button', { name: /из 5/ })).toHaveCount(0);
  await expect(set.locator('summary')).toContainText('Чисто 7 из 8');
  await page.getByRole('button', { name: 'Прогресс', exact: true }).click();
  await expect(page.getByText('техника при той же или большей нагрузке', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Верх A', exact: true }).click();
  await expect(page.getByText('Техника лучше ↑', { exact: true })).toBeVisible();
  await page.locator('.phead').first().click();
  await page.getByRole('button', { name: 'Техника', exact: true }).click();
  await expect(page.locator('.chart-value')).toHaveText('87.5 % чисто');
  await page.getByRole('button', { name: 'Тренировка', exact: true }).click();
  await page.getByLabel('Дата тренировки').fill('2026-10-20');
  await first(page).locator('summary').click();
  await first(page).getByRole('button', { name: 'Всё чисто', exact: true }).click();
  expect((await saved(page)).hist['mon|0'][0].q[0]).toEqual({ clean: 8 });
  await page.locator('#skip').click();
  await page.clock.runFor(2000);
  await page.setViewportSize({ width: 320, height: 800 });
  await first(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/technique-mobile.png', scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('clean counts can be zero, edited with repetitions, or cleared without a default assessment', async ({ page }) => {
  await setup(page, { hist: {} });
  const set = first(page);
  await set.getByRole('spinbutton').nth(1).fill('8');
  await set.getByRole('button', { name: 'Подход 1 выполнен', exact: true }).click();
  expect((await saved(page)).hist['mon|0'][0].q).toBeUndefined();
  await set.getByRole('slider', { name: 'Чистые повторы' }).press('Home');
  expect((await saved(page)).hist['mon|0'][0].q).toEqual([{ clean: 0 }]);
  await set.getByRole('button', { name: 'Всё чисто', exact: true }).click();
  await set.getByRole('spinbutton').nth(1).fill('6');
  await expect(set.locator('summary')).toContainText('Чисто 6 из 6');
  expect((await saved(page)).hist['mon|0'][0].q).toEqual([{ clean: 6 }]);
  await set.getByRole('button', { name: 'Убрать отметку', exact: true }).click();
  await expect(set.locator('summary')).toContainText('Не отмечено');
  expect((await saved(page)).hist['mon|0'][0].q).toBeUndefined();
});

test('working timer pauses, survives reload, finishes and transfers seconds only on request', async ({ page }) => {
  await setup(page, { hist: {} });
  await plank(page).getByRole('button', { name: 'Таймер подхода 1', exact: true }).click();
  await expect(page.locator('#clock')).toHaveText('0:40');
  await expect(page.locator('#add30')).toBeHidden();
  await page.clock.runFor(10000);
  await page.locator('#work-pause').click();
  await page.screenshot({ path: 'test-results/set-timer-mobile.png', scale: 'css' });
  await page.clock.runFor(10000);
  await expect(page.locator('#clock')).toHaveText('0:30');
  await page.reload();
  await expect(page.locator('#tlbl')).toHaveText('Подход · пауза');
  await page.locator('#work-pause').click();
  await page.clock.runFor(30000);
  await expect(page.locator('#clock')).toHaveText('0:00');
  await expect(page.locator('#work-save')).toHaveText('Записать 40 сек');
  expect((await saved(page)).hist['mon|7']).toBeUndefined();
  await page.locator('#work-save').click();
  await expect(plank(page).getByLabel('Секунды в подходе 1')).toHaveValue('40');
  await expect(page.locator('#dock')).toBeHidden();
  await plank(page).getByRole('button', { name: 'Подход 1 выполнен', exact: true }).click();
  await expect(page.locator('#tlbl')).toHaveText('Отдых');
  await expect(page.locator('#add30')).toBeVisible();
  expect((await saved(page)).hist['mon|7'][0].s).toEqual([[0, 40]]);
});

test('timer records an early stop, replaces rest, cancels without recording, and is disabled for past dates', async ({ page }) => {
  await setup(page, { hist: {} });
  await first(page).getByRole('button', { name: 'Подход 1 выполнен', exact: true }).click();
  await plank(page).getByRole('button', { name: 'Таймер подхода 2', exact: true }).click();
  await page.clock.runFor(5000);
  await page.locator('#work-save').click();
  await expect(plank(page).getByLabel('Секунды в подходе 2')).toHaveValue('5');
  await plank(page).getByRole('button', { name: 'Таймер подхода 1', exact: true }).click();
  await page.clock.runFor(5000);
  await page.locator('#work-reset').click();
  await expect(page.locator('#clock')).toHaveText('0:40');
  await page.locator('#work-cancel').click();
  await expect(plank(page).getByLabel('Секунды в подходе 1')).toHaveValue('');
  await page.getByLabel('Дата тренировки').fill('2026-10-20');
  await expect(page.locator('.set-timer-start')).toHaveCount(0);
});
