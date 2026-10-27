import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  'Некорректная дата');
const number = z.number().finite().nonnegative();
// Keep older ratings readable in backups; new entries only store clean repetitions.
const quality = z.object({ clean: number.int().nullable(), score: z.number().int().min(1).max(5).optional() });
const record = z.object({
  d: day, w: number, r: number, v: number, n: number,
  g: z.string().optional(),
  s: z.array(z.union([z.null(), z.array(number)])).optional(),
  q: z.array(quality.nullable()).optional(),
}).passthrough();
const map = z.record(z.string(), z.unknown());
export const workoutStateSchema = z.object({
  hist: z.record(z.string(), z.array(record)),
  log: map.optional(), last: map.optional(), done: map.optional(),
  logDate: z.record(z.string(), day).optional(),
  notes: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  exo: map.optional(),
  gyms: z.array(z.object({ id: z.string().min(1), n: z.string().min(1) })).optional(),
  gym: z.string().optional(),
  sess: z.record(day, z.object({ day: z.string(), g: z.string().optional(), t0: number.optional(), t1: number.optional() }).passthrough()).optional(),
  bw: z.array(z.object({ d: day, w: number }).passthrough()).optional(),
  savedAt: number.optional(),
}).passthrough();

export function parseState(raw) {
  if (raw.length > 5_000_000) throw new Error('Копия данных слишком большая');
  return workoutStateSchema.parse(JSON.parse(raw));
}

// Timestamps are transport metadata, not an edit to a workout.
export function stateContent(state) {
  const { savedAt, ...content } = state;
  // PostgreSQL jsonb reorders object keys; that must not look like an edit.
  return JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
