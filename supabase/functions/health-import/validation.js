// Shared by the Edge Function and Node tests; no runtime-specific dependencies.
export function validateImport(body) {
  if (!body || body.version !== 1 || body.source !== 'yazio:apple-health'
    || typeof body.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)
    || !Array.isArray(body.days) || body.days.length < 1 || body.days.length > 31) {
    throw new Error('Expected version 1, source yazio:apple-health, UUID requestId and 1–31 days');
  }
  const dates = new Set();
  const days = body.days.map(day => {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)
      || Number.isNaN(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date
      || !Number.isFinite(day.caloriesKcal) || day.caloriesKcal < 0 || day.caloriesKcal > 100000
      || !Number.isFinite(day.proteinGrams) || day.proteinGrams < 0 || day.proteinGrams > 10000
      || dates.has(day.date)) throw new Error('Invalid date, duplicate day or nutrition totals');
    dates.add(day.date);
    const row = { date: day.date, caloriesKcal: day.caloriesKcal, proteinGrams: day.proteinGrams };
    for (const key of ['carbsGrams', 'fatGrams']) {
      if (Object.hasOwn(day, key)) {
        if (!Number.isFinite(day[key]) || day[key] < 0 || day[key] > 10000) throw new Error('Invalid date or macro total');
        row[key] = day[key];
      }
    }
    if (Object.hasOwn(day, 'activityStatus')) {
      if (!['verified', 'no_data', 'multiple_sources', 'overlap'].includes(day.activityStatus)
        || (day.activityStatus === 'verified' ? !Number.isFinite(day.caloriesBurned) || day.caloriesBurned < 0 || day.caloriesBurned > 100000 : day.caloriesBurned !== null)) throw new Error('Invalid date or activity total');
      row.activityStatus = day.activityStatus; row.caloriesBurned = day.caloriesBurned;
    }
    return row;
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { version: 1, source: body.source, requestId: body.requestId, days };
}
