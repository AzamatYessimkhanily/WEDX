import { test, expect } from '@playwright/test';
import { ownerA } from '../fixtures.js';
const id='11111111-1111-4111-8111-111111111112';

test('ChatGPT setup creates an expiring code, copies the MCP address and revokes only the chosen connection',async({page})=>{
  const calls=[];let connected=true;
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}}));
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/auth/v1/verify')return json({access_token:'app-token',refresh_token:'mock',token_type:'bearer',expires_in:3600,
      user:{id:ownerA,aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}}});
    if(path==='/rest/v1/rpc/save_workout_state')return json({status:'saved',revision:1});
    if(path==='/functions/v1/wedx-coach/manage'){
      const body=route.request().postDataJSON();calls.push(body);
      expect(route.request().headers().authorization).toBe('Bearer app-token');
      if(body.action==='pair')return json({pairingCode:'a'.repeat(32),expiresIn:600});
      if(body.action==='revoke'){connected=false;return json({ok:true});}
      return json({connections:connected?[{id,created_at:new Date().toISOString(),last_used_at:null}]:[]});
    }
    return json([]);
  });
  await page.goto('/#connect='+'a'.repeat(64));
  await page.getByRole('button',{name:'Подключить это устройство',exact:true}).click();
  await page.getByRole('button',{name:'Питание',exact:true}).click();
  await page.locator('.coach-settings > summary').click();
  await page.getByRole('button',{name:'Скопировать адрес MCP'}).click();
  expect(await page.evaluate(()=>window.copied)).toBe('http://127.0.0.1:54321/functions/v1/wedx-coach/mcp');
  await page.getByRole('button',{name:'Создать код подключения'}).click();
  await expect(page.getByLabel('Одноразовый код ChatGPT')).toHaveValue('a'.repeat(32));
  expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('a'.repeat(32));
  await page.getByRole('button',{name:'Отключить ChatGPT'}).click();
  await expect(page.locator('.coach-settings > summary')).toHaveText('ChatGPT — тренер');
  expect(calls.find(c=>c.action==='revoke')).toEqual({action:'revoke',id});
});

test('OAuth consent is isolated from the workout editor and redirects only after explicit approval',async({page})=>{
  const original=JSON.stringify({hist:{},bw:[{d:'2026-10-20',w:90}]});let approval;
  await page.addInitScript(value=>localStorage.setItem('gym-log-v1',value),original);
  await page.route('http://127.0.0.1:54321/functions/v1/wedx-coach/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/approve'))approval=route.request().postDataJSON();
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(path.endsWith('/approve')
      ?{redirect:'https://chatgpt.com/connector_platform_oauth_redirect?code=oauth-code&state=bound-state'}:{client:'ChatGPT',scope:'wedx:read'})});
  });
  await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<h1>Connected</h1>'}));
  await page.setViewportSize({width:390,height:844});
  await page.goto('/coach.html?request='+id);
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Разрешить чтение'})).toBeEnabled();
  expect(approval).toBeUndefined();
  expect(await page.evaluate(()=>localStorage.getItem('gym-log-v1'))).toBe(original);
  await page.screenshot({path:'test-results/coach-consent.png',scale:'css'});
  await page.getByLabel('Одноразовый код из WEDX').fill('c'.repeat(32));
  await page.getByRole('button',{name:'Разрешить чтение'}).click();
  await expect(page).toHaveURL(/chatgpt.com\/connector_platform_oauth_redirect/);
  expect(approval).toEqual({requestId:id,pairingCode:'c'.repeat(32),deny:false});
  expect(page.url()).not.toContain('c'.repeat(32));
});
