// Only requested nutrition and active-energy samples; never a full Health export.
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
units.carbs = units.protein; units.fat = units.protein;
export function summarizeSamples(body) {
  if (![2, 3].includes(body?.version) || body.source !== 'yazio:apple-health'
    || !date(body.startDate) || !date(body.endDate)) invalid('Неверный формат команды. Установи актуальную команду WEDX.');
  const span = (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86400000;
  if (span < 0 || span > 30) invalid('За один раз можно передать до 31 календарного дня.');
  const activityStart = body.activityStartDate ?? body.startDate;
  if (body.version === 3 && (!date(activityStart) || activityStart < body.startDate || activityStart > body.endDate)) {
    invalid('Неверный период активности. Установи актуальную команду WEDX.');
  }
  const grouped = new Map();
  let count = 0;
  for (const kind of (body.version === 3 ? ['energy', 'protein', 'carbs', 'fat'] : ['energy', 'protein'])) {
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
  if (count > 16000) invalid('Слишком много записей. Сократи период команды.');
  const activity = body.version === 3 ? summarizeActivity(body) : null;
  const days = [], skipped = [];
  for (const day of [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    // Missing access/records must never erase an existing total or become zero.
    if (day.energy === null || day.protein === null) { skipped.push(day.date); continue; }
    if (day.energy > 100000 || day.protein > 10000) invalid('Итог за день слишком велик. Проверь единицы измерения.');
    const row = { date: day.date, caloriesKcal: round(day.energy), proteinGrams: round(day.protein) };
    if (body.version === 3) {
      for (const kind of ['carbs', 'fat']) {
        if (day[kind] != null) {
          if (day[kind] > 10000) invalid('Итог за день слишком велик. Проверь единицы измерения.');
          row[kind + 'Grams'] = round(day[kind]);
        }
      }
      // A shorter activity window must not erase previously collected history.
      if (day.date >= activityStart) Object.assign(row, activity.get(day.date) || { activityStatus: 'no_data', caloriesBurned: null });
    }
    days.push(row);
  }
  return { days, skipped };
}

function round(value) { return Math.round(value * 1000) / 1000; }
// Shortcuts exposes raw records, not Health's source-prioritised daily total.
// Accept only unambiguous YAZIO intervals. Never add competing tracker sources
// or overlapping records, and never interpret absence/read denial as zero.
function summarizeActivity(body) {
  if (!Array.isArray(body.activitySamples) || body.activitySamples.length > 6000) invalid('Не удалось прочитать записи активности.');
  const groups = new Map();
  for (const sample of body.activitySamples) {
    if (!sample || !date(sample.date) || typeof sample.source !== 'string' || !sample.source.trim()
      || !Object.hasOwn(units.energy, sample.unit) || !Number.isFinite(sample.value) || sample.value < 0
      || typeof sample.start !== 'string' || typeof sample.end !== 'string'
      || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(sample.start) || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(sample.end)
      || !Number.isFinite(Date.parse(sample.start)) || !Number.isFinite(Date.parse(sample.end))
      || Date.parse(sample.end) < Date.parse(sample.start)) invalid('Неверные записи активности: нужны время, источник и ккал.');
    if (sample.date < body.startDate || sample.date > body.endDate) continue;
    const rows = groups.get(sample.date) || [];
    rows.push({ ...sample, value: sample.value * units.energy[sample.unit] }); groups.set(sample.date, rows);
  }
  const result = new Map();
  for (const [day, rows] of groups) {
    let status = 'verified';
    if (rows.some(row => !/^yazio(?:$|[\s:–—-])/i.test(row.source.trim()))
      || new Set(rows.map(row => row.source.trim().toLowerCase())).size !== 1) status = 'multiple_sources';
    let lastEnd = -Infinity, lastStart = -Infinity;
    for (const row of rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      const start = Date.parse(row.start), end = Date.parse(row.end);
      if (status === 'verified' && (start < lastEnd || start === lastStart
        || row.start.slice(0, 10) !== day || row.end.slice(0, 10) !== day)) status = 'overlap';
      lastEnd = Math.max(lastEnd, end); lastStart = start;
    }
    const total = round(rows.reduce((sum, row) => sum + row.value, 0));
    if (total > 100000) invalid('Расход за день слишком велик. Проверь единицы измерения.');
    result.set(day, { activityStatus: status, caloriesBurned: status === 'verified' ? total : null });
  }
  return result;
}
