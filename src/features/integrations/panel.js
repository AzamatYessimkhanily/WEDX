import { supabase, healthImportUrl } from '../../data/supabase.js';
import { nutritionPanel } from './nutrition.js';
import { coachPanel } from '../coach/panel.js';

function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const b = text('button', label); b.type = 'button'; b.onclick = fn; return b; }
function link(label, href) { const a = text('a', label); a.href = href; a.className = 'connection-action'; return a; }
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export function integrationsPanel(user, { open = false, getWeights = () => [] } = {}) {
  const panel = document.createElement(open ? 'section' : 'details');
  panel.className = 'integrations-panel';
  if (!open) panel.append(text('summary', 'Подключения и питание'));
  if (!user) {
    panel.append(text('h4', 'Подключить Apple Health'));
    panel.append(text('p', 'Сначала подключи этот iPhone по личной ссылке WEDX.'));
    return panel;
  }
  const settings = document.createElement('details'); settings.className = 'health-settings';
  settings.append(text('summary', 'Настройки'));
  const nutrition = nutritionPanel(user.id, settings, getWeights);
  panel.append(nutrition, coachPanel(user.id));
  if (!open) panel.addEventListener('toggle', () => { if (panel.open) nutrition.refresh(); });
  const section = document.createElement('section'); section.className = 'health-setup';
  section.append(text('h4', 'Apple Health'));
  const install = link('Установить команду', 'https://www.icloud.com/shortcuts/6df804e55175488686de84f1b0d80a9f');
  install.target = '_blank'; install.rel = 'noopener noreferrer';
  section.append(install, link('Запустить на iPhone', `shortcuts://run-shortcut?name=${encodeURIComponent('WEDX — Здоровье')}`));
  const help = document.createElement('details'); help.append(text('summary', 'Как подключить'));
  const steps = document.createElement('ol');
  for (const step of [
    'Скопируй ключ из старой команды WEDX или создай ниже.',
    'Установи «WEDX — Здоровье», вставь ключ и разреши чтение данных.',
    'В «Команды» → «Автоматизация» выбери YAZIO → «Закрывается» → «Запускать немедленно» → «WEDX — Здоровье».',
  ]) steps.append(text('li', step));
  help.append(steps);
  const fallback = document.createElement('details'); fallback.append(text('summary', 'Скачать команду файлом'));
  const download = link('Скачать .shortcut', `${import.meta.env.BASE_URL}shortcuts/${encodeURIComponent('WEDX — Здоровье.shortcut')}`);
  download.download = 'WEDX — Здоровье.shortcut'; fallback.append(download); help.append(fallback); section.append(help);
  const feedback = text('p', ''); feedback.setAttribute('role', 'status');
  const tokenList = document.createElement('div');
  async function refreshTokens() {
    const { data, error } = await supabase.from('integration_tokens').select('id,label,created_at,last_used_at').order('created_at', { ascending: false });
    if (error) { feedback.textContent = 'Не удалось загрузить подключения.'; return; }
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
  let shownKey = null;
  const create = button('Создать ключ для iPhone', async () => {
    create.disabled = true;
    try {
      const raw = 'wedx_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const { error } = await supabase.from('integration_tokens').insert({ user_id: user.id, label: 'Команда iPhone', source: 'apple-health', token_hash: await digest(raw) });
      if (error) throw error;
      const output = document.createElement('div');
      output.className = 'connection-secret';
      output.append(text('p', 'Скопируй ключ и вставь в команду. Повторно показать его нельзя.'));
      const values = text('textarea', raw);
      values.readOnly = true; values.rows = 3; values.setAttribute('aria-label', 'Ключ команды iPhone');
      output.append(values, button('Скопировать ключ', async () => {
        try { await navigator.clipboard.writeText(raw); feedback.textContent = 'Ключ скопирован. Вставь его при добавлении команды.'; }
        catch { values.focus(); values.select(); feedback.textContent = 'Ключ выделен — скопируй его через меню iPhone.'; }
      }), button('Скрыть ключ', () => output.remove()));
      const manual = document.createElement('details'); manual.append(text('summary', 'Для ручной настройки'));
      const address = text('textarea', `URL: ${healthImportUrl}\nAuthorization: Bearer ${raw}`);
      address.readOnly = true; address.rows = 5; address.setAttribute('aria-label', 'Адрес и заголовок импорта'); manual.append(address);
      output.append(manual);
      shownKey?.remove(); shownKey = output; create.after(output);
      await refreshTokens();
    } catch { feedback.textContent = 'Не удалось создать ключ. Попробуй ещё раз.'; }
    finally { create.disabled = false; }
  });
  section.append(create, tokenList, feedback);
  settings.addEventListener('toggle', () => { if (settings.open) refreshTokens(); });
  settings.append(section); panel.append(settings);
  return panel;
}
