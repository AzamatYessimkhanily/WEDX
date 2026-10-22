import { supabase } from '../../data/supabase.js';
function text(tag, value) { const n = document.createElement(tag); n.textContent = value; return n; }
export function goalsForm(ownerId, onSave) {
  const details = document.createElement('details');
  details.className = 'nutrition-goals';
  details.append(text('summary', 'Лимиты калорий и белка'));
  details.append(text('p', 'YAZIO не передаёт цели через «Здоровье». Здесь можно сохранить свои лимиты, например скопировать из YAZIO. При изменении целей в YAZIO обнови их здесь. Цель белка фиксирована; автоматическая коррекция макроцелей YAZIO не воспроизводится.'));
  const form = document.createElement('form');
  const fields = {};
  for (const [name, label, type] of [['effective_from', 'Действуют с даты', 'date'], ['base_calorie_goal', 'Базовый лимит без активности, ккал', 'number'], ['protein_goal_g', 'Цель белка, г', 'number']]) {
    const row = text('label', label); const input = document.createElement('input');
    input.name = name; input.type = type; input.required = true;
    if (type === 'number') { input.min = '0.1'; input.max = name === 'protein_goal_g' ? '10000' : '100000'; input.step = '0.1'; input.inputMode = 'decimal'; }
    else { const today = new Date(); input.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`; }
    row.append(input); form.append(row); fields[name] = input;
  }
  const activityLabel = text('label', 'Прибавлять подтверждённый расход активности к лимиту');
  const activity = document.createElement('input'); activity.type = 'checkbox'; activity.name = 'include_activity';
  activityLabel.prepend(activity); form.append(activityLabel);
  form.append(text('p', 'Новые лимиты применяются с выбранной даты. Если на эту дату уже есть настройка, она будет заменена. Более ранние дни останутся с прежними целями.'));
  const save = text('button', 'Сохранить лимиты'); save.type = 'submit';
  const status = text('p', ''); status.setAttribute('role','status'); form.append(save,status);
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    save.disabled = true;
    try {
      const { error } = await supabase.from('nutrition_goals').upsert({ user_id: ownerId,
        effective_from: fields.effective_from.value, base_calorie_goal: Number(fields.base_calorie_goal.value),
        protein_goal_g: Number(fields.protein_goal_g.value), include_activity: activity.checked,
        source: 'manual', updated_at: new Date().toISOString() }, { onConflict: 'user_id,effective_from' });
      if (error) throw error;
      status.textContent = 'Лимиты сохранены.'; onSave();
    } catch { status.textContent = 'Не удалось сохранить лимиты. Повтори после подключения к интернету.'; }
    finally { save.disabled = false; }
  };
  details.append(form); return details;
}
