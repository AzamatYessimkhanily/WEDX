import { supabase } from '../../data/supabase.js';
const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wedx-coach`;
const text = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };

export function coachPanel(ownerId) {
  const panel = document.createElement('details'); panel.className = 'coach-settings';
  const summary = text('summary', 'ChatGPT — тренер'); panel.append(summary);
  panel.append(text('p', 'Тренировки, вес и питание в твоём ChatGPT. Доступ только на чтение.'));
  const status = text('p', ''); status.setAttribute('role', 'status');
  const connections = document.createElement('div'), secret = document.createElement('div');
  let timer, loading = false;
  const invoke = async body => {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user.id !== ownerId) throw new Error('Обнови страницу: подключение устройства изменилось.');
    const response = await fetch(`${endpoint}/manage`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error === 'rate_limited' ? 'Подожди минуту и попробуй снова.' : 'Не удалось связаться с подключением ChatGPT.');
    return result;
  };
  const button = (label, action) => {
    const b = text('button', label); b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      try { await action(); } catch (error) { status.textContent = error.message || 'Нет связи. Повтори позже.'; }
      finally { b.disabled = false; }
    }; return b;
  };
  const copy = async (value, label) => {
    try { await navigator.clipboard.writeText(value); status.textContent = label; }
    catch { const field = text('textarea', value); field.readOnly = true; field.setAttribute('aria-label', label); secret.replaceChildren(field); field.focus(); field.select(); status.textContent = 'Текст выделен — скопируй через меню iPhone.'; }
  };
  async function refresh() {
    if (loading) return; loading = true;
    try {
      const result = await invoke({ action: 'status' });
      if (!panel.isConnected) return;
      connections.replaceChildren();
      summary.textContent = result.connections.length ? 'ChatGPT — подключён' : 'ChatGPT — тренер';
      for (const connection of result.connections) {
        const row = document.createElement('div');
        row.append(text('p', connection.last_used_at ? `Последний запрос ${new Date(connection.last_used_at).toLocaleString('ru-RU')}` : 'ChatGPT подключён · запросов ещё не было'));
        row.append(button('Отключить ChatGPT', async () => { await invoke({ action: 'revoke', id: connection.id }); status.textContent = 'Доступ отключён.'; await refresh(); }));
        connections.append(row);
      }
    } catch (error) { status.textContent = error.message; }
    finally { loading = false; }
  }
  panel.append(button('Скопировать адрес MCP', () => copy(`${endpoint}/mcp`, 'Адрес MCP скопирован.')),
    button('Создать код подключения', async () => {
      const result = await invoke({ action: 'pair' });
      if (!panel.isConnected) return;
      clearTimeout(timer); secret.replaceChildren();
      const code = text('input', ''); code.value = result.pairingCode; code.readOnly = true; code.type = 'text'; code.setAttribute('aria-label', 'Одноразовый код ChatGPT');
      code.autocomplete = 'off'; code.spellcheck = false;
      secret.append(text('p', 'Одноразовый код · действует 10 минут'), code,
        button('Скопировать код', () => copy(result.pairingCode, 'Код скопирован. Вставь в окне подключения ChatGPT.')));
      timer = setTimeout(() => { secret.replaceChildren(text('p', 'Время кода истекло. Создай новый.')); }, result.expiresIn * 1000);
      status.textContent = '';
    }), secret, connections, status);
  const help = document.createElement('details'); help.append(text('summary', 'Подключение ChatGPT'));
  const steps = document.createElement('ol');
  for (const step of ['В веб-версии ChatGPT открой «Плагины» → «+» → «Добавить MCP-сервер».',
    'Название WEDX, адрес скопируй выше, авторизация OAuth. Создай и установи плагин.',
    'При подключении вставь одноразовый код WEDX и разреши чтение.',
    'На iPhone начни новый чат и выбери @WEDX.']) steps.append(text('li', step));
  help.append(steps); panel.append(help);
  panel.addEventListener('toggle', () => { if (panel.open) void refresh(); else { clearTimeout(timer); secret.replaceChildren(); } });
  return panel;
}
