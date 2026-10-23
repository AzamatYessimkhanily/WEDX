import { supabase } from '../../data/supabase.js';
function text(tag, value) { const n = document.createElement(tag); n.textContent = value; return n; }
export function goalsForm(ownerId, onSave) {
  const details = document.createElement('details');
  details.className = 'nutrition-goals';
  details.append(text('summary', 'Дневная норма калорий'));
  details.append(text('p', 'Скопируй дневную норму без активности из YAZIO. Она не передаётся через «Здоровье» и не равна базовому обмену. Если изменишь норму в YAZIO, обнови её здесь.'));
  const form = document.createElement('form');
  const fields = {};
  for (const [name, label, type] of [['effective_from', 'Действует с даты', 'date'], ['base_calorie_goal', 'Дневная норма без активности, ккал', 'number']]) {
    const row = text('label', label); const input = document.createElement('input');
    input.name = name; input.type = type; input.required = true;
    if (type === 'number') { input.min = '0.1'; input.max = '100000'; input.step = '0.1'; input.inputMode = 'decimal'; }
    else { const today = new Date(); input.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`; }
    row.append(input); form.append(row); fields[name] = input;
  }
  const activityLabel = text('label', 'Прибавлять активность к дневной норме');
  const activity = document.createElement('input'); activity.type = 'checkbox'; activity.name = 'include_activity';
  activityLabel.prepend(activity); form.append(activityLabel);
  form.append(text('p', 'Настройка действует с выбранной даты. Более ранние дни сохранят прежнюю норму.'));
  const save = text('button', 'Сохранить норму'); save.type = 'submit';
  const status = text('p', ''); status.setAttribute('role','status'); form.append(save,status);
  let goals = [], dirty = false;
  form.addEventListener('input', () => { dirty = true; });
  details.setGoals = rows => {
    goals = rows;
    if (dirty) return;
    const latest = rows.filter(row => row.effective_from <= fields.effective_from.value)
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
    if (latest) { fields.base_calorie_goal.value = latest.base_calorie_goal; activity.checked = latest.include_activity; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    save.disabled = true;
    try {
      const { error } = await supabase.from('nutrition_goals').upsert({ user_id: ownerId,
        effective_from: fields.effective_from.value, base_calorie_goal: Number(fields.base_calorie_goal.value),
        protein_goal_g: goals.find(row => row.effective_from === fields.effective_from.value)?.protein_goal_g ?? null, include_activity: activity.checked,
        source: 'manual', updated_at: new Date().toISOString() }, { onConflict: 'user_id,effective_from' });
      if (error) throw error;
      dirty = false; status.textContent = 'Норма сохранена.'; onSave();
    } catch { status.textContent = 'Не удалось сохранить норму. Повтори после подключения к интернету.'; }
    finally { save.disabled = false; }
  };
  details.append(form); return details;
}
