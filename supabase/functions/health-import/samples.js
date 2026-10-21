// Shortcuts sends only the two nutrition types, never a full Health export.
// Dates are formatted on the phone so midnight stays in the user's calendar day.
export class SampleImportError extends Error {}
function invalid(message) { throw new SampleImportError(message); }
function date(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
const units = {
  energy: { kcal: 1, 'ккал': 1, kJ: 1 / 4.184, 'кДж': 1 / 4.184, J: 1 / 4184, cal: 0.001 },
  protein: { g: 1, 'г': 1, mg: 0.001, 'мг': 0.001, kg: 1000, 'кг': 1000 },
};
export function summarizeSamples(body) {
  if (body?.version !== 2 || body.source !== 'yazio:apple-health'
    || !date(body.startDate) || !date(body.endDate)) invalid('Неверный формат команды. Установи актуальную команду WEDX.');
  const span = (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86400000;
  if (span < 0 || span > 30) invalid('За один раз можно передать до 31 календарного дня.');
  const grouped = new Map();
  let count = 0;
  for (const kind of ['energy', 'protein']) {
    const samples = body[kind + 'Samples'];
    if (!Array.isArray(samples) || samples.length > 4000) invalid('Не удалось прочитать список записей «Здоровья».');
    count += samples.length;
    for (const sample of samples) {
      if (!sample || !date(sample.date) || typeof sample.source !== 'string'
        || !/^yazio(?:$|[\s:–—-])/i.test(sample.source.trim())) invalid('Команда должна передавать только записи YAZIO.');
      // The phone queries an extra day to avoid a partial first calendar day.
      if (sample.date < body.startDate || sample.date > body.endDate) continue;
      const multiplier = units[kind][sample.unit];
      if (!Object.hasOwn(units[kind], sample.unit) || !Number.isFinite(sample.value) || sample.value < 0) {
        invalid('Неизвестная единица измерения или значение. Нужны ккал и граммы.');
      }
      const day = grouped.get(sample.date) || { date: sample.date, energy: null, protein: null };
      day[kind] = (day[kind] ?? 0) + sample.value * multiplier;
      grouped.set(sample.date, day);
    }
  }
  if (count > 6000) invalid('Слишком много записей. Сократи период команды.');
  const days = [], skipped = [];
  for (const day of [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    // Missing access/records must never erase an existing total or become zero.
    if (day.energy === null || day.protein === null) { skipped.push(day.date); continue; }
    if (day.energy > 100000 || day.protein > 10000) invalid('Итог за день слишком велик. Проверь единицы измерения.');
    days.push({ date: day.date, caloriesKcal: Math.round(day.energy * 1000) / 1000, proteinGrams: Math.round(day.protein * 1000) / 1000 });
  }
  return { days, skipped };
}
