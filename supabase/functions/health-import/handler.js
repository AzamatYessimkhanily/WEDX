import { validateImport } from './validation.js';

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function reply(body, status) { return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }

export function createHandler(rpc) {
  return async request => {
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    const token = request.headers.get('Authorization')?.match(/^Bearer (wedx_[a-f0-9]{64})$/)?.[1];
    if (!token) return reply({ error: 'Integration token required' }, 401);
    if (!request.headers.get('Content-Type')?.includes('application/json')) return reply({ error: 'JSON required' }, 415);
    // Bound streamed bodies even when Content-Length is absent or inaccurate.
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: 'Body required' }, 400);
    let text = '', bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); return reply({ error: 'Body too large' }, 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const body = validateImport(JSON.parse(text));
      const { data, error } = await rpc('ingest_nutrition', {
        p_token_hash: await sha256(token), p_request_id: body.requestId,
        p_payload_hash: await sha256(JSON.stringify({ source: body.source, days: body.days })), p_days: body.days,
      });
      if (error) {
        const status = error.code === '28000' ? 401 : error.code === '23505' ? 409 : error.code === 'P0001' ? 429 : 503;
        return reply({ error: status === 401 ? 'Invalid integration token' : status === 409 ? 'Request id already used' : status === 429 ? 'Too many imports' : 'Import temporarily unavailable' }, status);
      }
      return reply(data, 200);
    } catch (error) {
      if (error instanceof SyntaxError || error.message.startsWith('Expected ') || error.message.startsWith('Invalid date')) return reply({ error: 'Invalid import payload' }, 400);
      return reply({ error: 'Import temporarily unavailable' }, 503);
    }
  };
}
