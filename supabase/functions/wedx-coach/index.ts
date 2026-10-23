import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js';
import { z } from 'npm:zod@4.6.7';
import { SignJWT, importJWK } from 'npm:jose@6.2.13';
import { createCoachHandler } from './auth.js';
import { createMcpServer } from './mcp.js';

const url = Deno.env.get('SUPABASE_URL')!;
const client = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const baseUrl = `${url}/functions/v1/wedx-coach`;
let signing: any;
async function signingKey() {
  if (!signing) {
    const { data, error } = await client.rpc('coach_signing_key');
    if (error || !data?.privateJwk || !data?.publicJwk) throw new Error('Signing unavailable');
    signing = { publicJwk: data.publicJwk, privateKey: await importJWK(data.privateJwk, 'RS256') };
  }
  return signing;
}
async function result(query: any) { const { data, error } = await query; if (error) throw new Error('Database unavailable'); return data; }
function repository(owner: string) {
  // Every query is bound to the owner resolved from a verified coach token.
  return {
    workout: () => result(client.from('workout_state').select('snapshot,revision,updated_at').eq('user_id', owner).maybeSingle()),
    preferences: () => result(client.from('coach_preferences').select('goal,timezone').eq('user_id', owner).maybeSingle()),
    nutrition: (start: string, end: string) => result(client.from('nutrition_daily')
      .select('day,nutrition_origin,calories_kcal,protein_grams,carbs_grams,fat_grams,calories_burned,activity_status,metric_synced_at,updated_at')
      .eq('user_id', owner).gte('day', start).lte('day', end).order('day').limit(367)),
    goals: (end: string) => result(client.from('nutrition_goals').select('effective_from,base_calorie_goal,protein_goal_g,protein_per_kg,include_activity,source,updated_at')
      .eq('user_id', owner).lte('effective_from', end).order('effective_from', { ascending: false }).limit(400)),
  };
}
Deno.serve(createCoachHandler({ baseUrl, appUrl: 'https://azamatyessimkhanily.github.io/WEDX/',
  publicKeys: async () => ({ keys: [(await signingKey()).publicJwk] }),
  issueIdToken: async ({ user, client: audience, nonce }: any) => {
    const key = await signingKey();
    return new SignJWT(nonce ? { nonce } : {}).setProtectedHeader({ alg: 'RS256', kid: key.publicJwk.kid })
      .setIssuer(baseUrl).setAudience(audience).setSubject(user).setIssuedAt().setExpirationTime('1h').sign(key.privateKey);
  },
  rpc: (name: string, args: any) => client.rpc(name, args),
  getUser: async (token: string) => (await client.auth.getUser(token)).data.user,
  store: {
    request: (id: string) => result(client.from('coach_oauth_requests').select('status,expires_at').eq('id', id).maybeSingle()),
    connections: (owner: string) => result(client.from('coach_oauth_grants').select('id,created_at,last_used_at,revoked_at')
      .eq('user_id', owner).is('revoked_at', null).gt('refresh_expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(20)),
    revoke: (owner: string, id: string) => result(client.from('coach_oauth_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', owner).eq('id', id)),
  },
  mcp: async (request: Request, owner: string) => {
    const server = createMcpServer(McpServer, z, repository(owner));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  },
}));
