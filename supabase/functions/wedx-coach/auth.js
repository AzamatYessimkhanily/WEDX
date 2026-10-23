const SCOPE = 'wedx:read';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (size = 32) => base64url(crypto.getRandomValues(new Uint8Array(size)));
export const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
export const hash = async text => [...await digest(text)].map(x => x.toString(16).padStart(2, '0')).join('');
export const challenge = async text => base64url(await digest(text));

export async function boundedText(request, limit = 32768) {
  const reader = request.body?.getReader(); if (!reader) return '';
  const decoder = new TextDecoder(); let size = 0, text = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('request_too_large'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// Only ChatGPT's published client documents are fetched. No arbitrary OAuth
// metadata URLs, redirects or private-network destinations are accepted.
export function validClientId(value) {
  return typeof value === 'string' && /^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]{1,160}\/)?client\.json$/.test(value);
}
function validCallback(value) {
  return typeof value === 'string' && /^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[A-Za-z0-9_-]{1,160})$/.test(value);
}
export function clientResolver(fetcher = fetch) {
  const cache = new Map();
  return async id => {
    if (!validClientId(id)) throw new Error('invalid_client');
    const old = cache.get(id); if (old?.until > Date.now()) return old.data;
    const response = await fetcher(id, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('invalid_client');
    const doc = JSON.parse(await boundedText(response, 16384));
    const methods = doc.token_endpoint_auth_methods_supported || [doc.token_endpoint_auth_method || 'none'];
    if (doc.client_id !== id || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length
      || !doc.redirect_uris.every(validCallback) || !methods.includes('none')) throw new Error('invalid_client');
    const data = { id, redirects: doc.redirect_uris };
    if (cache.size >= 100) cache.clear(); cache.set(id, { data, until: Date.now() + 300000 });
    return data;
  };
}

export function createCoachHandler({ baseUrl, appUrl, rpc, getUser, store, mcp, publicKeys, issueIdToken, resolveClient = clientResolver() }) {
  const resource = `${baseUrl}/mcp`, metadataUrl = `${baseUrl}/oauth-protected-resource`;
  const origins = new Set([new URL(appUrl).origin, 'https://chatgpt.com', 'http://127.0.0.1:4173']);
  const metadata = { issuer: baseUrl, authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${baseUrl}/authorize`, token_endpoint: `${baseUrl}/token`,
    client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE, 'openid'],
    jwks_uri: `${baseUrl}/jwks`, userinfo_endpoint: `${baseUrl}/userinfo`,
    subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] };
  const validScope = scope => typeof scope === 'string' && scope.split(' ').includes(SCOPE) && scope.split(' ').every(s => [SCOPE, 'openid'].includes(s));
  const checked = async (name, args) => {
    const { data, error } = await rpc(name, args);
    if (error) throw new Error(error.code === 'P0001' ? 'rate_limited' : 'service_unavailable');
    return data;
  };
  return async request => {
    const url = new URL(request.url);
    // Supabase's gateway removes /functions/v1 before forwarding to the worker.
    // Keep the public URL as the canonical OAuth issuer and resource.
    const prefixes = [new URL(baseUrl).pathname, '/' + new URL(baseUrl).pathname.split('/').pop()];
    const prefix = prefixes.find(value => url.pathname.startsWith(value + '/'));
    const path = prefix ? url.pathname.slice(prefix.length) : '';
    const origin = request.headers.get('Origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Vary: 'Origin',
      'Access-Control-Expose-Headers': 'WWW-Authenticate,Mcp-Session-Id,MCP-Protocol-Version' };
    if (origins.has(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info,mcp-protocol-version,mcp-session-id' });
    const reply = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    const authError = () => reply({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"` });
    if (origin && !origins.has(origin)) return reply({ error: 'origin_not_allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      if (request.method === 'GET' && ['/oauth-protected-resource', '/.well-known/oauth-protected-resource'].includes(path)) {
        return reply({ resource, authorization_servers: [baseUrl], scopes_supported: [SCOPE], bearer_methods_supported: ['header'],
          resource_name: 'WEDX — тренер', resource_documentation: appUrl });
      }
      if (request.method === 'GET' && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(path)) return reply(metadata);
      if (request.method === 'GET' && path === '/jwks') return reply(await publicKeys());
      if (path === '/authorize' && request.method === 'GET') {
        const p = url.searchParams;
        if ([...p.keys()].some(key => p.getAll(key).length !== 1)) return reply({ error: 'invalid_request' }, 400);
        const client = await resolveClient(p.get('client_id'));
        if (!client.redirects.includes(p.get('redirect_uri')) || p.get('response_type') !== 'code'
          || p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') || '')
          || p.get('resource') !== resource || !validScope(p.get('scope') || SCOPE) || !p.get('state') || p.get('state').length > 2000
          || (p.get('nonce') || '').length > 500) {
          return reply({ error: 'invalid_request' }, 400);
        }
        const id = await checked('coach_begin_authorization', { p_client: client.id, p_redirect: p.get('redirect_uri'),
          p_resource: resource, p_state: p.get('state'), p_challenge: p.get('code_challenge'),
          p_openid: (p.get('scope') || '').split(' ').includes('openid'), p_nonce: p.get('nonce') });
        const consent = new URL('coach.html', appUrl); consent.searchParams.set('request', id);
        return new Response(null, { status: 302, headers: { ...headers, Location: consent.href } });
      }
      const raw = ['POST', 'DELETE'].includes(request.method) ? await boundedText(request) : '';
      if (path === '/token' && request.method === 'POST') {
        if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return reply({ error: 'invalid_request' }, 400);
        const p = new URLSearchParams(raw);
        if ([...p.keys()].some(key => p.getAll(key).length !== 1) || !validClientId(p.get('client_id'))
          || p.get('resource') !== resource || (p.get('scope') && !validScope(p.get('scope')))) return reply({ error: 'invalid_request' }, 400);
        const access = randomToken(), refresh = randomToken();
        const common = { p_client: p.get('client_id'), p_resource: resource, p_access_hash: await hash(access), p_refresh_hash: await hash(refresh) };
        let result;
        if (p.get('grant_type') === 'authorization_code') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(p.get('code') || '') || !/^[A-Za-z0-9._~-]{43,128}$/.test(p.get('code_verifier') || '')
            || !validCallback(p.get('redirect_uri'))) return reply({ error: 'invalid_grant' }, 400);
          result = await checked('coach_exchange_code', { ...common, p_hash: await hash(p.get('code')),
            p_redirect: p.get('redirect_uri'), p_challenge: await challenge(p.get('code_verifier')) });
        } else if (p.get('grant_type') === 'refresh_token') {
          if (!/^[A-Za-z0-9_-]{43}$/.test(p.get('refresh_token') || '')) return reply({ error: 'invalid_grant' }, 400);
          result = await checked('coach_refresh_token', { ...common, p_hash: await hash(p.get('refresh_token')) });
        } else return reply({ error: 'unsupported_grant_type' }, 400);
        if (result.error) return reply({ error: result.error }, 400);
        return reply({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600,
          scope: result.openid ? `${SCOPE} openid` : SCOPE,
          ...(result.openid ? { id_token: await issueIdToken({ user: result.user_id, client: p.get('client_id'), nonce: result.nonce }) } : {}) });
      }
      if (path === '/request' && request.method === 'GET') {
        const id = url.searchParams.get('id'); if (!UUID.test(id || '')) return reply({ error: 'invalid_request' }, 400);
        const pending = await store.request(id);
        if (!pending || pending.status !== 'pending' || Date.parse(pending.expires_at) <= Date.now()) return reply({ error: 'expired_request' }, 400);
        return reply({ client: 'ChatGPT', scope: SCOPE, expires_at: pending.expires_at });
      }
      const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
      if (path === '/mcp' || path === '/userinfo' && request.method === 'GET') {
        if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return authError();
        const identity = await checked('coach_read_access', { p_hash: await hash(token), p_resource: resource });
        if (identity.error === 'rate_limited') return reply({ error: 'rate_limited' }, 429, { 'Retry-After': '60' });
        if (identity.error || !identity.user_id) return authError();
        if (path === '/userinfo') return identity.openid ? reply({ sub: identity.user_id }) : reply({ error: 'insufficient_scope' }, 403);
        const copy = new Request(request.url, { method: request.method, headers: request.headers, ...(raw ? { body: raw } : {}) });
        const response = await mcp(copy, identity.user_id);
        for (const [key, value] of Object.entries(headers)) if (key !== 'Content-Type') response.headers.set(key, value);
        return response;
      }
      if (!['/approve', '/manage'].includes(path) || request.method !== 'POST') return reply({ error: 'not_found' }, 404);
      const input = JSON.parse(raw);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'invalid_request' }, 400);
      const user = token ? await getUser(token) : null;
      if (path === '/approve') {
        if (!UUID.test(input.requestId || '')) return reply({ error: 'invalid_request' }, 400);
        const code = randomToken(), pair = typeof input.pairingCode === 'string' ? input.pairingCode.trim() : '';
        if (!input.deny && !user?.id && !/^[A-Za-z0-9_-]{32}$/.test(pair)) return reply({ error: 'invalid_pairing_code' }, 400);
        const result = await checked('coach_approve_authorization', { p_request: input.requestId, p_user_id: user?.id || null,
          p_pairing_hash: pair ? await hash(pair) : null, p_code_hash: await hash(code), p_deny: input.deny === true });
        if (result.error) return reply({ error: result.error }, 400);
        const callback = new URL(result.redirect_uri);
        callback.searchParams.set(input.deny ? 'error' : 'code', input.deny ? 'access_denied' : code);
        callback.searchParams.set('state', result.state); callback.searchParams.set('iss', baseUrl);
        return reply({ redirect: callback.href });
      }
      if (!user?.id) return authError();
      if (input.action === 'pair') {
        const code = randomToken(24);
        await checked('coach_create_pairing', { p_user_id: user.id, p_hash: await hash(code) });
        return reply({ pairingCode: code, expiresIn: 600, serverUrl: resource });
      }
      if (input.action === 'status') return reply({ serverUrl: resource, connections: await store.connections(user.id) });
      if (input.action === 'revoke' && UUID.test(input.id || '')) { await store.revoke(user.id, input.id); return reply({ ok: true }); }
      return reply({ error: 'invalid_request' }, 400);
    } catch (error) {
      const known = ['invalid_client', 'rate_limited', 'request_too_large'];
      const code = error instanceof SyntaxError ? 'invalid_request' : known.includes(error.message) ? error.message : 'service_unavailable';
      return reply({ error: code }, code === 'request_too_large' ? 413 : code === 'rate_limited' ? 429 : code === 'service_unavailable' ? 503 : 400);
    }
  };
}
