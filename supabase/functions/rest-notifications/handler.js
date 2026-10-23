const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGINS = new Set(['https://azamatyessimkhanily.github.io', 'http://127.0.0.1:4173']);
export function pushOptions(kind, config) {
  // Canonical base64 topics also pass Apple's stricter Topic validation.
  return { TTL: 30, urgency: 'high', topic: btoa(kind === 'test' ? 'wedx-test' : 'wedx-rest'),
    vapidDetails: { subject: 'https://azamatyessimkhanily.github.io/WEDX/', publicKey: config.publicKey, privateKey: config.privateKey } };
}
export function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed = host.endsWith('.push.apple.com') || host === 'fcm.googleapis.com'
      || host.endsWith('.push.services.mozilla.com');
    const key = value.keys?.p256dh, auth = value.keys?.auth;
    const decode = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash
      && allowed && value.endpoint.length <= 2048 && /^[\w-]{87}=?$/.test(key) && /^[\w-]{22}={0,2}$/.test(auth)
      && decode(key).length === 65 && decode(key)[0] === 4 && decode(auth).length === 16;
  } catch { return false; }
}

export function createRestHandler({ getUser, getDevice, rpc, configuration, sendPush }) {
  return async request => {
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (ORIGINS.has(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST,OPTIONS' });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !ORIGINS.has(origin)) return reply({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'JSON required' }, 400);
      let raw = '', bytes = 0; const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 8192) { await reader.cancel(); return reply({ error: 'Too large' }, 413); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode(); const input = JSON.parse(raw);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'JSON object required' }, 400);
      if (input?.action === 'dispatch') {
        const config = await configuration();
        if (!config.dispatchSecret || request.headers.get('X-WEDX-Dispatch') !== config.dispatchSecret) return reply({ error: 'Unauthorized' }, 401);
        const { data: jobs, error } = await rpc('claim_rest_push', {}); if (error) throw error;
        let sent = 0;
        await Promise.all(jobs.map(async job => {
          const args = { p_device_id: job.device_id, p_kind: job.kind, p_revision: job.revision, p_claim_id: job.claim_id };
          const current = await rpc('rest_push_current', args);
          if (current.error || !current.data) return;
          let result;
          try {
            const status = await sendPush(job, config);
            result = status >= 200 && status < 300 ? 'sent' : [404, 410].includes(status) ? 'gone'
              : status === 429 || status >= 500 ? 'retry' : 'failed';
          } catch { result = 'retry'; }
          if (result === 'sent') sent++;
          const finished = await rpc('finish_rest_push', { ...args, p_result: result });
          if (finished.error) throw finished.error;
        }));
        return reply({ processed: jobs.length, sent });
      }
      const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
      const user = token ? await getUser(token) : null;
      if (!user?.id) return reply({ error: 'Подключи это устройство к WEDX.' }, 401);
      if (input.action === 'config') {
        const config = await configuration();
        const device = UUID.test(input.deviceId || '') ? await getDevice(user.id, input.deviceId) : null;
        return reply({ publicKey: config.publicKey, enabled: Boolean(device?.enabled) });
      }
      let name, args;
      if (input.action === 'subscribe') {
        if (!validSubscription(input.subscription)) return reply({ error: 'Неверная подписка уведомлений.' }, 400);
        name = 'register_rest_push'; args = { p_user_id: user.id, p_endpoint: input.subscription.endpoint,
          p_p256dh: input.subscription.keys.p256dh, p_auth: input.subscription.keys.auth };
      } else {
        if (!UUID.test(input.deviceId || '')) return reply({ error: 'Сначала включи уведомления.' }, 400);
        if (input.action === 'disable') { name = 'disable_rest_push'; args = { p_user_id: user.id, p_device_id: input.deviceId }; }
        else if (['schedule', 'cancel', 'test'].includes(input.action)) {
          if (!Number.isSafeInteger(input.revision) || input.revision <= 0) return reply({ error: 'Неверный таймер.' }, 400);
          const remaining = input.action === 'test' ? 10000 : input.action === 'cancel' ? null : input.remainingMs;
          if (remaining !== null && (!Number.isInteger(remaining) || remaining < 1 || remaining > 1800000)) return reply({ error: 'Таймер должен быть от 1 секунды до 30 минут.' }, 400);
          name = 'schedule_rest_push'; args = { p_user_id: user.id, p_device_id: input.deviceId, p_revision: input.revision,
            p_remaining_ms: remaining, p_label: input.action === 'test' ? 'Проверка уведомлений WEDX' : String(input.label || 'Следующий подход').replace(/[\x00-\x1f]/g, '').slice(0, 160),
            p_kind: input.action === 'test' ? 'test' : 'rest' };
        } else return reply({ error: 'Unknown action' }, 400);
      }
      const { data, error } = await rpc(name, args);
      if (error) return reply({ error: error.code === '42501' ? 'Подключение недоступно. Включи уведомления заново.'
        : error.code === 'P0001' ? 'Подожди 30 секунд перед повторной проверкой.' : 'Не удалось сохранить уведомление.' }, error.code === '42501' ? 403 : error.code === 'P0001' ? 429 : 400);
      return reply(input.action === 'subscribe' ? { deviceId: data } : { ok: true, ...data });
    } catch (error) {
      return reply({ error: error instanceof SyntaxError ? 'Invalid JSON' : 'Сервис уведомлений временно недоступен.' }, error instanceof SyntaxError ? 400 : 503);
    }
  };
}
