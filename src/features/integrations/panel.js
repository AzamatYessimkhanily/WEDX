import { supabase, healthImportUrl } from '../../data/supabase.js';
import { integrations } from './catalog.js';

function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const b = text('button', label); b.type = 'button'; b.onclick = fn; return b; }
function link(label, href) { const a = text('a', label); a.href = href; a.className = 'connection-action'; return a; }
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
      const setup = document.createElement('details');
      setup.className = 'health-setup'; setup.open = true;
      setup.append(text('summary', 'Подключить iPhone'));
      const steps = document.createElement('ol');
      steps.append(text('li', 'В «Здоровье» проверь пищевую энергию и белок: источником должен быть YAZIO.'));
      steps.append(text('li', 'Создай ключ ниже и скопируй его. Установи команду и вставь ключ при добавлении.'));
      steps.append(text('li', 'Запусти «WEDX — питание» на разблокированном iPhone. Разреши чтение двух показателей и отправку в WEDX.'));
      steps.append(text('li', 'Нажми «Обновить питание» и сверь один день с YAZIO. Сегодняшние значения меняются по мере заполнения дневника.'));
      const install = link('Установить команду', `${import.meta.env.BASE_URL}shortcuts/WEDX-Nutrition.shortcut`);
      install.download = 'WEDX-Nutrition.shortcut';
      setup.append(steps, install, link('Запустить на iPhone', `shortcuts://run-shortcut?name=${encodeURIComponent('WEDX — питание')}`));
      setup.append(text('p', 'Если скачался файл, открой его в «Загрузках» Safari или в «Файлах» → «Загрузки» и добавь команду.'));
      const automation = document.createElement('details');
      automation.append(text('summary', 'Запускать автоматически'));
      automation.append(text('p', 'После успешной сверки: «Команды» → «Автоматизация» → «+» → «Приложение» → YAZIO → «Закрывается» → «Немедленный запуск» → «WEDX — питание».'));
      automation.append(text('p', 'Если данные ещё не успели попасть из YAZIO в «Здоровье» или iPhone заблокирован, повтори запуск вручную. Команда заново проверяет сегодня и предыдущие 7 дней.'));
      setup.append(automation); section.append(setup);
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
      let shownKey = null;
      const create = button('Создать ключ для iPhone', async () => {
        create.disabled = true;
        try {
          const raw = 'wedx_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
          const { error } = await supabase.from('integration_tokens').insert({ user_id: user.id, label: 'Команда iPhone', source: 'apple-health', token_hash: await digest(raw) });
          if (error) throw error;
          const output = document.createElement('div');
          output.className = 'connection-secret';
          output.append(text('p', 'Этот ключ подключает команду к твоему питанию. Скопируй его перед установкой. Повторно показать его нельзя; при необходимости можно создать новый.'));
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
        } catch { feedback.textContent = 'Не удалось создать ключ. Проверь подключение и миграцию базы.'; }
        finally { create.disabled = false; }
      });
      section.append(create, tokenList);
      panel.addEventListener('toggle', () => { if (panel.open) refreshTokens(); });
    }
    panel.append(section);
  }
  const nutrition = document.createElement('section');
  nutrition.append(text('h4', 'Записано в YAZIO'));
  nutrition.append(text('p', 'Калории и белок за последние 7 дней с записями. Пропуски не считаются нулём; наличие записей не означает, что дневник заполнен полностью.'));
  const rows = document.createElement('div'); nutrition.append(rows);
  const refresh = async () => {
    const { data, error } = await supabase.from('nutrition_daily').select('day,calories_kcal,protein_grams,updated_at').order('day', { ascending: false }).limit(7);
    rows.replaceChildren();
    if (error) { rows.append(text('p', 'Нет связи с базой.')); return; }
    if (!data.length) { rows.append(text('p', 'Импортов пока нет. После настройки команды здесь появятся калории и белок из YAZIO.')); return; }
    const latest = data.reduce((value, day) => day.updated_at > value ? day.updated_at : value, '');
    if (latest) rows.append(text('p', `Последнее обновление: ${new Date(latest).toLocaleString('ru-RU')}`));
    for (const day of data) {
      const row = document.createElement('div'); row.className = 'nutrition-day';
      row.append(text('strong', new Date(`${day.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })));
      row.append(text('span', `${Number(day.calories_kcal).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ккал`));
      row.append(text('span', `${Number(day.protein_grams).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} г белка`));
      rows.append(row);
    }
  };
  nutrition.append(button('Обновить питание', refresh));
  panel.addEventListener('toggle', () => { if (panel.open) refresh(); });
  panel.append(nutrition, feedback);
  return panel;
}
