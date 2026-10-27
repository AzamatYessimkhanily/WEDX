import { PROGRAM } from '../../../src/domain/program.js';
import { technique } from '../../../src/domain/technique.js';
import { dailyMetrics, nutritionStatus } from '../../../src/features/integrations/metrics.js';

export const NOTES = {
  nutrition: 'Питание — дневные итоги Apple Health, обычно из YAZIO. Норма задана вручную в WEDX, это не базовый обмен и не измеренный суточный расход. Остаток и баланс сравнивают еду с этой нормой. Отсутствие записи не означает ноль; наличие записи не доказывает полноту дневника.',
  workouts: 'Дата тренировки в WEDX меняется в 03:00, питание — по календарной дате. Интервал первой и последней записи подхода не равен времени нахождения в зале. Для тренажёров сравнивать один и тот же зал; для гравитрона меньший противовес означает большую нагрузку. Тоннаж — значение дневника, не расход энергии.',
  trend: 'Совпадение изменений веса, питания и тренировок не доказывает причину. По этим данным нельзя измерить потерю мышц или жира. Сон, состав тела, базовый обмен и посещения Invictus сейчас не подключены.',
};
export function localDate(now, timezone = 'Asia/Almaty') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
export function dateRange(input, today, maxDays = 366, defaultDays = 30) {
  const end = input.end_date || today, start = input.start_date || addDays(end, 1 - defaultDays);
  if (!validDay(start) || !validDay(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 >= maxDays) {
    throw new Error(`Укажи корректный период не больше ${maxDays} дней: start_date и end_date в формате YYYY-MM-DD.`);
  }
  return { start, end };
}
function exercise(key, snapshot) {
  const [day, index] = key.split('|'), e = PROGRAM[day]?.ex[Number(index)];
  if (!e) return { exercise_key: key, name: key, machine: null, assisted: null, repetition_unit: 'unknown' };
  const override = snapshot.exo?.[key] || {};
  return { exercise_key: key, name: e.n, muscle_group: e.t,
    machine: Boolean(e.w && (override.m ?? e.m)), assisted: Boolean(e.w && (override.a ?? e.a)),
    repetition_unit: e.sec ? 'seconds' : 'repetitions', weighted: Boolean(e.w) };
}
export function trainingProgram(snapshot = {}) {
  return Object.entries(PROGRAM).map(([id, day]) => ({ program_day: id, name: day.name, emphasis: day.note,
    exercises: day.ex.map((e, i) => ({ ...exercise(`${id}|${i}`, snapshot), target_sets: e.s,
      target_repetitions: e.r, rest_seconds: e.rest, per_side: Boolean(e.side), note: e.hint || null })) }));
}
export function workoutDays(snapshot, range, filter = {}) {
  const byDay = new Map();
  const gymName = id => snapshot.gyms?.find(g => g.id === id)?.n || null;
  const getDay = date => {
    if (!byDay.has(date)) {
      const session = snapshot.sess?.[date];
      byDay.set(date, { date, program_day: session?.day || null, gym_id: session?.g || null, gym_name: gymName(session?.g),
        first_recorded_set_at: session?.t0 ? new Date(session.t0).toISOString() : null,
        last_recorded_set_at: session?.t1 ? new Date(session.t1).toISOString() : null,
        recording_span_minutes: session?.t0 && session?.t1 >= session.t0 ? Math.round((session.t1 - session.t0) / 60000) : null,
        exercises: [] });
    }
    return byDay.get(date);
  };
  if (!filter.exercise_key && !filter.gym_id) for (const date of Object.keys(snapshot.sess || {})) {
    if (date >= range.start && date <= range.end) getDay(date);
  }
  for (const [key, history] of Object.entries(snapshot.hist || {})) {
    if (filter.exercise_key && filter.exercise_key !== key) continue;
    for (const record of history) {
      if (record.d < range.start || record.d > range.end || (filter.gym_id && filter.gym_id !== record.g)) continue;
      const meta = exercise(key, snapshot), rawNote = snapshot.notes?.[key]?.[record.d] || '';
      getDay(record.d).exercises.push({ ...meta, gym_id: record.g || null, gym_name: gymName(record.g),
        best_recorded_weight_kg: record.w, best_recorded_repetitions: record.r, set_count: record.n,
        recorded_volume_kg_reps: record.v, individual_sets_available: Array.isArray(record.s),
        sets: record.s?.flatMap((s, i) => s ? [{ set_number: i + 1, recorded_weight_kg: s[0], repetitions: s[1],
          technique: technique(record.q?.[i], s[1]),
          ...(s.length >= 4 ? { extra_set: { recorded_weight_kg: s[2], repetitions: s[3] } } : {}) }] : []) ?? null,
        note: rawNote.slice(0, 1000), note_truncated: rawNote.length > 1000 });
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
const mean = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : null;
export function weightTrend(weights, end) {
  const recent = weights.filter(w => w.d >= addDays(end, -6) && w.d <= end && w.w >= 30 && w.w <= 300);
  const previous = weights.filter(w => w.d >= addDays(end, -13) && w.d < addDays(end, -6) && w.w >= 30 && w.w <= 300);
  const a = mean(recent.map(w => w.w)), b = mean(previous.map(w => w.w));
  return { recent_7_day_mean_kg: a, recent_measurements: recent.length, previous_7_day_mean_kg: b, previous_measurements: previous.length,
    mean_change_kg: recent.length >= 3 && previous.length >= 3 ? Math.round((a - b) * 10) / 10 : null,
    comparison_available: recent.length >= 3 && previous.length >= 3, minimum_measurements_per_window: 3 };
}

export async function coachData(name, input, repository, now = new Date()) {
  const [document, preferences] = await Promise.all([repository.workout(), repository.preferences()]);
  const snapshot = document?.snapshot || {}, weights = snapshot.bw || [], timezone = preferences?.timezone || 'Asia/Almaty';
  const today = localDate(now, timezone), fetchedAt = now.toISOString();
  const common = { fetched_at: fetchedAt, timezone, today, workout_synced_at: document?.updated_at || null,
    source_url: 'https://azamatyessimkhanily.github.io/WEDX/', data_is_live_cloud_snapshot: true };
  const latestWeight = weights.filter(w => w.d <= today).sort((a, b) => b.d.localeCompare(a.d))[0];
  if (name === 'get_fitness_profile') return { ...common, account_name: 'Мой WEDX', goal: preferences?.goal || null,
    latest_weight: latestWeight ? { date: latestWeight.d, weight_kg: latestWeight.w } : null,
    gyms: snapshot.gyms?.map(g => ({ id: g.id, name: g.n })) || [],
    connected_data: ['тренировки WEDX', 'замеры веса WEDX', 'питание и активность Apple Health', 'цели питания WEDX'],
    unavailable_data: ['сон', 'состав тела', 'базовый обмен', 'посещения Invictus'], permissions: ['read'], notes: Object.values(NOTES) };
  if (name === 'get_training_program') return { ...common, days: trainingProgram(snapshot), notes: [NOTES.workouts] };
  const overview = name === 'get_fitness_overview';
  const range = dateRange(input, today, name === 'get_workouts' ? 92 : overview ? 90 : 366, overview ? input.days || 14 : 30);
  const inRange = date => date >= range.start && date <= range.end;
  if (name === 'get_weight_history') return { ...common, ...range,
    measurements: weights.filter(w => inRange(w.d)).sort((a, b) => a.d.localeCompare(b.d)).map(w => ({ date: w.d, weight_kg: w.w })),
    trend: weightTrend(weights, range.end), notes: [NOTES.trend] };
  const workouts = workoutDays(snapshot, range, input);
  if (name === 'get_workouts') return { ...common, ...range, workouts, notes: [NOTES.workouts] };
  const [rows, goals] = await Promise.all([repository.nutrition(range.start, range.end), repository.goals(range.end)]);
  const nutrition = rows.map(row => ({ ...dailyMetrics(row, goals, weights),
    is_ongoing_day: row.day >= today, completeness: 'not_confirmed', status: nutritionStatus(dailyMetrics(row, goals, weights), today).kind }));
  const missing = [];
  for (let date = range.start; date <= range.end; date = addDays(date, 1)) if (!rows.some(r => r.day === date)) missing.push(date);
  if (name === 'get_nutrition') return { ...common, ...range, days: nutrition, missing_dates: missing, notes: [NOTES.nutrition] };
  if (!overview) throw new Error('Неизвестный инструмент.');
  const dates = new Set([...nutrition.map(d => d.date), ...workouts.map(d => d.date), ...weights.filter(w => inRange(w.d)).map(w => w.d)]);
  const finished = nutrition.filter(d => d.date < today);
  return { ...common, ...range, goal: preferences?.goal || null, latest_weight: latestWeight || null,
    weight_trend: weightTrend(weights, range.end),
    summary: { recorded_workout_days: workouts.filter(w => w.exercises.some(e => e.set_count > 0)).length,
      nutrition_days_recorded: nutrition.length, nutrition_missing_dates: missing,
      mean_recorded_calories_past_days: mean(finished.map(d => d.calories_consumed).filter(x => x != null)),
      mean_recorded_protein_g_past_days: mean(finished.map(d => d.protein_g).filter(x => x != null)),
      calories_average_days: finished.filter(d => d.calories_consumed != null).length,
      protein_average_days: finished.filter(d => d.protein_g != null).length },
    days: [...dates].sort().map(date => {
      const day = workouts.find(d => d.date === date);
      return { date, weight_kg: weights.find(w => w.d === date)?.w ?? null, nutrition: nutrition.find(d => d.date === date) || null,
        training: day ? { program_day: day.program_day, gym_name: day.gym_name,
          exercise_count: day.exercises.length, recorded_sets: day.exercises.reduce((sum, e) => sum + e.set_count, 0),
          recorded_volume_kg_reps: day.exercises.reduce((sum, e) => sum + e.recorded_volume_kg_reps, 0) } : null };
    }), notes: Object.values(NOTES) };
}
