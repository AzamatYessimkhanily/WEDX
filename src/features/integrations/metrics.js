// Goals are dated user settings, not values exported by YAZIO/Health.
export const DEFAULT_PROTEIN_PER_KG = 2;

export function dailyMetrics(day, goals = [], weights = []) {
  const goal = goals.filter(g => g.effective_from <= day.day)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  const number = value => value == null ? null : Number(value);
  const consumed = number(day.calories_kcal), protein = number(day.protein_grams);
  const burned = day.activity_status === 'verified' ? number(day.calories_burned) : null;
  const base = number(goal?.base_calorie_goal);
  // Future measurements must not silently change earlier targets.
  const weight = weights.filter(w => w.d <= day.day && Number.isFinite(w.w) && w.w >= 30 && w.w <= 300)
    .sort((a, b) => b.d.localeCompare(a.d))[0];
  const proteinPerKg = number(goal?.protein_per_kg) ?? DEFAULT_PROTEIN_PER_KG;
  const proteinGoal = weight ? Math.round(weight.w * proteinPerKg) : null;
  const adjusted = base == null ? null : goal.include_activity ? burned == null ? null : base + burned : base;
  return { date: day.day, nutrition_origin: day.nutrition_origin ?? 'yazio', calories_consumed: consumed, protein_g: protein,
    carbs_g: number(day.carbs_grams), fat_g: number(day.fat_grams), calories_burned: burned,
    base_calorie_goal: base, adjusted_calorie_goal: adjusted,
    calories_remaining: adjusted == null || consumed == null ? null : adjusted - consumed,
    protein_goal_g: proteinGoal, protein_remaining_g: proteinGoal == null || protein == null ? null : proteinGoal - protein,
    protein_per_kg: proteinPerKg, protein_weight_kg: weight?.w ?? null, protein_weight_date: weight?.d ?? null,
    calorie_balance: adjusted == null || consumed == null ? null : consumed - adjusted,
    last_synced_at: day.updated_at, goal_source: goal?.source ?? null,
    goal_effective_from: goal?.effective_from ?? null, include_activity: goal?.include_activity ?? null,
    metric_synced_at: day.metric_synced_at ?? {}, activity_status: day.activity_status ?? 'unknown' };
}

// Today's partial log is not a finished day's result. Missing data is never
// treated as zero or as meeting either target.
export function nutritionStatus(metrics, today) {
  const finished = metrics.date < today;
  const over = metrics.calories_remaining != null && metrics.calories_remaining < 0;
  const lowProtein = finished && metrics.protein_remaining_g != null && metrics.protein_remaining_g > 0;
  const complete = metrics.calories_remaining != null && metrics.protein_remaining_g != null;
  return { over, lowProtein,
    kind: over ? 'over' : !finished ? 'pending' : lowProtein ? 'protein' : complete ? 'met' : 'unknown',
    label: over ? 'Перебор калорий' : !finished ? 'День ещё идёт' : lowProtein ? 'Мало белка'
      : complete ? 'В пределах калорий, белок набран' : 'Недостаточно данных',
  };
}
