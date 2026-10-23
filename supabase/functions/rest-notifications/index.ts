import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import webpush from 'npm:web-push@3.6.7';
import { createRestHandler, validSubscription, pushOptions } from './handler.js';

const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let cached: any = null, loadedAt = 0;
async function configuration() {
  if (cached && Date.now() - loadedAt < 300000) return cached;
  const { data, error } = await client.rpc('rest_push_credentials');
  if (error || !data?.publicKey || !data?.privateKey || !data?.dispatchSecret) throw new Error('Push not configured');
  cached = data; loadedAt = Date.now(); return cached;
}
Deno.serve(createRestHandler({
  configuration,
  getUser: async (token: string) => (await client.auth.getUser(token)).data.user,
  getDevice: async (owner: string, id: string) => (await client.from('rest_push_devices').select('enabled').eq('id', id).eq('user_id', owner).maybeSingle()).data,
  rpc: (name: string, args: Record<string, unknown>) => client.rpc(name, args),
  sendPush: async (job: any, config: any) => {
    const subscription = { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth_key } };
    if (!validSubscription(subscription)) return 410;
    const payload = JSON.stringify({ title: job.kind === 'test' ? 'WEDX · Проверка' : 'Отдых закончен',
      body: job.label, tag: `wedx-${job.kind}-${job.device_id}-${job.revision}`, url: '/WEDX/', revision: job.revision });
    const details = webpush.generateRequestDetails(subscription, payload, pushOptions(job.kind, config));
    const response = await fetch(details.endpoint, { method: 'POST', headers: details.headers, body: details.body,
      signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) {
      let reason = 'unknown';
      try { const body = await response.json(); if (/^[A-Za-z0-9_]{1,80}$/.test(body.reason)) reason = body.reason; } catch {}
      // No endpoint, keys or workout details in diagnostic logs.
      console.warn(JSON.stringify({ event: 'rest_push_rejected', status: response.status, reason }));
    } else await response.body?.cancel();
    return response.status;
  },
}));
