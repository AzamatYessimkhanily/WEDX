import { supabase, healthImportUrl } from '../../data/supabase.js';
import { integrations } from './catalog.js';
import { nutritionPanel } from './nutrition.js';

function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const b = text('button', label); b.type = 'button'; b.onclick = fn; return b; }
function link(label, href) { const a = text('a', label); a.href = href; a.className = 'connection-action'; return a; }
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export function integrationsPanel(user, { open = false } = {}) {
  const panel = document.createElement('details');
  panel.className = 'integrations-panel';
  panel.open = open;
  panel.append(text('summary', 'Подключения и питание'));
  if (!user) {
    panel.append(text('h4', 'Подключить Apple Health'));
    panel.append(text('p', 'Сначала подключи этот iPhone к своей истории WEDX по личной ссылке. Если ты уже открыл её, нажми «Подключить это устройство» выше.'));
    panel.append(text('p', 'После подключения здесь появятся создание ключа и установка команды. Логин и пароль вводить не нужно.'));
    return panel;
  }
  const feedback = text('p', ''); feedback.setAttribute('role', 'status');
  for (const service of integrations) {
    const section = document.createElement('section');
    section.append(text('h4', service.name), text('p', service.description));
    if (service.available) {
      const setup = document.createElement('details');
      setup.className = 'health-setup'; setup.open = true;
      setup.append(text('summary', 'Подключить iPhone'));
      const steps = document.createElement('ol');
      steps.append(text('li', 'В «Здоровье» проверь пищевую энергию, белок, углеводы, жиры и активную энергию: источником должен быть YAZIO.'));
      steps.append(text('li', 'Создай ключ ниже и скопируй его. Установи команду и вставь ключ при добавлении.'));
      steps.append(text('li', 'Запусти «WEDX — питание 4» на разблокированном iPhone. Разреши чтение пяти показателей и отправку в WEDX.'));
      steps.append(text('li', 'Вернись в WEDX: питание загрузится автоматически. Сверь один день с YAZIO. Сегодняшние значения меняются по мере заполнения дневника.'));
      const install = link('Установить команду', 'https://www.icloud.com/shortcuts/b99072bde9754f2ab41d9349ea936fbe');
      install.target = '_blank'; install.rel = 'noopener noreferrer';
      setup.append(steps, install, link('Запустить на iPhone', `shortcuts://run-shortcut?name=${encodeURIComponent('WEDX — питание 4')}`));
      setup.append(text('p', 'Установка откроет страницу iCloud. Нажми «Получить быструю команду», затем добавь её в «Команды». Если страница не открывается из WEDX, открой ссылку в Safari.'));
      setup.append(text('p', 'Для углеводов, жиров и расхода установи «WEDX — питание 4» и выбери её в автоматизации вместо прежней команды. Ключ менять не нужно: его можно скопировать из первого действия «Текст» в старой команде через кнопку «…».'));
      const fallback = document.createElement('details');
      fallback.append(text('summary', 'Скачать команду файлом'));
      const download = link('Скачать .shortcut', `${import.meta.env.BASE_URL}shortcuts/${encodeURIComponent('WEDX — питание 4.shortcut')}`);
      download.download = 'WEDX — питание 4.shortcut';
      fallback.append(download, text('p', 'Открой скачанный файл в «Файлах». Если он не добавляется, используй «Установить команду» выше — установка через iCloud не требует скачивания файла.'));
      setup.append(fallback);
      const automation = document.createElement('details');
      automation.open = true;
      automation.append(text('summary', 'Автоматическая передача из YAZIO'));
      automation.append(text('p', 'WEDX сам показывает новые данные после их передачи. Чтобы iPhone отправлял питание без ручного запуска команды, один раз настрой автоматизацию на телефоне:'));
      const automationSteps = document.createElement('ol');
      for (const step of [
        'Открой «Команды» → «Автоматизация» → «+» → «Приложение».',
        'Выбери YAZIO и событие «Закрывается».',
        'Выбери «Немедленный запуск» → «Далее» → «WEDX — питание 4» и сохрани.',
      ]) automationSteps.append(text('li', step));
      automation.append(automationSteps);
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
  const nutrition = nutritionPanel(user.id);
  panel.addEventListener('toggle', () => { if (panel.open) nutrition.refresh(); });
  panel.append(nutrition, feedback);
  return panel;
}
