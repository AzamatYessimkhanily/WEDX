import './style.css';
const endpoint = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/wedx-coach`;
const requestId = new URL(location.href).searchParams.get('request');
const form = document.getElementById('coach-consent-form'), status = document.getElementById('coach-status');
const allow = document.getElementById('coach-allow'), deny = document.getElementById('coach-deny'), code = document.getElementById('coach-code');
const messages = { invalid_pairing_code: 'Код неверный или уже использован. Создай новый в WEDX.',
  expired_request: 'Подключение устарело. Вернись в ChatGPT и начни подключение заново.',
  invalid_request: 'Подключение устарело. Вернись в ChatGPT и начни подключение заново.',
  rate_limited: 'Подожди минуту и повтори.' };
async function send(denied) {
  allow.disabled = deny.disabled = true;
  try {
    const response = await fetch(`${endpoint}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, pairingCode: code.value.trim(), deny: denied }), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(messages[result.error] || 'Не удалось подключить. Повтори позже.');
    const next = new URL(result.redirect);
    if (next.origin !== 'https://chatgpt.com' || !/^\/(connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]+)$/.test(next.pathname)) throw new Error('Некорректный адрес возврата.');
    code.value = ''; status.textContent = 'Возвращаемся в ChatGPT…'; location.assign(next.href);
  } catch (error) { status.textContent = error.message; allow.disabled = deny.disabled = false; }
}
form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) void send(false); };
deny.onclick = () => send(true);
(async () => {
  try {
    if (!requestId) throw new Error('Начни подключение из ChatGPT, затем вернись сюда.');
    const response = await fetch(`${endpoint}/request?id=${encodeURIComponent(requestId)}`, { signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(messages[result.error] || 'Не удалось проверить подключение.');
    status.textContent = ''; allow.disabled = deny.disabled = false;
  } catch (error) { status.textContent = error.message; }
})();
