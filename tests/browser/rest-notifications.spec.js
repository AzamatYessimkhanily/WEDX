import { test, expect } from '@playwright/test';
import { createECDH } from 'node:crypto';
import { ownerA } from '../fixtures.js';
const key = createECDH('prime256v1'); key.generateKeys();
const publicKey = key.getPublicKey().toString('base64url');
const deviceId = '11111111-1111-4111-8111-111111111112';

async function setup(page) {
  const state = { enabled: false, requests: [], hold: null };
  await page.clock.setFixedTime(new Date('2026-10-23T10:00:00Z'));
  await page.addInitScript(() => {
    window.permissionRequests = 0;
    let permission = localStorage.getItem('gym-log-v1-rest-push') ? 'granted' : 'default';
    let subscribed = permission === 'granted';
    Object.defineProperty(window, 'Notification', { configurable: true, value: {
      get permission() { return permission; }, requestPermission: async () => { window.permissionRequests++; permission='granted'; return permission; },
    } });
    window.PushManager ||= function() {};
    const subscription = { toJSON: () => ({ endpoint: 'https://web.push.apple.com/browser-test', keys: { p256dh: 'test', auth: 'test' } }), unsubscribe: async () => { subscribed=false; return true; } };
    navigator.serviceWorker.getRegistration = async () => ({ update: async () => {},
      pushManager: { getSubscription: async () => subscribed ? subscription : null, subscribe: async () => { subscribed=true;return subscription; } } });
  });
  await page.route('http://127.0.0.1:54321/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = body => route.fulfill({ status: 200, contentType:'application/json', body:JSON.stringify(body) });
    if (path === '/auth/v1/verify') return json({ access_token:'mock',refresh_token:'mock-refresh',token_type:'bearer',expires_in:3600,
      user:{id:ownerA,aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}} });
    if (path === '/rest/v1/rpc/save_workout_state') return json({status:'saved',revision:1});
    if (path === '/functions/v1/rest-notifications') {
      const body=route.request().postDataJSON();state.requests.push(body);
      if(body.action==='config')return json({publicKey,enabled:state.enabled});
      if(body.action==='subscribe'){state.enabled=true;return json({deviceId});}
      if(body.action==='disable'){state.enabled=false;return json({ok:true});}
      if(body.action==='schedule'&&state.hold){const hold=state.hold;state.hold=null;await hold;}
      return json({accepted:true,revision:body.revision});
    }
    return json([]);
  });
  await page.goto('/#connect='+'a'.repeat(64));
  await page.getByRole('button',{name:'Подключить это устройство',exact:true}).click();
  await page.locator('#days button').filter({hasText:'Пн'}).click();
  await page.locator('.rest-notifications summary').click();
  await expect(page.getByRole('button',{name:'Включить уведомления',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.permissionRequests)).toBe(0);
  await page.getByRole('button',{name:'Включить уведомления',exact:true}).click();
  await expect(page.getByRole('button',{name:'Проверить через 10 секунд',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.permissionRequests)).toBe(1);
  return state;
}

test('rest push opt-in schedules completion, extension and cancellation with increasing revisions', async ({page}) => {
  const state = await setup(page);
  await page.getByRole('button',{name:'Проверить через 10 секунд',exact:true}).click();
  await expect(page.locator('.rest-notifications')).toContainText('Заблокируй iPhone');
  expect(state.requests.filter(r=>r.action==='test')).toHaveLength(1);
  let release;
  state.hold = new Promise(resolve=>{release=resolve;});
  await page.getByRole('button',{name:'Подход 1 выполнен',exact:true}).first().click();
  await expect.poll(()=>state.requests.filter(r=>r.action==='schedule').length).toBe(1);
  await page.locator('#add30').click();
  await expect.poll(()=>state.requests.filter(r=>r.action==='schedule').length).toBe(2);
  const schedules=state.requests.filter(r=>r.action==='schedule');
  expect(schedules[1].remainingMs-schedules[0].remainingMs).toBe(30000);
  expect(schedules[1].revision).toBeGreaterThan(schedules[0].revision);
  await page.locator('#skip').click();
  await expect.poll(()=>state.requests.filter(r=>r.action==='cancel').length).toBe(1);
  expect(state.requests.find(r=>r.action==='cancel').revision).toBeGreaterThan(schedules[1].revision);
  release();
  await expect(page.locator('#timer-push-state')).toBeEmpty();
  await expect(page.locator('#dock')).not.toHaveClass(/up/);
  expect(await page.evaluate(()=>localStorage.getItem('gym-log-v1-rest-timer'))).toBeNull();
  await page.locator('.rest-notifications summary').click();
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:'test-results/rest-push-settings.png',scale:'css'});
});

test('a running rest timer survives reopening; offline scheduling is explicit and disabling cancels server delivery', async ({page,context}) => {
  const state = await setup(page);
  await page.getByRole('button',{name:'Подход 1 выполнен',exact:true}).first().click();
  await expect(page.locator('#timer-push-state')).toHaveText('Уведомление настроено');
  await page.reload();
  await expect(page.locator('#dock')).toHaveClass(/up/);
  await expect(page.locator('#clock')).not.toHaveText('0:00');
  await context.setOffline(true);
  await page.locator('#add30').click();
  await expect(page.locator('#timer-push-state')).toContainText('Нет интернета');
  await page.locator('#skip').click();
  await expect(page.locator('#timer-push-state')).toHaveText('Отмена уведомления ожидает сети');
  await context.setOffline(false);
  await expect(page.locator('#timer-push-state')).toBeEmpty();
  await page.locator('.rest-notifications summary').click();
  await page.getByRole('button',{name:'Выключить',exact:true}).click();
  await expect(page.getByRole('button',{name:'Включить уведомления',exact:true})).toBeVisible();
  expect(state.enabled).toBe(false);
});
