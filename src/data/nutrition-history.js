const PAGE_SIZE = 500;
const COLUMNS = 'day,nutrition_origin,calories_kcal,protein_grams,carbs_grams,fat_grams,calories_burned,activity_status,metric_synced_at,updated_at';

// Keep imported months available after they leave the shortcut's refresh window.
// Fetch every page so the server's default row cap cannot hide older months.
export async function loadNutritionHistory(client, ownerId, signal) {
  const days = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    signal.throwIfAborted();
    const { data, error } = await client.from('nutrition_daily').select(COLUMNS)
      .eq('user_id', ownerId).order('day', { ascending: false }).order('source', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1).abortSignal(signal);
    if (error) return { data: null, error };
    days.push(...data);
    if (data.length < PAGE_SIZE) return { data: days, error: null };
  }
}
