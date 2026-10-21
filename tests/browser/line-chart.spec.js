import { test, expect } from '@playwright/test';
import { workout } from '../fixtures.js';

test('dense weight history stays readable and browsable on a narrow phone', async ({ page }) => {
  const bw = Array.from({ length: 240 }, (_, i) => ({
    d: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    w: Number((83.6 - i * .002 + .05 * Math.sin(i)).toFixed(2)),
  }));
  const initial = { ...workout, bw };
  await page.setViewportSize({ width: 320, height: 780 });
  await page.addInitScript(state => localStorage.setItem('gym-log-v1', JSON.stringify(state)), initial);
  await page.goto('/');
  await page.getByRole('button', { name: 'Прогресс', exact: true }).click();
  const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Вес тела', exact: true }) });
  const chart = card.locator('.line-chart'), scroll = chart.locator('.chart-scroll');
  await chart.scrollIntoViewIfNeeded();
  await expect(chart.locator('.chart-position')).toHaveText('240 / 240');
  await expect.poll(() => scroll.evaluate(el => el.scrollLeft > 0)).toBe(true);
  const layout = await chart.evaluate(el => {
    const viewport = el.querySelector('.chart-scroll');
    const labels = Array.from(el.querySelectorAll('.chart-x-label'), label => label.getBBox());
    const axes = Array.from(el.querySelectorAll('.chart-scale text'), label => label.textContent);
    return {
      overflows: viewport.scrollWidth > viewport.clientWidth,
      labelOverlap: labels.some((label, i) => i && labels[i - 1].x + labels[i - 1].width + 4 > label.x),
      duplicateAxisLabels: new Set(axes).size !== axes.length,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(layout).toEqual({ overflows: true, labelOverlap: false, duplicateAxisLabels: false, pageOverflow: false });
  const gestureBounds = await scroll.boundingBox();
  const priorScroll = await scroll.evaluate(el => el.scrollLeft);
  const cdp = await page.context().newCDPSession(page);
  const touch = x => [{ x, y: gestureBounds.y + 80 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(gestureBounds.x + 40) });
  for (let step = 1; step <= 6; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(gestureBounds.x + 40 + step * 20) });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBeLessThan(priorScroll - 20);
  await expect(chart.locator('.chart-position')).toHaveText('240 / 240');
  await cdp.detach();
  await chart.getByRole('button', { name: 'Предыдущий замер', exact: true }).click();
  await expect(chart.locator('.chart-position')).toHaveText('239 / 240');
  await expect(chart.locator('.chart-value')).toHaveText(`${Math.round(bw[238].w * 10) / 10} кг`);
  await scroll.focus(); await page.keyboard.press('Home');
  await expect(chart.locator('.chart-position')).toHaveText('1 / 240');
  await expect.poll(() => scroll.evaluate(el => el.scrollLeft)).toBe(0);
  await expect(chart.getByRole('button', { name: 'Предыдущий замер', exact: true })).toBeDisabled();
  // Tap a nearby point on the first screen; no need to hit a tiny SVG circle exactly.
  const bounds = await scroll.boundingBox();
  await page.touchscreen.tap(bounds.x + 60, bounds.y + 80);
  await expect(chart.locator('.chart-position')).toHaveText('2 / 240');
  await chart.getByRole('button', { name: 'К последнему замеру', exact: true }).click();
  await expect(chart.locator('.chart-position')).toHaveText('240 / 240');
  await expect(chart.getByRole('button', { name: 'Следующий замер', exact: true })).toBeDisabled();
  await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft) < 2)).toBe(true);
  const before = await chart.locator('.chart-scale').boundingBox();
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  const after = await chart.locator('.chart-scale').boundingBox();
  expect(after.x).toBe(before.x); // Weight scale stays visible while history moves.
  await chart.getByRole('button', { name: 'К последнему замеру', exact: true }).click();
  await expect.poll(() => scroll.evaluate(el => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft) < 2)).toBe(true);
  await chart.screenshot({ path: 'test-results/weight-chart-dense-mobile.png' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('gym-log-v1')));
  expect(saved.bw).toEqual(initial.bw); expect(saved.hist).toEqual(initial.hist);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Верх A', exact: true }).click();
  const exercise = page.locator('.pex').first();
  await exercise.locator('.phead').click();
  await expect(exercise.locator('.line-chart .chart-position')).toHaveText('2 / 2');
  await expect(exercise.locator('.chart-extra')).toContainText('28×10');
  await exercise.locator('.line-chart').screenshot({ path: 'test-results/exercise-chart-mobile.png' });
});
