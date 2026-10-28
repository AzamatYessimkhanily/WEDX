import { SampleImportError } from './samples.js';

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
// HealthKit largeCalorie (Cal) equals kcal; lowercase cal is 1/1000 kcal.
// Keep case-sensitive matching: lowercasing would silently corrupt activity.
const energyUnits = { kcal: 1, kCal: 1, Cal: 1, 'ккал': 1, kJ: 1 / 4.184, 'кДж': 1 / 4.184, J: 1 / 4184, cal: 0.001 };
const massUnits = { g: 1, 'г': 1, mg: 0.001, 'мг': 0.001, kg: 1000, 'кг': 1000 };
const fail = message => { throw new SampleImportError(message); };
const labels = { energy: 'Съеденные калории', protein: 'Белок', carbs: 'Углеводы', fat: 'Жиры', activity: 'Активная энергия' };
// Expose the malformed field, never the request, token or health measurement.
const shape = value => value == null ? 'пусто' : Array.isArray(value) ? 'список' : typeof value === 'string' ? 'текст' : typeof value === 'number' ? 'число' : 'объект';

// These are native Find Health Samples / Group by Day results, NOT raw samples.
// Each day must occur at most once per metric. Never sum duplicate daily totals.
export function summarizeDailyTotals(body) {
  if (![4, 5].includes(body?.version) || body.source !== 'apple-health' || body.aggregation !== 'day'
    || !validDate(body.startDate) || !validDate(body.endDate)) fail('Неверный формат дневных итогов. Установи «WEDX — Здоровье».');
  const span = (Date.parse(body.endDate) - Date.parse(body.startDate)) / 86400000;
  if (span < 0 || span > 30) fail('За один раз можно передать до 31 календарного дня.');
  const selected = body.version === 5;
  if (selected && (body.activitySelection?.mode !== 'single-source'
    || typeof body.activitySelection.source !== 'string' || body.activitySelection.source.length > 200
    || (body.activitySelection.source !== '' && !/(?:\bwatch\b|часы)/iu.test(body.activitySelection.source)))) {
    fail('Не удалось определить Apple Watch. Проверь доступ команды к активной энергии.');
  }
  if (selected && !body.activitySelection.source && body.activityTotals?.length) {
    fail('Активность пришла без источника Apple Watch. Обнови команду WEDX.');
  }
  const groups = new Map();
  for (const kind of ['energy', 'protein', 'carbs', 'fat', 'activity']) {
    const rows = body[kind + 'Totals'];
    if (!Array.isArray(rows) || rows.length > 32) fail('Нужны дневные итоги «Здоровья». Проверь группировку «По дням» в команде.');
    const seen = new Set(), units = ['energy', 'activity'].includes(kind) ? energyUnits : massUnits;
    for (const row of rows) {
      const label = labels[kind];
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`${label}: вместо дневного итога получен ${shape(row)}.`);
      if (!validDate(row.date)) fail(`${label}: неверная дата (${shape(row.date)}). Нужен формат ГГГГ-ММ-ДД.`);
      if (!Number.isFinite(row.value) || row.value < 0) fail(`${label}: неверное значение (${shape(row.value)}). Нужно неотрицательное число.`);
      if (typeof row.unit !== 'string' || !Object.hasOwn(units, row.unit)) {
        const unit = typeof row.unit === 'string' ? JSON.stringify(row.unit.slice(0, 40)) : shape(row.unit);
        fail(`${label}: неизвестная единица ${unit}. Нужны ${units === energyUnits ? 'ккал' : 'граммы'}.`);
      }
      if (seen.has(row.date)) fail('Получено несколько итогов одного дня. Проверь группировку «По дням» в команде.');
      seen.add(row.date);
      const value = Math.round(row.value * units[row.unit] * 1000) / 1000;
      if (value > (units === energyUnits ? 100000 : 10000)) fail('Дневной итог слишком велик. Проверь единицы измерения.');
      // The query includes one extra day so the oldest accepted day is complete.
      if (row.date < body.startDate || row.date > body.endDate) continue;
      const day = groups.get(row.date) || { date: row.date };
      day[kind] = value; groups.set(row.date, day);
    }
  }
  const days = [], skipped = [];
  for (const day of [...groups.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    if (day.energy == null || day.protein == null) { skipped.push(day.date); continue; }
    const row = { date: day.date, caloriesKcal: day.energy, proteinGrams: day.protein, nutritionOrigin: 'apple-health' };
    // V4 groups all Health samples, which can double-count watch/phone/app data.
    // Continue importing food, but never overwrite a corrected Watch total.
    if (selected) {
      row.activityStatus = day.activity == null ? 'no_data' : 'verified';
      row.caloriesBurned = day.activity ?? null;
    }
    if (day.carbs != null) row.carbsGrams = day.carbs;
    if (day.fat != null) row.fatGrams = day.fat;
    days.push(row);
  }
  return { days, skipped };
}
