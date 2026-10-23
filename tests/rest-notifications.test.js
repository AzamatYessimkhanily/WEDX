import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import webpush from 'web-push';
import { createRestHandler, validSubscription, pushOptions } from '../supabase/functions/rest-notifications/handler.js';
import { ownerA } from './fixtures.js';
const device = '11111111-1111-4111-8111-111111111112';
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
const request = (body, token = 'valid', headers = {}) => new Request('https://example.com/push', { method: 'POST', headers: { Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

test('web push accepts browser key shapes, rejects arbitrary destinations and builds encrypted standard payloads', () => {
  assert.equal(validSubscription(subscription),true);
  for (const endpoint of ['http://web.push.apple.com/test','https://127.0.0.1/secret','https://web.push.apple.com.attacker.com/x','https://user:pass@web.push.apple.com/x','https://web.push.apple.com:8443/x']) {
    assert.equal(validSubscription({...subscription,endpoint}),false);
  }
  assert.equal(validSubscription({...subscription,keys:{...subscription.keys,p256dh:'invalid'}}),false);
  const keys=webpush.generateVAPIDKeys();
  const topics=[];
  for (const kind of ['rest','test']) {
    const encrypted=webpush.generateRequestDetails(subscription,'Private rest reminder',pushOptions(kind,keys));
    assert.equal(encrypted.headers.TTL,30); assert.equal(encrypted.headers['Content-Encoding'],'aes128gcm');
    assert.ok(!encrypted.body.toString().includes('Private rest reminder'));
    const topic=encrypted.headers.Topic; topics.push(topic);
    assert.match(topic,/^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(topic.length%4,0);
    assert.equal(Buffer.from(topic,'base64url').toString('base64url'),topic);
  }
  assert.notEqual(topics[0],topics[1]);
});

test('requests require a real user, scope timer writes and keep dispatcher credentials out of config responses', async () => {
  const calls=[];
  const handler=createRestHandler({getUser:async token=>token==='valid'?{id:ownerA}:null,getDevice:async()=>({enabled:true}),
    configuration:async()=>({publicKey:'public',privateKey:'never-visible',dispatchSecret:'secret'}),
    rpc:async(name,args)=>{calls.push({name,args});return {data:{accepted:true}};},sendPush:async()=>201});
  assert.equal((await handler(request({action:'schedule'},'invalid'))).status,401);
  assert.equal((await handler(request(null))).status,400);
  assert.equal((await handler(request({action:'dispatch'}))).status,401);
  assert.equal(calls.length,0);
  const config=await (await handler(request({action:'config',deviceId:device}))).json();
  assert.deepEqual(config,{publicKey:'public',enabled:true});
  assert.equal((await handler(request({action:'schedule',deviceId:device,revision:1,remainingMs:30000,label:'Set 2',userId:'wrong'}))).status,200);
  assert.equal(calls[0].args.p_user_id,ownerA); assert.equal(calls[0].args.p_remaining_ms,30000);
  assert.equal((await handler(request({action:'schedule',deviceId:device,revision:2,remainingMs:9000000}))).status,400);
  assert.equal((await handler(request({action:'config'},'valid',{Origin:'https://attacker.com'}))).status,403);
});

test('dispatcher suppresses superseded timers and retires dead endpoints without exposing subscriptions', async () => {
  const calls=[], deliveries=[];
  const jobs=[{device_id:device,kind:'rest',revision:1,claim_id:device},{device_id:device,kind:'test',revision:2,claim_id:device}];
  const handler=createRestHandler({getUser:async()=>null,getDevice:async()=>null,configuration:async()=>({dispatchSecret:'secret'}),
    rpc:async(name,args)=>{calls.push({name,args});return {data:name==='claim_rest_push'?jobs:name==='rest_push_current'?args.p_revision===2:null};},
    sendPush:async job=>{deliveries.push(job);return 410;}});
  const result=await handler(request({action:'dispatch'},'',{'X-WEDX-Dispatch':'secret'}));
  assert.equal(result.status,200); assert.equal(deliveries.length,1);
  assert.equal(calls.find(c=>c.name==='finish_rest_push').args.p_result,'gone');
  assert.deepEqual(await result.json(),{processed:2,sent:0});
});

test('service worker displays a push without an open page and notification clicks stay inside WEDX', async () => {
  const events={}, notifications=[], opened=[];
  const context={BASE:'/WEDX/', URL, self:{location:{origin:'https://azamatyessimkhanily.github.io'},
    addEventListener:(name,fn)=>{events[name]=fn;},registration:{showNotification:async(...args)=>notifications.push(args)},
    clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}}};
  vm.runInNewContext(await readFile(new URL('../src/service-worker.js',import.meta.url),'utf8'),context);
  let pending;
  events.push({data:{json:()=>({title:'Отдых закончен',body:'Следующий подход',tag:'same-delivery',url:'https://attacker.com'})},waitUntil:p=>{pending=p;}});
  await pending; assert.equal(notifications.length,1); assert.equal(notifications[0][1].renotify,false);
  events.notificationclick({notification:{close(){}},waitUntil:p=>{pending=p;}}); await pending;
  assert.deepEqual(opened,['/WEDX/']);
});
