export const ownerA = '11111111-1111-4111-8111-111111111111';
export const ownerB = '22222222-2222-4222-8222-222222222222';
export const workout = {
  log: {}, last: { 'mon|0': '26' }, done: {},
  hist: { 'mon|0': [
    { d: '2026-09-21', w: 26, r: 9, v: 980, n: 4 },
    { d: '2026-10-20', w: 28, r: 10, v: 784, n: 3, g: 'mel', s: [[28, 10], null, [28, 9, 20, 3]] },
  ] },
  gyms: [{ id: 'mel', n: 'Зал' }], gym: 'mel',
  sess: { '2026-10-20': { day: 'mon', g: 'mel', t0: 1792512000000, t1: 1792515600000 } },
  bw: [{ d: '2026-10-20', w: 84.5 }], notes: { 'mon|0': { '2026-10-20': 'Заметка' } },
  exo: { 'mon|0': { m: true } }, ver: 3, savedAt: 123,
};
export const nutrition = {
  version: 1, source: 'yazio:apple-health', requestId: '33333333-3333-4333-8333-333333333333',
  days: [{ date: '2026-10-20', caloriesKcal: 2250, proteinGrams: 155.5 }],
};
