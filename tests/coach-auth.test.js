import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { discoverAuthorizationServerMetadata } from '@modelcontextprotocol/sdk/client/auth.js';
import { z } from 'zod';
import { createCoachHandler, clientResolver, validClientId, challenge, hash } from '../supabase/functions/wedx-coach/auth.js';
import { createMcpServer } from '../supabase/functions/wedx-coach/mcp.js';
import { ownerA, ownerB, workout } from './fixtures.js';
const baseUrl='https://example.com/functions/v1/wedx-coach', resource=baseUrl+'/mcp';
const clientId='https://chatgpt.com/oauth/client.json',redirect='https://chatgpt.com/connector_platform_oauth_redirect';
const id='11111111-1111-4111-8111-111111111112',token='a'.repeat(43);
const repository={workout:async()=>({snapshot:workout}),preferences:async()=>null,nutrition:async()=>[],goals:async()=>[]};
function setup() {
  const calls=[];
  const handler=createCoachHandler({baseUrl,appUrl:'https://azamatyessimkhanily.github.io/WEDX/',
    resolveClient:async value=>{if(value!==clientId)throw Error('invalid_client');return {id:clientId,redirects:[redirect]};},
    getUser:async t=>t==='app-token'?{id:ownerA}:null,
    store:{request:async()=>({status:'pending',expires_at:new Date(Date.now()+60000).toISOString()}),connections:async owner=>{calls.push({owner});return [];},revoke:async(owner,target)=>calls.push({owner,target})},
    rpc:async(name,args)=>{calls.push({name,args});return {data:name==='coach_begin_authorization'?id:name==='coach_read_access'
      ?args.p_hash===await hash(token)?{user_id:ownerA}:{error:'invalid_token'}:name==='coach_approve_authorization'?{redirect_uri:redirect,state:'original-state'}:{}};},
    mcp:async(request,owner)=>{
      assert.equal(owner,ownerA);
      const server=createMcpServer(McpServer,z,repository),transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true});
      await server.connect(transport);
      try {const r=await transport.handleRequest(request);return new Response(await r.arrayBuffer(),{status:r.status,headers:r.headers});}
      finally{await server.close();}
    },
  });
  const request=(path,body,auth)=>handler(new Request(baseUrl+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${auth}`}:{})},...(body?{body:JSON.stringify(body)}:{})}));
  return {handler,request,calls};
}
test('coach discovery works through the official SDK for a subpath issuer; anonymous requests reveal no health data', async()=>{
  const {handler,request}=setup();
  const unauth=await request('/mcp');assert.equal(unauth.status,401);assert.ok(unauth.headers.get('WWW-Authenticate').includes('/oauth-protected-resource'));
  const seen=[];
  const metadata=await discoverAuthorizationServerMetadata(baseUrl,{fetchFn:async(input,init)=>{
    const url=String(input);seen.push(url);
    return url.startsWith(baseUrl)?handler(new Request(input,init)):new Response('',{status:404});
  }});
  assert.equal(metadata.issuer,baseUrl);assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  assert.ok(seen.some(u=>u===baseUrl+'/.well-known/openid-configuration'));
  assert.equal((await request('/mcp',null,'invalid')).status,401);
  const forwarded = await handler(new Request('http://worker/wedx-coach/.well-known/openid-configuration'));
  assert.equal(forwarded.status,200); assert.equal((await forwarded.json()).issuer,baseUrl);
  assert.equal((await handler(new Request('http://worker/wedx-coach/mcp'))).status,401);
});
test('coach authorization validates callbacks and PKCE; management takes owner only from verified app credentials',async()=>{
  const {handler,request,calls}=setup();
  const p=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',resource,scope:'wedx:read',state:'test',code_challenge:'A'.repeat(43),code_challenge_method:'S256'});
  const valid=await request('/authorize?'+p);assert.equal(valid.status,302);assert.equal(new URL(valid.headers.get('Location')).pathname,'/WEDX/coach.html');
  p.set('redirect_uri','https://attacker.com/');assert.equal((await request('/authorize?'+p)).status,400);
  assert.equal((await request('/manage',{action:'status'})).status,401);
  await request('/manage',{action:'revoke',id,userId:ownerB},'app-token');assert.deepEqual(calls.at(-1),{owner:ownerA,target:id});
  await request('/approve',{requestId:id,userId:ownerB},'app-token');assert.equal(calls.at(-1).args.p_user_id,ownerA);
  const evil=new Request(baseUrl+'/manage',{method:'POST',headers:{Origin:'https://attacker.com'},body:'{}'});
  assert.equal((await handler(evil)).status,403);
  const tokenResponse=await handler(new Request(baseUrl+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,resource,code:token,code_verifier:'v'.repeat(43)})}));
  assert.equal(tokenResponse.status,200);
  assert.equal(calls.at(-1).args.p_challenge,await challenge('v'.repeat(43)));
  assert.equal((await tokenResponse.json()).scope,'wedx:read');
});
test('CIMD lookup rejects arbitrary hosts, redirects and mismatched client metadata',async()=>{
  assert.equal(validClientId('https://chatgpt.com.attacker.com/oauth/client.json'),false);
  let called=0;
  const resolver=clientResolver(async()=>{called++;return Response.json({client_id:clientId,redirect_uris:[redirect],token_endpoint_auth_methods_supported:['none','private_key_jwt']});});
  await assert.rejects(resolver('https://127.0.0.1/private'));assert.equal(called,0);
  assert.deepEqual((await resolver(clientId)).redirects,[redirect]);await resolver(clientId);assert.equal(called,1);
  await assert.rejects(clientResolver(async()=>Response.json({client_id:clientId,redirect_uris:['https://attacker.com'],token_endpoint_auth_method:'none'}))(clientId));
});
test('official MCP client can initialize, list and call every read-only tool over stateless HTTP',async()=>{
  const {handler}=setup();
  const client=new Client({name:'WEDX integration test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:`Bearer ${token}`}},
    fetch:async(input,init)=>handler(new Request(input,init))});
  await client.connect(transport);
  try {
    const listed=await client.listTools();assert.equal(listed.tools.length,6);
    for(const tool of listed.tools){
      assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.annotations.destructiveHint,false);
      const result=await client.callTool({name:tool.name,arguments:{}});assert.notEqual(result.isError,true,JSON.stringify(result));
      assert.ok(result.structuredContent.fetched_at);
    }
    const invalid=await client.callTool({name:'get_nutrition',arguments:{start_date:'2026-02-30'}});assert.equal(invalid.isError,true);
  } finally {await client.close();}
});
