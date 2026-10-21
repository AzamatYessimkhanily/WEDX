import { supabase, healthImportUrl } from '../../data/supabase.js';
import { integrations } from './catalog.js';

function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const b = text('button', label); b.type = 'button'; b.onclick = fn; return b; }
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export function integrationsPanel(user) {
  const panel = document.createElement('details');
  panel.className = 'integrations-panel';
  panel.append(text('summary', 'Подключения и питание'));
  const feedback = text('p', ''); feedback.setAttribute('role', 'status');
  for (const service of integrations) {
    const section = document.createElement('section');
    section.append(text('h4', service.name), text('p', service.description));
    if (service.available) {
      const tokenList = document.createElement('div');
      async function refreshTokens() {
        const { data, error } = await supabase.from('integration_tokens').select('id,label,created_at,last_used_at').order('created_at', { ascending: false });
        if (error) { feedback.textContent = 'Не удалось загрузить подключения. Проверь настройку базы.'; return; }
        tokenList.replaceChildren();
        for (const token of data) {
          const row = document.createElement('p');
          row.append(text('span', `${token.label} · ${token.last_used_at ? 'приём ' + new Date(token.last_used_at).toLocaleString('ru-RU') : 'данные ещё не поступали'} `));
          row.append(button('Отозвать', async () => {
            const { error } = await supabase.from('integration_tokens').delete().eq('id', token.id);
            if (error) feedback.textContent = 'Не удалось отозвать ключ.';
            else await refreshTokens();
          }));
          tokenList.append(row);
        }
      }
      const create = button('Создать ключ для команды', async () => {
        create.disabled = true;
        try {
          const raw = 'wedx_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
          const { error } = await supabase.from('integration_tokens').insert({ user_id: user.id, label: 'Команда iPhone', source: 'apple-health', token_hash: await digest(raw) });
          if (error) throw error;
          const output = document.createElement('div');
          output.append(text('p', 'Сохрани ключ в своей команде. Он показан только сейчас и разрешает только импорт питания.'));
          const values = text('textarea', `URL: ${healthImportUrl}\nAuthorization: Bearer ${raw}`);
          values.readOnly = true; values.rows = 5; values.setAttribute('aria-label', 'Ключ и адрес импорта');
          output.append(values, button('Скрыть ключ', () => output.remove()));
          section.append(output);
          await refreshTokens();
        } catch { feedback.textContent = 'Не удалось создать ключ. Проверь подключение и миграцию базы.'; }
        finally { create.disabled = false; }
      });
      section.append(create, tokenList);
      panel.addEventListener('toggle', () => { if (panel.open) refreshTokens(); });
    }
    panel.append(section);
  }
  const nutrition = document.createElement('section');
  nutrition.append(text('h4', 'Питание за последние дни'));
  const rows = document.createElement('div'); nutrition.append(rows);
  const refresh = async () => {
    const { data, error } = await supabase.from('nutrition_daily').select('day,calories_kcal,protein_grams,updated_at').order('day', { ascending: false }).limit(7);
    rows.replaceChildren();
    if (error) { rows.append(text('p', 'Нет связи с базой.')); return; }
    if (!data.length) { rows.append(text('p', 'Импортов пока нет. После настройки команды здесь появятся калории и белок из YAZIO.')); return; }
    for (const day of data) rows.append(text('p', `${day.day} · ${Number(day.calories_kcal).toLocaleString('ru-RU')} ккал · ${Number(day.protein_grams).toLocaleString('ru-RU')} г белка`));
  };
  nutrition.append(button('Обновить питание', refresh));
  panel.addEventListener('toggle', () => { if (panel.open) refresh(); });
  panel.append(nutrition, feedback);
  return panel;
}
