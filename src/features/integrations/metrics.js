// Goals are dated user settings, not values exported by YAZIO/Health.
export function dailyMetrics(day, goals = []) {
  const goal = goals.filter(g => g.effective_from <= day.day)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  const number = value => value == null ? null : Number(value);
  const consumed = number(day.calories_kcal), protein = number(day.protein_grams);
  const burned = ['verified', 'health_total'].includes(day.activity_status) ? number(day.calories_burned) : null;
  const base = number(goal?.base_calorie_goal), proteinGoal = number(goal?.protein_goal_g);
  const adjusted = base == null ? null : goal.include_activity ? burned == null ? null : base + burned : base;
  return { date: day.day, nutrition_origin: day.nutrition_origin ?? 'yazio', calories_consumed: consumed, protein_g: protein,
    carbs_g: number(day.carbs_grams), fat_g: number(day.fat_grams), calories_burned: burned,
    base_calorie_goal: base, adjusted_calorie_goal: adjusted,
    calories_remaining: adjusted == null || consumed == null ? null : adjusted - consumed,
    protein_goal_g: proteinGoal, protein_remaining_g: proteinGoal == null || protein == null ? null : proteinGoal - protein,
    calorie_balance: adjusted == null || consumed == null ? null : consumed - adjusted,
    last_synced_at: day.updated_at, goal_source: goal?.source ?? null,
    goal_effective_from: goal?.effective_from ?? null, include_activity: goal?.include_activity ?? null,
    metric_synced_at: day.metric_synced_at ?? {}, activity_status: day.activity_status ?? 'unknown' };
}
