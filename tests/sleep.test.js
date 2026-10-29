import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { normalizeSleep } from '../supabase/functions/sleep-import/validation.js';
import { createSleepHandler } from '../supabase/functions/sleep-import/handler.js';
import { summarizeSleep } from '../src/domain/sleep.js';
import { loadSleepHistory } from '../src/data/sleep-history.js';

const source='Apple Watch SE 2';
const sample=(value,start='2026-10-27T23:00:00+05:00',end='2026-10-28T07:00:00+05:00',extra={})=>({metric:'sleep',source,start,end,value,...extra});
const input=samples=>({version:1,source:'apple-health',samples});
const normalize=rows=>normalizeSleep(input(rows));

test('sleep stores exact intervals, raw stage, metadata and time zone without counting in-bed twice',async()=>{
  const rows=await normalize([sample('HKCategoryValueSleepAnalysisInBed'),sample('HKCategoryValueSleepAnalysisAsleepCore',undefined,undefined,{metadata:{algorithm:'watch'},device:'SE 2'})]);
  assert.equal(rows.length,2);assert.equal(rows[1].local_end,'2026-10-28T07:00:00+05:00');
  assert.equal(rows[1].end_at,'2026-10-28T02:00:00.000Z');assert.equal(rows[1].device,'SE 2');
  assert.deepEqual(rows[1].metadata,{algorithm:'watch'});
  const episode=summarizeSleep(rows).episodes[0];
  assert.equal(episode.day,'2026-10-28');assert.equal(episode.asleepMinutes,480);
  assert.equal(episode.inBedMinutes,480);assert.equal(episode.efficiency,100);
});
test('duplicate imports and corrected values have a stable identity, unknown stages remain raw',async()=>{
  const before=await normalize([sample('Asleep (Deep)'),sample('Asleep (Deep)')]);
  const after=await normalize([sample('Базовый')]);
  assert.equal(before.length,1);assert.equal(before[0].stage,'deep');assert.equal(before[0].sample_key,after[0].sample_key);
  const unknown=(await normalize([sample('new future stage')]))[0];
  assert.equal(unknown.stage,'unknown');assert.equal(unknown.raw_value,'new future stage');
  assert.equal(summarizeSleep([unknown]).episodes[0].asleepMinutes,null);
});
test('sources, overlapping envelopes, gaps, awakenings and daytime sleep remain separate',async()=>{
  const at=time=>`2026-10-28T${time}:00+05:00`;
  const rows=await normalize([
    sample('Asleep',at('01:00'),at('07:00'),{source:'iPhone'}),
    sample('Asleep',at('01:00'),at('07:00')),
    sample('Core',at('01:00'),at('03:00')),sample('Awake',at('03:00'),at('03:10')),
    sample('Deep',at('03:10'),at('04:00')),sample('REM',at('04:00'),at('07:00')),
    sample('Core',at('14:00'),at('14:30')),
  ]);
  const report=summarizeSleep(rows);assert.equal(report.source,source);assert.equal(report.episodes.length,2);
  const night=report.episodes[1];assert.equal(night.asleepMinutes,350);assert.equal(night.awakeMinutes,10);assert.equal(night.awakenings,1);
  assert.equal(night.inBedMinutes,null);assert.equal(night.vitals.hrv,null);
  const gap=summarizeSleep(await normalize([sample('Core',at('01:00'),at('02:00')),sample('Deep',at('02:30'),at('03:00'))])).episodes[0];
  assert.equal(gap.unobservedMinutes,30);assert.equal(gap.asleepMinutes,90);
  const conflict=summarizeSleep(await normalize([sample('Core',at('01:00'),at('03:00')),sample('Deep',at('02:00'),at('03:00'))])).episodes[0];
  assert.equal(conflict.stageMinutes.unknown,60);assert.equal(conflict.asleepMinutes,60);
});
test('night vitals normalize units and exclude other sources and daytime measurements',async()=>{
  const at='2026-10-28T02:00:00+05:00';
  const vital=(metric,value,unit,extra={})=>sample(value,at,at,{metric,unit,...extra});
  const rows=await normalize([sample('Core'),vital('heart_rate',50,'count/min'),vital('heart_rate',70,'bpm',{end:'2026-10-28T02:01:00+05:00'}),
    vital('hrv','0,05','s'),vital('respiratory_rate',.25,'count/s'),vital('oxygen',.97,'%'),vital('wrist_temperature',95,'degF'),
    vital('heart_rate',200,'bpm',{source:'Other tracker'}),vital('heart_rate',180,'bpm',{start:'2026-10-28T12:00:00+05:00',end:'2026-10-28T12:00:00+05:00'})]);
  const vitals=summarizeSleep(rows).episodes[0].vitals;
  assert.deepEqual(vitals.heart_rate,{count:2,min:50,max:70,mean:60});
  assert.equal(vitals.hrv.mean,50);assert.equal(vitals.respiratory_rate.mean,15);assert.equal(vitals.oxygen.mean,97);assert.equal(vitals.wrist_temperature.mean,35);
});
test('DST uses elapsed time and keeps the local wake date',async()=>{
  const report=summarizeSleep(await normalize([sample('Asleep','2026-10-25T01:00:00+02:00','2026-10-25T04:00:00+01:00')]));
  assert.equal(report.episodes[0].asleepMinutes,240);assert.equal(report.episodes[0].day,'2026-10-25');
});
test('in-bed only is visible without inventing sleep time or awakenings',async()=>{
  const rows=await normalize([sample('In Bed')]);const episode=summarizeSleep(rows).episodes[0];
  assert.equal(episode.inBedMinutes,480);assert.equal(episode.asleepMinutes,null);assert.equal(episode.awakenings,null);
  assert.equal(episode.samples.length,1);
});
test('invalid times, unknown metrics and invalid units reject atomically',async()=>{
  for(const row of [sample('Core','2026-10-28T01:00:00','2026-10-28T02:00:00'),sample('Core','2026-02-30T01:00:00Z','2026-03-02T02:00:00Z'),
    sample(50,undefined,undefined,{metric:'heart_rate',unit:'kg'}),sample(1,undefined,undefined,{metric:'unknown'}),sample('Core',undefined,undefined,{source:[]})])
    await assert.rejects(normalize([sample('Core'),row]));
});
test('empty native Source preserves the batch, isolates unknown origins and does not invent vital averages',async()=>{
  const unknown=sample('Core',undefined,undefined,{source:''});
  const rows=await normalize([sample('Core'),unknown,unknown,sample('Deep',undefined,undefined,{source:''}),
    sample(55,'2026-10-28T02:00:00+05:00','2026-10-28T02:00:00+05:00',{metric:'heart_rate',unit:'count/min',source:''})]);
  assert.equal(rows.length,4);assert.equal(rows[1].source_name,'');assert.equal(rows[1].metadata.wedx_source_missing,true);
  assert.notEqual(rows[1].sample_key,rows[2].sample_key);
  assert.equal(summarizeSleep(rows).source,source);
  const unknownReport=summarizeSleep(rows,'');assert.equal(unknownReport.source,'');
  assert.equal(unknownReport.episodes[0].stageMinutes.unknown,480);
  const unambiguous=summarizeSleep(rows.filter(s=>s.stage!=='deep'),'').episodes[0];
  assert.equal(unambiguous.asleepMinutes,480);assert.equal(unambiguous.vitals.heart_rate,null);
  assert.equal(unambiguous.samples.some(s=>s.metric==='heart_rate'),true);
});
test('endpoint accepts missing sources and logs only static rejection reasons',async()=>{
  const calls=[],events=[];
  const handler=createSleepHandler({rpc:async(_name,args)=>{calls.push(args);return{data:{status:'imported',records:args.p_samples.length}};},getUser:async()=>{},reportError:event=>events.push(event)});
  const request=body=>new Request('https://local/sleep-import',{method:'POST',headers:{Authorization:'Bearer wedx_'+'a'.repeat(64),'Content-Type':'application/json'},body});
  const response=await handler(request(JSON.stringify(input([sample('Core',undefined,undefined,{source:''})]))));
  assert.equal(response.status,200);assert.equal((await response.json()).records,1);assert.equal(calls[0].p_samples[0].source_name,'');
  assert.equal((await handler(request('{"private":"do not log this"'))).status,400);
  assert.deepEqual(events,[{event:'sleep_import_rejected',code:'invalid_json',reason:undefined}]);
});
test('sleep endpoint binds browser requests to verified owner and hashes shortcut credentials',async()=>{
  const calls=[];let userReads=0;
  const handler=createSleepHandler({rpc:async(name,args)=>{calls.push({name,args});return{data:{records:args.p_samples.length}};},
    getUser:async token=>{userReads++;return{data:{user:token==='valid-session'?{id:'ownerA'}:null}};}});
  const request=token=>new Request('https://local/sleep-import',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...input([sample('Core')]),user_id:'attacker'})});
  assert.equal((await handler(request('bad-session'))).status,401);assert.equal(calls.length,0);
  assert.equal((await handler(request('valid-session'))).status,200);assert.equal(calls[0].args.p_owner,'ownerA');assert.equal(calls[0].args.p_token_hash,null);
  assert.equal((await handler(request('wedx_'+'a'.repeat(64)))).status,200);assert.equal(userReads,2);
  assert.match(calls[1].args.p_token_hash,/^[a-f0-9]{64}$/);assert.equal(calls[1].args.p_owner,null);
});
test('month history pages beyond the service default without losing records',async()=>{
  const rows=Array.from({length:1100},(_,i)=>({sample_key:String(i)})),calls=[];
  const client={from(table){assert.equal(table,'sleep_samples');const q={select(){return q;},eq(k,v){assert.equal(v,'owner');return q;},gte(){return q;},lt(){return q;},order(){return q;},range(a,b){calls.push([a,b]);q.a=a;q.b=b;return q;},abortSignal(){return Promise.resolve({data:rows.slice(q.a,q.b+1),error:null});}};return q;}};
  assert.equal((await loadSleepHistory(client,'owner','2026-10',new AbortController().signal)).length,1100);assert.equal(calls.length,3);
});
test('SE 2 shortcut keeps raw samples and uses operand-free success guards for all four responses',async()=>{
  const script="import importlib.util,json\ns=importlib.util.spec_from_file_location('s','scripts/build-sleep-shortcut.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.build()))";
  const workflow=JSON.parse(execFileSync('python3',['-B','-c',script],{encoding:'utf8'}));
  const actions=workflow.WFWorkflowActions,queries=actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.filter.health.quantity');
  assert.equal(queries.length,4);
  for(const {WFWorkflowActionParameters:p} of queries){assert.equal(p.WFContentItemLimitEnabled,false);assert.equal(p.WFHKSampleFilteringGroupBy,undefined);
    const filters=p.WFContentItemFilter.Value.WFActionParameterFilterTemplates;assert.ok(!filters.some(r=>r.Property==='Source'));assert.equal(filters[1].Values.Number,'3');}
  assert.equal(queries[0].WFWorkflowActionParameters.WFContentItemFilter.Value.WFActionParameterFilterTemplates[0].Values.Enumeration.Value,'Sleep');
  const posts=actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.downloadurl');assert.equal(posts.length,4);
  assert.ok(posts.every(a=>a.WFWorkflowActionParameters.WFRequestVariable.WFSerializationType==='WFTextTokenAttachment'));
  assert.equal(queries.at(-1).WFWorkflowActionParameters.WFContentItemFilter.Value.WFActionParameterFilterTemplates[0].Values.Enumeration.Value,'Heart Rate');
  assert.equal(actions.filter(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.exit').length,4);
  for(const post of posts) {
    const following=actions.slice(actions.indexOf(post)+1);
    const guard=following.find(a=>a.WFWorkflowActionIdentifier==='is.workflow.actions.conditional');
    const params=guard.WFWorkflowActionParameters;
    assert.equal(params.WFCondition,100);
    assert.equal(params.WFConditionalActionString,undefined);
    assert.equal(params.WFNumberValue,undefined);
    const match=following.find(a=>a.WFWorkflowActionParameters.UUID===params.WFInput.Variable.Value.OutputUUID);
    assert.equal(match.WFWorkflowActionIdentifier,'is.workflow.actions.text.match');
    const matchParams=match.WFWorkflowActionParameters;
    assert.equal(matchParams.WFMatchTextPattern,'\\Aimported\\z');assert.equal(matchParams.WFMatchTextCaseSensitive,true);
    const statusId=matchParams.text.Value.attachmentsByRange['{0, 1}'].OutputUUID;
    const status=following.find(a=>a.WFWorkflowActionParameters.UUID===statusId).WFWorkflowActionParameters;
    assert.equal(status.WFDictionaryKey,'status');assert.equal(status.WFInput.Value.OutputUUID,post.WFWorkflowActionParameters.UUID);
    // ICU's absolute anchors translated for JS; unlike $, the end anchor must
    // not accept a trailing newline. Keep failure responses out of success.
    const accepts=value=>new RegExp(matchParams.WFMatchTextPattern.replace(/^\\A/,'^').replace(/\\z$/,'(?![\\s\\S])'),'u').test(value??'');
    for(const value of ['','failed','not imported','IMPORTED','imported\n',' imported','imported '])assert.equal(accepts(value),false);
    let rpcError=null;
    const handler=createSleepHandler({rpc:async()=>({data:rpcError?null:{status:'imported',records:1},error:rpcError}),getUser:async()=>({data:{user:null}}),reportError:()=>{}});
    const request=(body=JSON.stringify(input([sample('Core')])),token='wedx_'+'a'.repeat(64))=>new Request('https://local/sleep-import',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
    for(const req of [request(),request('{'),request(undefined,'expired-session')]) {
      const response=await handler(req);assert.equal(accepts((await response.json()).status),response.ok);
    }
    rpcError={code:'28000'};const revoked=await handler(request());assert.equal(revoked.status,401);assert.equal(accepts((await revoked.json()).status),false);
  }
  assert.equal(/wedx_[a-f0-9]{64}/.test(JSON.stringify(workflow)),false);
});
