import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createHandler } from './handler.js';

// These secrets exist only inside Supabase, never in the web build or iPhone shortcut.
const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(createHandler((name: string, args: Record<string, unknown>) => client.rpc(name, args)));
