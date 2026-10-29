import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {ownerA,ownerB} from '../fixtures.js';
import {normalizeSleep} from '../../supabase/functions/sleep-import/validation.js';
const source='Apple Watch SE 2';
const sample=(value,start='2026-10-27T23:00:00+05:00',end='2026-10-28T07:00:00+05:00',extra={})=>({metric:'sleep',source,start,end,value,...extra});
async function connect(page,rows=[]) {
  const state={owner:ownerA,rows,queries:[],imports:[],fail:false,hold:null};
  await page.clock.install({time:new Date('2026-10-28T08:00:00Z')});
  await page.route('http://127.0.0.1:54321/**',async route=>{
    const {pathname,searchParams}=new URL(route.request().url());
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(pathname==='/auth/v1/verify'){
      state.owner=route.request().postDataJSON().token_hash==='a'.repeat(64)?ownerA:ownerB;
      return json({access_token:'mock',refresh_token:'mock-refresh',token_type:'bearer',expires_in:86400,
        user:{id:state.owner,aud:'authenticated',role:'authenticated',created_at:new Date().toISOString(),app_metadata:{},user_metadata:{}}});
    }
    if(pathname==='/rest/v1/rpc/save_workout_state')return json({status:'saved',revision:1});
    if(pathname==='/rest/v1/sleep_samples') {
      state.queries.push(Object.fromEntries(searchParams));const rows=structuredClone(state.rows);
      if(state.hold){const hold=state.hold;state.hold=null;await hold;}
      const offset=Number(searchParams.get('offset')||0),limit=Number(searchParams.get('limit')||1000);
      return state.fail?json({message:'Unavailable'},500):json(rows.slice(offset,offset+limit));
    }
    if(pathname==='/functions/v1/sleep-import') {
      const body=route.request().postDataJSON();state.imports.push(body);
      const normalized=await normalizeSleep(body);
      const merged=new Map(state.rows.map(s=>[s.sample_key,s]));for(const row of normalized)merged.set(row.sample_key,row);state.rows=[...merged.values()];
      return json({status:'imported',records:normalized.length});
    }
    return json([]);
  });
  await page.goto('/?view=sleep#connect='+'a'.repeat(64));
  await page.getByRole('button',{name:'Подключить это устройство',exact:true}).click();
  await expect(page.locator('wedx-sleep')).toBeVisible();
  await expect(page.locator('.sleep-status')).toBeHidden();return state;
}
test('SE 2 sleep displays separate stages, night vitals and missing data on mobile',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const rows=await normalizeSleep({version:1,source:'apple-health',samples:[
    sample('Core','2026-10-27T23:00:00+05:00','2026-10-28T02:00:00+05:00'),
    sample('Deep','2026-10-28T02:00:00+05:00','2026-10-28T03:00:00+05:00'),
    sample('Awake','2026-10-28T03:00:00+05:00','2026-10-28T03:10:00+05:00'),
    sample('REM','2026-10-28T03:10:00+05:00','2026-10-28T07:00:00+05:00'),
    sample(56,'2026-10-28T02:00:00+05:00','2026-10-28T02:00:00+05:00',{metric:'heart_rate',unit:'count/min'}),
  ]});
  const state=await connect(page,rows);
  await expect(page.locator('.sleep-duration')).toHaveText('7 ч 50 мин');
  await expect(page.locator('.sleep-vitals')).toContainText('56 уд/мин');
  await expect(page.locator('.sleep-vitals')).toContainText('Нет данных');
  await page.locator('.sleep-segment[data-stage=deep]').click();
  await expect(page.locator('.sleep-chart')).toContainText('Глубокий · 02:00 · 1 ч 0 мин');
  expect(state.queries.every(q=>q.user_id===`eq.${ownerA}`)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const monthWidth=await page.getByLabel('Месяц сна',{exact:true}).evaluate(n=>n.getBoundingClientRect().width);
  expect(monthWidth).toBeGreaterThan(150);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'test-results/sleep-mobile.png',fullPage:true});
  state.fail=true;await page.getByRole('button',{name:'↻ Обновить сон',exact:true}).click();
  await expect(page.locator('.sleep-status')).toContainText('Не удалось');await expect(page.locator('.sleep-duration')).toHaveText('7 ч 50 мин');
  state.fail=false;
  await page.getByRole('button',{name:'Питание',exact:true}).click();await expect(page.locator('wedx-sleep')).toHaveCount(0);
  expect(errors).toEqual([]);
});

const xml=`<?xml version="1.0"?><HealthData>
<Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed" sourceName="YAZIO" value="2000" unit="kcal" startDate="2026-10-27 23:00:00 +0500" endDate="2026-10-27 23:00:00 +0500"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch SE 2" value="54" unit="count/min" startDate="2026-10-28 02:00:00 +0500" endDate="2026-10-28 02:00:00 +0500"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch SE 2" value="150" unit="count/min" startDate="2026-10-28 12:00:00 +0500" endDate="2026-10-28 12:00:00 +0500"/>
<Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Apple Watch SE 2" sourceVersion="26" device="Watch, SE 2" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-10-27 23:00:00 +0500" endDate="2026-10-28 07:00:00 +0500"><MetadataEntry key="HKTimeZone" value="Asia/Almaty"/></Record>
</HealthData>`;
for(const format of ['xml','zip'])test(`Health ${format} import preserves stages/metadata and uploads only sleep and night measurements`,async({page})=>{
  const state=await connect(page);
  await page.getByText('Подключить сон с Apple Watch',{exact:true}).click();
  await page.getByText('Загрузить всю историю и дополнительные показатели',{exact:true}).click();
  const buffer=format==='xml'?Buffer.from(xml):execFileSync('python3',['-c',"import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('apple_health_export/export.xml',sys.stdin.read())\nsys.stdout.buffer.write(b.getvalue())"],{input:xml});
  await page.getByLabel('Экспорт Apple Health').setInputFiles({name:`export.${format}`,mimeType:format==='xml'?'application/xml':'application/zip',buffer});
  await expect(page.getByText('Готово. Сохранено записей: 2.',{exact:true})).toBeVisible();
  await expect(page.locator('.sleep-duration')).toHaveText('8 ч 0 мин');
  expect(state.imports.length).toBe(2);expect(state.imports[0].samples[0].metric).toBe('sleep');
  expect(state.imports[0].samples[0].metadata).toEqual({HKTimeZone:'Asia/Almaty'});
  expect(state.imports[1].samples).toHaveLength(1);expect(state.imports[1].samples[0].value).toBe('54');
  await page.getByLabel('Экспорт Apple Health').setInputFiles({name:`export.${format}`,mimeType:'application/octet-stream',buffer});
  await expect(page.getByText('Готово. Сохранено записей: 2.',{exact:true})).toBeVisible();
  await expect(page.locator('.sleep-night')).toHaveCount(1);
});
test('account changes discard an in-flight sleep response and old timers',async({page})=>{
  const rows=await normalizeSleep({version:1,source:'apple-health',samples:[sample('Core')]});
  const state=await connect(page,rows);let release;state.hold=new Promise(resolve=>{release=resolve;});
  const count=state.queries.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>state.queries.length).toBe(count+1);
  state.rows=[];await page.evaluate(()=>{location.hash='#connect='+'b'.repeat(64);});
  await page.getByRole('button',{name:'Подключить это устройство',exact:true}).click();
  await expect(page.locator('.sleep-empty')).toBeVisible();release();
  await page.clock.runFor(60100);await expect(page.locator('.sleep-night')).toHaveCount(0);
  expect(state.queries.at(-1).user_id).toBe(`eq.${ownerB}`);
});
