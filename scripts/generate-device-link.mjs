import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// Administrator-only command. Never include its service key in a VITE_ variable.
const projectUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerId = process.env.WEDX_OWNER_ID;
const appUrl = process.env.WEDX_APP_URL;
if (!projectUrl || !serviceKey || !ownerId || !appUrl) {
  throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEDX_OWNER_ID and WEDX_APP_URL in the administrator environment.');
}
const url = new URL(appUrl);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
  throw new Error('Use an HTTPS app URL or localhost for development.');
}
const client = createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
// Resolve an existing owner first: generateLink must never create a misspelled account.
const { data: owner, error: ownerError } = await client.auth.admin.getUserById(ownerId);
if (ownerError || !owner.user?.email) throw new Error('Existing owner account was not found.');
const { data, error } = await client.auth.admin.generateLink({ type: 'magiclink', email: owner.user.email });
if (error || !data.properties?.hashed_token || data.user?.id !== ownerId) {
  throw new Error('Could not generate the owner device link.');
}
url.hash = new URLSearchParams({ connect: data.properties.hashed_token }).toString();
await mkdir('.local', { recursive: true, mode: 0o700 });
await writeFile('.local/device-link.txt', url.href + '\n', { mode: 0o600 });
console.log('Личная одноразовая ссылка сохранена в .local/device-link.txt. Письмо не отправлялось.');
