import { validateImport } from './validation.js';
import { summarizeSamples, SampleImportError } from './samples.js';

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function reply(body, status) {
  if (status >= 400 && !body.message) body = { ...body, message: `Питание не передано (код ${status}). Повтори запуск. Если ошибка повторится, сообщи этот код.` };
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function createHandler(rpc) {
  return async request => {
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    const token = request.headers.get('Authorization')?.match(/^Bearer (wedx_[a-f0-9]{64})$/)?.[1];
    if (!token) return reply({ error: 'Integration token required' }, 401);
    if (!request.headers.get('Content-Type')?.includes('application/json')) return reply({ error: 'JSON required' }, 415);
    // Bound streamed bodies even when Content-Length is absent or inaccurate.
    const reader = request.body?.getReader();
    const emptyBody = () => reply({ error: 'empty_payload', message: 'Команда отправила пустой запрос. Установи исправленную команду WEDX; ключ менять не нужно.' }, 400);
    if (!reader) return emptyBody();
    let text = '', bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1048576) { await reader.cancel(); return reply({ error: 'Body too large', message: 'Слишком много записей. Сократи период команды.' }, 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      if (!text.trim()) return emptyBody();
      const input = JSON.parse(text);
      let body, skipped = [];
      if (input?.version === 2) {
        const summary = summarizeSamples(input);
        skipped = summary.skipped;
        if (!summary.days.length) return reply({ status: 'no_data', records: 0,
          message: 'Нет дней с обоими показателями YAZIO. Проверь доступ команды к пищевой энергии и белку. Прежние данные WEDX сохранены.' }, 200);
        // Each execution is a fresh full snapshot. Retrying is safe because the
        // database replaces daily totals; a later correction can also revert them.
        body = validateImport({ version: 1, source: input.source, requestId: crypto.randomUUID(), days: summary.days });
      } else {
        if (bytes > 65536) return reply({ error: 'Body too large' }, 413);
        if (input?.version !== 1) return reply({ error: 'unsupported_payload', message: 'Формат отправки команды не поддерживается. Установи актуальную команду WEDX; ключ менять не нужно.' }, 400);
        body = validateImport(input);
      }
      const { data, error } = await rpc('ingest_nutrition', {
        p_token_hash: await sha256(token), p_request_id: body.requestId,
        p_payload_hash: await sha256(JSON.stringify({ source: body.source, days: body.days })), p_days: body.days,
      });
      if (error) {
        const status = error.code === '28000' ? 401 : error.code === '23505' ? 409 : error.code === 'P0001' ? 429 : 503;
        return reply({ error: status === 401 ? 'Invalid integration token' : status === 409 ? 'Request id already used' : status === 429 ? 'Too many imports' : 'Import temporarily unavailable',
          message: status === 401 ? 'Ключ отключён или неверен. Создай новый ключ в WEDX.' : status === 429 ? 'Слишком частые запуски. Повтори через минуту.' : 'Питание не сохранено. Повтори импорт позже.' }, status);
      }
      return reply({ ...data, skippedDays: skipped,
        message: `Дней обновлено: ${data.records}.${skipped.length ? ` Пропущено дней без одного из показателей: ${skipped.length}.` : ''} Сверь калории и белок в WEDX с YAZIO.` }, 200);
    } catch (error) {
      if (error instanceof SampleImportError) return reply({ error: 'Invalid health samples', message: error.message }, 400);
      if (error instanceof SyntaxError) return reply({ error: 'invalid_json', message: 'Команда отправила данные в неверном формате JSON. Установи исправленную команду WEDX; ключ менять не нужно.' }, 400);
      if (error.message.startsWith('Expected ') || error.message.startsWith('Invalid date')) return reply({ error: 'invalid_days', message: 'В запросе неверные даты или дневные итоги. Данные WEDX не изменены.' }, 400);
      return reply({ error: 'Import temporarily unavailable' }, 503);
    }
  };
}
