import { PROGRAM, DAYS, VOLUME } from "./domain/program.js";
import { KEY, localStore } from "./data/local-store.js";
import { createCloud } from "./data/cloud.js";
import { restNotifications } from "./features/timer/notifications.js";
import "./styles/app.css";
const SEED={log:{},last:{},hist:{},done:{}};

const APP_VER="2.0 · Supabase";
const DAY_IDS=["mon","wed","fri","sun"];
Object.keys(PROGRAM).forEach(d=>PROGRAM[d].ex.forEach((e,i)=>{e.k=d+"|"+i;}));
let state={log:{},last:{},hist:{},done:{}};
let cur=DAYS[[6,0,1,2,3,4,5][new Date().getDay()]].id;
if(!PROGRAM[cur]) cur="mon";

/* ---------- helpers ---------- */
function pad(n){return String(n).padStart(2,"0");}
function dkey(d){return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());}
/* до 03:00 ночи считается ещё предыдущим днём - тренировка за полночь не разрывается */
function todayKey(){return dkey(new Date(Date.now()-3*3600*1000));}
function parseD(s){const p=s.split("-");return new Date(+p[0],+p[1]-1,+p[2]);}
function shortDate(s){const p=s.split("-");return p[2]+"."+p[1];}
function weekStart(s){const d=parseD(s);const wd=(d.getDay()+6)%7;d.setDate(d.getDate()-wd);return dkey(d);}
function addDays(s,n){const d=parseD(s);d.setDate(d.getDate()+n);return dkey(d);}
function daysBetween(a,b){return Math.round((parseD(b)-parseD(a))/86400000);}
function trim(n){return (Math.round(n*10)/10).toString();}
function fmtN(n){return Math.round(n).toLocaleString("ru-RU");}
function fmtK(n){return n>=10000?(Math.round(n/100)/10).toLocaleString("ru-RU")+"к":fmtN(n);}
function fmt(s){return s>=60?(Math.floor(s/60)+(s%60?":"+pad(s%60):" мин")):(s+" сек");}
/* дата, за которую идёт запись: null = сегодня, иначе задним числом */
let logFor=null;
function sessDate(){return logFor||todayKey();}
function fmtTime(ts){const d=new Date(ts);return pad(d.getDate())+"."+pad(d.getMonth()+1)+" "+pad(d.getHours())+":"+pad(d.getMinutes());}
function fmtDur(ms){const m=Math.round(ms/60000);return m>=60?Math.floor(m/60)+" ч "+(m%60)+" мин":m+" мин";}
function e1rm(w,r){if(!w||!r)return 0;return r===1?w:w*(1+r/30);}
function range(e){const p=String(e.r).split("-").map(Number);return {lo:p[0],hi:p[p.length-1]};}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function el(tag,cls,html){const x=document.createElement(tag);if(cls)x.className=cls;if(html!=null)x.innerHTML=html;return x;}
let toastT=null;
function toast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove("show"),1800);}

/* ---------- storage ---------- */
let storageOK=true;
function normalize(){
  if(!state.log)state.log={};
  if(!state.last)state.last={};
  if(!state.done)state.done={};
  if(!state.hist)state.hist={};
  if(!state.logDate)state.logDate={};
  if(!state.sess)state.sess={};
  if(!state.bw)state.bw=[];
  if(!state.notes)state.notes={};
  if(!state.exo)state.exo={};
  /* залы: всё, что записано до их появления, считаем Мангилик Ел */
  if(!state.gyms||!state.gyms.length){
    state.gyms=GYMS0.map(g=>({id:g.id,n:g.n}));state.gym=GYMS0[0].id;
    for(const k in state.hist)state.hist[k].forEach(r=>{if(!r.g)r.g=GYMS0[0].id;});
    for(const d in state.sess)if(!state.sess[d].g)state.sess[d].g=GYMS0[0].id;
  }
  if(!state.gym||!state.gyms.some(g=>g.id===state.gym))state.gym=state.gyms[0].id;
  if(!state.assistV){
    DAY_IDS.forEach(d=>PROGRAM[d].ex.forEach(e=>{if(isAssist(e))(state.hist[e.k]||[]).forEach(r=>recalcRec(e,r));}));
    state.assistV=1;
  }
  state.ver=3;
}
function load(){
  let raw=null;
  try{raw=localStore.read();}catch(e){storageOK=false;}
  if(raw){
    try{state=localStore.parse(raw);}catch(e){localStore.quarantine(raw);state=structuredClone(SEED);setTimeout(()=>alert("Не удалось прочитать сохранение. Исходная копия сохранена отдельно; восстанови JSON из резервной копии."),0);}
  }else{
    state=JSON.parse(JSON.stringify(SEED));
  }
  normalize();
  freshenLogs();
}
let saveT=null;
function save(){
  clearTimeout(saveT);
  saveT=setTimeout(()=>{
    saveT=null;
    state.savedAt=Date.now();
    try{localStore.write(state);}
    catch(e){storageOK=false;}
    cloudSchedule();
  },300);
}
/* снимок перед опасным действием - кнопка «Вернуть данные» в подвале */
const UKEY=KEY+"-undo";
function snapshot(label){try{localStorage.setItem(UKEY,JSON.stringify({t:Date.now(),l:label,s:state}));}catch(e){}}
function undoInfo(){try{const r=localStorage.getItem(UKEY);return r?JSON.parse(r):null;}catch(e){return null;}}
function undoButton(){
  const u=undoInfo();if(!u||!u.s)return null;
  const b=el("button",null,"Вернуть данные до «"+u.l+"» ("+fmtTime(u.t)+")");
  b.style.cssText="margin-top:8px;border-color:var(--amber);color:var(--amber);";
  b.onclick=()=>{
    if(!confirm("Вернуть данные, какими они были до «"+u.l+"»? Текущие данные заменятся."))return;
    state=u.s;normalize();freshenLogs();saveNow();
    try{localStorage.removeItem(UKEY);}catch(e){}
    rerender();
    toast("Данные возвращены");
  };
  return b;
}
/* мгновенная запись: для критичных действий и при уходе приложения в фон */
function saveNow(){
  clearTimeout(saveT);saveT=null;
  state.savedAt=Date.now();
  writeLocal();
  cloudSchedule();
}
/* запись без отметки времени - для данных, пришедших из облака */
function writeLocal(){try{localStore.write(state);}catch(e){storageOK=false;}}
function rerender(){if(view==="health")renderHealth();else if(view==="day")renderDay();else renderProgress();}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden"){if(saveT)saveNow();cloudFlush();}});
window.addEventListener("pagehide",()=>{if(saveT)saveNow();cloudFlush();});

// Cloud synchronization and account UI are provided by the data layer.
/* ---------- файл копии ---------- */
function backupName(){return "wedx-"+todayKey()+".json";}
async function saveFile(){
  const txt=JSON.stringify(state);
  const file=new File([txt],backupName(),{type:"application/json"});
  try{
    if(navigator.canShare&&navigator.canShare({files:[file]})){await navigator.share({files:[file],title:"WEDX копия"});return;}
  }catch(e){if(e&&e.name==="AbortError")return;}
  const a=document.createElement("a");a.href=URL.createObjectURL(file);a.download=backupName();
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
}
function restoreFrom(t){
  try{const o=JSON.parse(t);if(!o||typeof o!=="object"||!o.hist)throw 0;snapshot("Восстановить");state=localStore.parse(JSON.stringify(o));normalize();freshenLogs();saveNow();rerender();toast("Данные восстановлены");}
  catch(e){alert("Не получилось прочитать копию. Проверь, что это файл или текст из «Копия данных».");}
}
function openFile(){
  const i=document.createElement("input");i.type="file";i.accept=".json,application/json,text/plain";
  i.onchange=()=>{const f=i.files&&i.files[0];if(!f)return;f.text().then(t=>{if(confirm("Заменить текущие данные копией из файла «"+f.name+"»?"))restoreFrom(t);});};
  i.click();
}
function slot(day,i,j){
  const k=day+"|"+i;
  if(!state.log[k])state.log[k]=[];
  if(!state.log[k][j])state.log[k][j]={w:"",r:"",d:false};
  return state.log[k][j];
}
/* форма за выбранную дату заполняется тем, что уже записано в истории - правки сразу идут туда же */
function fillFromHist(day,date){
  clearDay(day);
  let any=false;
  PROGRAM[day].ex.forEach((e,i)=>{
    const rec=(state.hist[day+"|"+i]||[]).find(x=>x.d===date);if(!rec)return;
    any=true;
    const sets=rec.s&&rec.s.length?rec.s:Array.from({length:Math.min(rec.n,e.s)},()=>[rec.w,rec.r]);
    state.log[day+"|"+i]=sets.map(x=>x?{w:e.w?String(x[0]):"",r:String(x[1]),d:true,x:x[3]?{w:String(x[2]),r:String(x[3])}:null}:{w:"",r:"",d:false});
  });
  if(any)state.logDate[day]=date;
  return any;
}
function openDate(date){
  logFor=(date===todayKey())?null:date;
  const any=fillFromHist(cur,date);save();renderDay();
  toast(any?"Тренировка "+shortDate(date)+" - правь, всё обновится":(logFor?"Запись за "+shortDate(date):"Запись за сегодня"));
  return any;
}
function clearDay(day){
  PROGRAM[day].ex.forEach((e,i)=>{delete state.log[day+"|"+i];});
  delete state.logDate[day];
}
/* Лог дня живёт один день: назавтра он уже в истории, а форма чистая */
function freshenLogs(){
  const t=todayKey();
  DAY_IDS.forEach(day=>{
    if(logFor&&day===cur)return;
    let ld=state.logDate[day];
    if(!ld){
      const hasDone=PROGRAM[day].ex.some((e,i)=>(state.log[day+"|"+i]||[]).some(s=>s&&s.d));
      if(!hasDone)return;
      let mx="";
      PROGRAM[day].ex.forEach((e,i)=>{const a=state.hist[day+"|"+i];if(a&&a.length&&a[a.length-1].d>mx)mx=a[a.length-1].d;});
      ld=mx||t;
    }
    if(ld!==t)clearDay(day);
  });
}

/* ---------- залы и тип упражнения ---------- */
const GYMS0=[{id:"mel",n:"Мангилик Ел"},{id:"fs",n:"Форсизон"},{id:"avs",n:"Австрийский"}];
function exo(e){return state.exo[e.k]||{};}
/* тренажёр: веса в разных залах не сравниваются */
function isMachine(e){const o=exo(e);return !!e.w&&(o.m!=null?o.m:!!e.m);}
/* гравитрон: меньше противовес = тяжелее */
function isAssist(e){const o=exo(e);return !!e.w&&(o.a!=null?o.a:!!e.a);}
function gymName(id){const g=state.gyms.find(x=>x.id===id);return g?g.n:"?";}
function sessGym(){const s=state.sess[sessDate()];return (s&&s.g)||state.gym;}
function recGym(r){return r.g||GYMS0[0].id;}
function recsFor(e,g){const a=state.hist[e.k]||[];return isMachine(e)?a.filter(r=>recGym(r)===g):a;}
function bwAt(d){const b=state.bw;if(!b.length)return 80;let w=b[0].w;for(const x of b){if(x.d<=d)w=x.w;else break;}return w;}
/* рабочая нагрузка: для гравитрона вес тела минус противовес */
function effW(e,w,d){return isAssist(e)?Math.max(0,bwAt(d)-w):w;}
function heavier(e,a,b){return isAssist(e)?a<b:a>b;}
function summarize(e,per,d){
  let best=null,vol=0,n=0;
  per.forEach(x=>{
    if(!x)return;n++;
    vol+=effW(e,x[0],d)*x[1];if(x[3])vol+=effW(e,x[2],d)*x[3];
    if(!best||heavier(e,x[0],best.w)||(x[0]===best.w&&x[1]>best.r))best={w:x[0],r:x[1]};
  });
  return {best:best,vol:Math.round(vol),n:n};
}
function recalcRec(e,rec){
  if(rec.s&&rec.s.length){const m=summarize(e,rec.s,rec.d);rec.v=m.vol;if(m.best){rec.w=m.best.w;rec.r=m.best.r;}}
  else rec.v=Math.round(effW(e,rec.w,rec.d)*rec.r*rec.n);
}
function setGym(id){
  const d=sessDate();
  if(!logFor)state.gym=id;
  let s=state.sess[d];
  if(!s&&logFor)s=state.sess[d]={day:cur};
  if(s)s.g=id;
  for(const k in state.hist)state.hist[k].forEach(r=>{if(r.d===d)r.g=id;});
  save();renderDay();toast("Зал: "+gymName(id));
}
function addGym(){
  const n=prompt("Название зала:");if(!n||!n.trim())return;
  const id="g"+Date.now().toString(36);
  state.gyms.push({id:id,n:n.trim()});setGym(id);
}
function gymRow(){
  const g=sessGym(),started=!!state.sess[sessDate()];
  const row=el("div","gymrow"+(started?"":" ask"));
  row.appendChild(el("span","gl",started?"Зал":"Где ты сегодня?"));
  state.gyms.forEach(x=>{
    const b=el("button","gchip",esc(x.n));b.setAttribute("aria-pressed",x.id===g);
    b.onclick=()=>{
      if(x.id!==g){setGym(x.id);return;}
      const n=prompt("Переименовать зал:",x.n);
      if(n&&n.trim()){x.n=n.trim();save();renderDay();}
    };
    row.appendChild(b);
  });
  const add=el("button","gchip add","+ зал");add.onclick=addGym;
  row.appendChild(add);
  return row;
}

/* ---------- history ---------- */
function touchSession(day){
  const t=sessDate();
  state.logDate[day]=t;
  if(logFor){state.sess[t]=state.sess[t]||{day:day,g:state.gym};state.sess[t].day=day;return;}
  const s=state.sess[t]||(state.sess[t]={day:day,t0:Date.now(),g:state.gym});
  s.day=day;s.t1=Date.now();if(!s.g)s.g=state.gym;
}
function recordHistory(day,i){
  const e=PROGRAM[day].ex[i], k=day+"|"+i, sets=state.log[k]||[];
  const per=[];
  for(let j=0;j<e.s;j++){
    const s=sets[j];
    if(!s||!s.d){per.push(null);continue;}
    const w=parseFloat(s.w)||0, r=parseFloat(s.r)||0;
    const xw=s.x?parseFloat(s.x.w)||0:0, xr=s.x?parseFloat(s.x.r)||0:0;
    per.push(xr>0?[w,r,xw,xr]:[w,r]);
  }
  while(per.length&&per[per.length-1]===null)per.pop();
  if(!state.hist[k])state.hist[k]=[];
  const arr=state.hist[k], t=sessDate();
  touchSession(day);
  const m=summarize(e,per,t),best=m.best,n=m.n;
  const rec={d:t,w:best?best.w:0,r:best?best.r:0,v:m.vol,n:n,s:per,g:sessGym()};
  const idx=arr.findIndex(x=>x.d===t);
  if(n===0){ if(idx>=0)arr.splice(idx,1); touchSession(day); return; }
  if(idx>=0)arr[idx]=rec;
  else{ let p=arr.length; while(p>0&&arr[p-1].d>t)p--; arr.splice(p,0,rec); }
  if(arr.length>150)arr.shift();
  touchSession(day);
}
/* прошлая сессия (не сегодняшняя) */
function lastSession(day,i){
  const a=recsFor(PROGRAM[day].ex[i],sessGym());if(!a.length)return null;
  const t=sessDate();
  for(let k=a.length-1;k>=0;k--){if(a[k].d<t)return a[k];}
  return null;
}
function todayRec(day,i){
  const a=state.hist[day+"|"+i];if(!a||!a.length)return null;
  const r=a.find(x=>x.d===sessDate());return r||null;
}
function recReps(rec){
  if(rec.s)return rec.s.reduce((a,x)=>a+(x?x[1]:0),0);
  return rec.r*rec.n;
}
function recE1(rec,e){
  if(rec.s){let m=0;rec.s.forEach(x=>{if(x)m=Math.max(m,e1rm(effW(e,x[0],rec.d),x[1]));});return m;}
  return e1rm(effW(e,rec.w,rec.d),rec.r);
}
/* Готовность к прогрессии по правилу двойной прогрессии */
function readiness(e,rec){
  if(!rec||!rec.s||!e.w)return null;
  const rg=range(e);
  const done=rec.s.filter(Boolean);
  if(done.length<e.s)return null;
  const as=isAssist(e);
  if(done.every(x=>x[1]>=rg.hi))return {ok:true,txt:as?"Все подходы на верхней границе - убавь противовес на 2.5-5 кг":"Все подходы на верхней границе - добавь 2.5-5 кг"};
  if(done.filter(x=>x[1]<rg.lo).length>=2)return {ok:false,txt:as?"Два подхода ниже диапазона - держи или добавь противовес":"Два подхода ниже диапазона - держи или сбавь вес"};
  return null;
}
/* класс чипа подхода относительно диапазона */
function chipCls(e,x){
  if(!x)return "chip skip";
  const rg=range(e);
  if(x[1]>=rg.hi)return "chip top";
  if(x[1]<rg.lo)return "chip low";
  return "chip";
}
function chipTxt(e,x){
  if(!x)return "–";
  if(!e.w||(x[0]===0))return x[1]+(e.sec?"с":"");
  return trim(x[0])+"×"+x[1]+(x[3]?"+"+trim(x[2])+"×"+x[3]:"");
}
function setsHTML(e,rec,todayMark){
  if(rec.s&&rec.s.length){
    return '<div class="chips">'+rec.s.map(x=>'<span class="'+chipCls(e,x)+(todayMark?" today":"")+'">'+chipTxt(e,x)+'</span>').join("")+'</div>';
  }
  const b=e.w&&rec.w?trim(rec.w)+"×"+rec.r:rec.r+(e.sec?"с":"");
  return '<div class="chips"><span class="chip">лучший '+b+'</span><span class="chip skip">'+rec.n+' подх.</span></div>';
}

/* ---------- timer ---------- */
let endAt=0,total=0,tick=null,timerOwner=null;
const dock=document.getElementById("dock"),clock=document.getElementById("clock"),
      tfill=document.getElementById("tfill"),tval=document.getElementById("tval"),
      tlbl=document.getElementById("tlbl");
function startTimer(sec,label){
  try{timerOwner=localStorage.getItem(KEY+"-owner");}catch{timerOwner=null;}
  total=sec;endAt=Date.now()+sec*1000;
  tval.textContent=label;tlbl.textContent="Отдых";
  clock.classList.remove("zero");
  dock.classList.add("up");
  clearInterval(tick);tick=setInterval(paintTimer,200);paintTimer();
  saveRestTimer();restNotifications.setTimer(endAt,label);
}
function saveRestTimer(){
  try{localStorage.setItem(KEY+"-rest-timer",JSON.stringify({owner:localStorage.getItem(KEY+"-owner"),endAt,total,label:tval.textContent}));}catch{}
}
function restoreRestTimer(){
  try{
    const saved=JSON.parse(localStorage.getItem(KEY+"-rest-timer")||'null');
    if(saved&&saved.owner===localStorage.getItem(KEY+"-owner")&&saved.endAt>Date.now()&&saved.endAt-Date.now()<=1800000){
      total=saved.total;endAt=saved.endAt;timerOwner=saved.owner;tval.textContent=saved.label;tlbl.textContent="Отдых";
      dock.classList.add("up");tick=setInterval(paintTimer,200);paintTimer();
    }
  }catch{}
}
function paintTimer(){
  const left=Math.max(0,endAt-Date.now())/1000;
  const m=Math.floor(left/60),s=Math.floor(left%60);
  clock.textContent=m+":"+pad(s);
  tfill.style.width=(total?Math.max(0,left/total*100):0)+"%";
  if(left<=0){
    clearInterval(tick);tick=null;
    clock.classList.add("zero");tlbl.textContent="Готово - следующий подход";
    try{localStorage.removeItem(KEY+"-rest-timer");}catch{}
    if(document.visibilityState==="visible"&&Date.now()-endAt<10000){
      if(navigator.vibrate)navigator.vibrate([120,70,120]);beep();
    }
  }
}
function beep(){
  try{
    const a=new(window.AudioContext||window.webkitAudioContext)();
    const o=a.createOscillator(),g=a.createGain();
    o.connect(g);g.connect(a.destination);o.frequency.value=760;o.type="sine";
    g.gain.setValueAtTime(.001,a.currentTime);
    g.gain.exponentialRampToValueAtTime(.25,a.currentTime+.02);
    g.gain.exponentialRampToValueAtTime(.001,a.currentTime+.5);
    o.start();o.stop(a.currentTime+.5);
  }catch(e){}
}
document.getElementById("skip").onclick=()=>{clearInterval(tick);tick=null;endAt=0;dock.classList.remove("up");
  try{localStorage.removeItem(KEY+"-rest-timer");}catch{}restNotifications.cancel();};
document.getElementById("add30").onclick=()=>{
  if(!tick){endAt=Date.now();clock.classList.remove("zero");tlbl.textContent="Отдых";tick=setInterval(paintTimer,200);}
  endAt+=30000;total+=30;paintTimer();saveRestTimer();restNotifications.setTimer(endAt,tval.textContent);
};
window.addEventListener('wedx-push-ready',()=>{if(endAt>Date.now())restNotifications.setTimer(endAt,tval.textContent);});
window.addEventListener('wedx-timer-push',event=>{document.getElementById('timer-push-state').textContent=event.detail.message;});
window.addEventListener('wedx-push-owner',event=>{
  if(timerOwner&&timerOwner!==event.detail.owner){clearInterval(tick);tick=null;endAt=0;dock.classList.remove('up');
    try{localStorage.removeItem(KEY+'-rest-timer');}catch{}}
});

/* ---------- day view ---------- */
const main=document.getElementById("main");
const openPanels={};

function renderDays(){
  const c=document.getElementById("days");c.innerHTML="";
  DAYS.forEach(d=>{
    const b=el("button","day",esc(d.lbl)+"<small>"+esc(d.sub)+"</small>");
    b.setAttribute("role","tab");b.setAttribute("aria-selected",d.id===cur);
    b.onclick=()=>{cur=d.id;renderDays();renderDay();window.scrollTo({top:0});};
    c.appendChild(b);
  });
}

function renderDay(){
  main.innerHTML="";
  const p=PROGRAM[cur];
  if(!p){
    main.innerHTML='<div style="height:18px"></div><div class="restday"><b>День отдыха</b>Восстановление - это часть программы, а не пауза в ней.</div>'+rulesHTML();
    const foot=el("div","foot");
    foot.appendChild(restNotifications.control());
    foot.appendChild(cloudBox());main.appendChild(foot);
    return;
  }
  main.appendChild(el("div","daymeta",'<h2>'+esc(p.name)+' <span style="color:var(--muted);font-weight:400">· '+esc(p.note)+'</span></h2><span class="count" id="cnt"></span>'));
  main.appendChild(restNotifications.control());
  const dr=el("div","daterow"+(logFor?" back":""),
    '<span class="dl">'+(logFor?'Записываешь за <b>'+shortDate(logFor)+'</b> · таймер выключен':'Дата записи')+'</span>'+
    '<input type="date" id="logdate" value="'+sessDate()+'" max="'+todayKey()+'" aria-label="Дата тренировки">'+
    (logFor?'<button id="datetoday">сегодня</button>':''));
  const di=dr.querySelector("#logdate");
  di.onchange=()=>{
    const v=di.value;if(!v||v>todayKey()){di.value=sessDate();return;}
    const nv=(v===todayKey())?null:v;
    if(nv===logFor)return;
    openDate(v);
  };
  const dt=dr.querySelector("#datetoday");
  if(dt)dt.onclick=()=>openDate(todayKey());
  main.appendChild(dr);
  main.appendChild(gymRow());
  main.appendChild(el("div","bar",'<i id="fill"></i>'));
  main.appendChild(el("div","livevol",'<span id="lv1"></span><span id="lv2"></span>'));

  p.ex.forEach((e,i)=>main.appendChild(exCard(e,i)));

  const foot=el("div","foot");
  const btn=el("button",null,"Очистить форму (история и веса останутся)");
  btn.onclick=()=>{
    if(!confirm("Убрать галочки и повторы из формы? Всё, что отмечено, уже сохранено в истории и останется там."))return;
    clearDay(cur);save();renderDay();toast("Форма очищена, история цела");
  };
  foot.appendChild(btn);
  foot.appendChild(cloudBox());
  const row=el("div","row");
  const exp=el("button",null,"Копия в файл");exp.onclick=saveFile;
  const imp=el("button",null,"Из файла");imp.onclick=openFile;
  row.appendChild(exp);row.appendChild(imp);
  foot.appendChild(row);
  const row2=el("div","row");
  const ct=el("button",null,"Копия текстом");
  ct.onclick=()=>{
    const txt=JSON.stringify(state);
    navigator.clipboard?.writeText(txt).then(
      ()=>alert("Данные скопированы в буфер. Сохрани в заметках - это резервная копия."),
      ()=>prompt("Скопируй вручную:",txt)
    );
  };
  const pt=el("button",null,"Вставить текст");
  pt.onclick=()=>{const t=prompt("Вставь резервную копию:");if(t)restoreFrom(t);};
  row2.appendChild(ct);row2.appendChild(pt);
  foot.appendChild(row2);
  const ub=undoButton();if(ub)foot.appendChild(ub);
  if(!storageOK){
    const w=el("div",null,"Браузер не сохраняет данные. Скорее всего включён приватный режим - открой страницу в обычной вкладке.");
    w.style.cssText="margin-top:10px;padding:10px;border:1px solid var(--danger);border-radius:10px;color:var(--danger);font-size:14.5px;";
    foot.appendChild(w);
  }
  const ver=el("div",null,"Версия "+APP_VER);
  ver.style.cssText="margin-top:12px;text-align:center;font-size:12.5px;color:var(--muted);opacity:.7;";
  foot.appendChild(ver);
  main.appendChild(foot);
  main.insertAdjacentHTML("beforeend",rulesHTML());
  updateProgress();
}

const CHEV='<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const ARROW='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

function exCard(e,i){
  const card=el("div","ex"+(openPanels[cur+"|"+i]?" hopen":""));card.dataset.i=i;
  const perSide=e.side?" на сторону":"";
  const unit=e.sec?" сек":"";
  card.innerHTML=
    '<div class="exhead"><div class="num">'+(i+1)+'</div><div class="exinfo">'+
    '<div class="exname">'+esc(e.n)+'</div>'+
    '<div class="extags"><b>'+e.s+'×'+e.r+unit+perSide+'</b> · '+esc(e.t)+' · отдых '+fmt(e.rest)+
    (e.hint?' <br>'+esc(e.hint):'')+
    (isMachine(e)||isAssist(e)?'<div class="mtags">'+(isMachine(e)?'<span>тренажёр · '+esc(gymName(sessGym()))+'</span>':'')+(isAssist(e)?'<span>гравитрон: меньше = лучше</span>':'')+'</div>':'')+
    '</div></div>'+(e.w?'<button class="exset" aria-label="Настройки упражнения">'+GEAR+'</button>':'')+'</div>';
  const gb=card.querySelector(".exset");
  if(gb)gb.onclick=()=>{const k=e.k;openOpts[k]=!openOpts[k];renderDay();};
  if(e.w&&openOpts[e.k])card.appendChild(exOpts(e));

  const ls=lastSession(cur,i);
  const all=recsFor(e,sessGym()).filter(r=>r.d<sessDate());
  const ll=el("button","lastline"+(ls?"":" empty"));
  if(ls){
    ll.innerHTML='<div class="ll"><b>Прошлый раз '+shortDate(ls.d)+'</b> · '+
      (ls.s&&ls.s.length?ls.s.map(x=>chipTxt(e,x)).join(" · "):"лучший "+chipTxt(e,[ls.w,ls.r])+" · "+ls.n+" подх.")+
      (e.w&&ls.v?' · <span style="opacity:.8">'+fmtN(ls.v)+' кг</span>':'')+'</div>'+CHEV;
    ll.onclick=()=>{
      const k=cur+"|"+i;openPanels[k]=!openPanels[k];
      card.classList.toggle("hopen",openPanels[k]);
      if(openPanels[k]&&!card.querySelector(".hpanel").childElementCount)fillPanel(card,e,i,all);
    };
    if(openPanels[cur+"|"+i]){const hp=el("div","hpanel");card.appendChild(ll);card.appendChild(hp);fillPanel(card,e,i,all);}
    else{card.appendChild(ll);card.appendChild(el("div","hpanel"));}
  }else{
    ll.innerHTML='<div class="ll">'+(isMachine(e)&&(state.hist[e.k]||[]).some(r=>r.d<sessDate())
      ?'В зале '+esc(gymName(sessGym()))+' на этом тренажёре ещё не было записей - веса из других залов сюда не подставляются'
      :'Первая тренировка по этому упражнению - истории пока нет')+'</div>';
    ll.disabled=true;card.appendChild(ll);
  }
  const rd=readiness(e,ls);
  if(rd){
    const r=el("div","ready"+(rd.ok?"":" hold"),(rd.ok?ARROW:"")+esc(rd.txt));
    r.style.margin="6px 12px 0 41px";card.appendChild(r);
  }
  const sets=el("div","sets");
  for(let j=0;j<e.s;j++)sets.appendChild(setRow(e,i,j,ls));
  card.appendChild(sets);
  return card;
}

const openOpts={};
const GEAR='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
function exOpts(e){
  const box=el("div","exopts");
  const opt=(on,title,sub,fn)=>{
    const b=el("button","opt",'<span><b>'+title+'</b><small>'+sub+'</small></span><i>'+(on?"да":"нет")+'</i>');
    b.setAttribute("aria-pressed",on);b.onclick=fn;box.appendChild(b);
  };
  opt(isMachine(e),"Тренажёр","веса в разных залах разные - прогресс считается по залу",()=>{
    state.exo[e.k]=Object.assign({},exo(e),{m:!isMachine(e)});save();renderDay();
  });
  opt(isAssist(e),"Гравитрон","меньше противовес = прогресс, нагрузка = вес тела − противовес",()=>{
    state.exo[e.k]=Object.assign({},exo(e),{a:!isAssist(e)});
    (state.hist[e.k]||[]).forEach(r=>recalcRec(e,r));save();renderDay();
  });
  return box;
}
function fillPanel(card,e,i,all){
  const hp=card.querySelector(".hpanel");hp.innerHTML="";
  const recent=all.slice(-5).reverse();
  recent.forEach((rec,idx)=>{
    const prev=all[all.length-1-idx-1];
    let dv="";
    if(prev&&e.w&&rec.v){const d=rec.v-prev.v;dv='<span class="'+(d>0?"up":d<0?"down":"flat")+'">'+(d>0?"+":"")+fmtN(d)+'</span>';}
    const row=el("div","hrow",
      '<div class="hdate"><button class="hedit" aria-label="Изменить тренировку '+shortDate(rec.d)+'">'+shortDate(rec.d)+'<small>изменить</small></button></div><div class="hsets">'+setsHTML(e,rec)+
      (state.notes[cur+"|"+i]&&state.notes[cur+"|"+i][rec.d]?'<div class="hnote">'+esc(state.notes[cur+"|"+i][rec.d])+'</div>':'')+'</div>'+
      (e.w?'<div class="hvol"><b>'+fmtN(rec.v)+'</b>'+dv+'</div>':'<div class="hvol"><b>'+recReps(rec)+'</b>'+(e.sec?"сек":"повт")+'</div>'));
    row.querySelector(".hedit").onclick=()=>{openDate(rec.d);window.scrollTo({top:0,behavior:"smooth"});};
    hp.appendChild(row);
  });
  const nb=el("button","notebtn",logFor?"+ Заметка к тренировке "+shortDate(logFor):"+ Заметка к сегодняшней тренировке");
  nb.onclick=()=>{
    const k=cur+"|"+i,t=sessDate();
    const old=(state.notes[k]&&state.notes[k][t])||"";
    const txt=prompt("Заметка ("+e.n+"):",old);
    if(txt===null)return;
    if(!state.notes[k])state.notes[k]={};
    if(txt.trim())state.notes[k][t]=txt.trim();else delete state.notes[k][t];
    save();toast(txt.trim()?"Заметка сохранена":"Заметка удалена");
  };
  hp.appendChild(nb);
}

function setRow(e,i,j,ls){
  const d=slot(cur,i,j);
  const wrap=el("div","sset");
  const row=el("div","srow"+(d.d?" on":""));
  const lastW=isMachine(e)?(ls?trim(ls.w):""):state.last[cur+"|"+i];
  const px=ls&&ls.s?ls.s[j]:null;
  const lab=el("div","slabel",String(j+1));
  row.appendChild(lab);

  const wf=el("div","fld");
  if(e.w){
    const ph=px?trim(px[0]):(lastW||"–");
    wf.innerHTML='<input type="number" inputmode="decimal" step="0.5" placeholder="'+esc(ph)+'"><span>кг</span>';
    const wi=wf.querySelector("input");wi.value=d.w;
    wi.oninput=()=>{d.w=wi.value;if(!logFor&&!isMachine(e))state.last[cur+"|"+i]=wi.value;touchSession(cur);if(d.d)recordHistory(cur,i);save();markBeat(row,e,d,px);updateLive();};
  }else{
    wf.innerHTML='<input type="text" value="Своё" disabled style="opacity:.45">';
  }
  row.appendChild(wf);

  const rf=el("div","fld");
  /* в поле всегда цель из программы, а прошлый результат подписан справа */
  rf.innerHTML='<input type="number" inputmode="numeric" placeholder="'+esc(e.r)+'">'+
    (px?'<span class="was">было <b>'+px[1]+(px[3]?"+"+px[3]:"")+'</b></span>':'<span>'+(e.sec?"сек":"пвт")+'</span>');
  if(px)rf.classList.add("hasw");
  const ri=rf.querySelector("input");ri.value=d.r;
  ri.oninput=()=>{d.r=ri.value;touchSession(cur);if(d.d)recordHistory(cur,i);save();markBeat(row,e,d,px);updateLive();if(d.d&&e.w)paintDropBtn(wrap,e,d);};
  row.appendChild(rf);

  const b=el("button","chk",'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>');
  b.setAttribute("aria-pressed",d.d);b.setAttribute("aria-label","Подход "+(j+1)+" выполнен");
  b.onclick=()=>{
    d.d=!d.d;
    if(d.d&&!d.r)d.r=px?String(px[1]):e.r.split("-")[0];
    if(d.d&&e.w&&!d.w){d.w=px?String(px[0]):(lastW||"");}
    recordHistory(cur,i);
    save();
    const isLast=(j===e.s-1);
    renderDay();
    if(d.d&&!logFor)startTimer(e.rest,isLast?nextExercise(i):e.n+" · подход "+(j+2)+" из "+e.s);
  };
  row.appendChild(b);
  markBeat(row,e,d,px);
  wrap.appendChild(row);
  if(e.w&&d.d){
    let lastDone=-1;for(let q=0;q<e.s;q++)if(slot(cur,i,q).d)lastDone=q;
    if(d.x)wrap.appendChild(dropRow(e,i,j,d,px));
    else if(j===lastDone||shortBy(e,d)||(px&&px[3]))wrap.appendChild(dropBtn(e,i,j,d,px));
  }
  return wrap;
}
/* добивка: после рабочего подхода сбросил вес и добрал недостающие повторы */
function shortBy(e,d){const r=parseFloat(d.r)||0,lo=range(e).lo;return r&&r<lo?lo-r:0;}
function dropSuggest(e,d,px){
  if(px&&px[3])return trim(px[2]);
  const w=parseFloat(d.w)||0;if(!w)return "";
  return trim(Math.max(0,Math.round(w*(isAssist(e)?1.25:0.8)/2.5)*2.5));
}
function paintDropBtn(wrap,e,d){
  const btn=wrap.querySelector(".addx");if(!btn)return;
  const k=shortBy(e,d);
  btn.classList.toggle("need",!!k);
  btn.querySelector("b").textContent=k?" · не хватило "+k:"";
}
function dropBtn(e,i,j,d,px){
  const btn=el("button","addx",(isAssist(e)?"+ добивка с бóльшим противовесом":"+ добивка меньшим весом")+"<b></b>"+(px&&px[3]?'<span>было '+trim(px[2])+'×'+px[3]+'</span>':''));
  const k=shortBy(e,d);
  if(k){btn.classList.add("need");btn.querySelector("b").textContent=" · не хватило "+k;}
  btn.onclick=()=>{
    d.x={w:dropSuggest(e,d,px),r:""};save();renderDay();
    const ri=main.querySelector('.ex[data-i="'+i+'"] .drow[data-j="'+j+'"] .dr');if(ri)ri.focus();
  };
  return btn;
}
function dropRow(e,i,j,d,px){
  const row=el("div","drow");row.dataset.j=j;
  row.appendChild(el("div","slabel","↳"));
  const wf=el("div","fld");
  wf.innerHTML='<input type="number" inputmode="decimal" step="0.5" placeholder="'+esc(dropSuggest(e,d,px)||"–")+'"><span>кг</span>';
  const wi=wf.querySelector("input");wi.value=d.x.w;
  wi.oninput=()=>{d.x.w=wi.value;recordHistory(cur,i);save();updateLive();};
  row.appendChild(wf);
  const rf=el("div","fld");
  const k=shortBy(e,d);
  rf.innerHTML='<input class="dr" type="number" inputmode="numeric" placeholder="'+(k?"+"+k:"+")+'"><span>пвт</span>';
  const ri=rf.querySelector("input");ri.value=d.x.r;
  ri.oninput=()=>{d.x.r=ri.value;recordHistory(cur,i);save();updateLive();};
  row.appendChild(rf);
  const x=el("button","dx","×");x.setAttribute("aria-label","Убрать добивку");
  x.onclick=()=>{d.x=null;recordHistory(cur,i);save();renderDay();};
  row.appendChild(x);
  return row;
}
/* подсветка: подход лучше прошлого раза */
function markBeat(row,e,d,px){
  row.classList.toggle("short",!!(d.d&&shortBy(e,d)));
  if(!px||!d.d){row.classList.remove("beat");return;}
  const w=parseFloat(d.w)||0,r=parseFloat(d.r)||0;
  const beat=e.w?(heavier(e,w,px[0])||(w===px[0]&&r>px[1])):r>px[1];
  row.classList.toggle("beat",beat);
}

function nextExercise(i){
  const p=PROGRAM[cur];
  return p.ex[i+1]?("Дальше: "+p.ex[i+1].n):"Тренировка завершена";
}

function updateLive(){
  const p=PROGRAM[cur];if(!p)return;
  let vol=0,lastVol=0,reps=0;
  p.ex.forEach((e,i)=>{
    if(!e.w)return;
    const sd=sessDate();
    for(let j=0;j<e.s;j++){const s=slot(cur,i,j);if(s.d){vol+=effW(e,parseFloat(s.w)||0,sd)*(parseFloat(s.r)||0);reps+=parseFloat(s.r)||0;
      if(s.x&&parseFloat(s.x.r))vol+=effW(e,parseFloat(s.x.w)||0,sd)*(parseFloat(s.x.r)||0);}}
    const ls=lastSession(cur,i);if(ls)lastVol+=ls.v||0;
  });
  const a=document.getElementById("lv1"),b=document.getElementById("lv2");
  if(a)a.innerHTML='Тоннаж '+(logFor?shortDate(logFor):'сегодня')+': <b>'+fmtN(vol)+' кг</b>';
  if(b)b.innerHTML=lastVol?'Прошлый раз: <b>'+fmtN(lastVol)+' кг</b>':'';
}

function updateProgress(){
  const p=PROGRAM[cur];if(!p)return;
  let tot=0,done=0;
  p.ex.forEach((e,i)=>{
    let dn=0;
    for(let j=0;j<e.s;j++){tot++;if(slot(cur,i,j).d){done++;dn++;}}
    const card=main.querySelector('.ex[data-i="'+i+'"]');
    if(card&&dn===e.s)card.classList.add("complete");
  });
  const f=document.getElementById("fill"),c=document.getElementById("cnt");
  if(f)f.style.width=(tot?done/tot*100:0)+"%";
  if(c)c.textContent=done+" / "+tot+" подходов";
  updateLive();
}

/* ---------- charts (SVG, без библиотек) ---------- */
function niceTicks(mn,mx,n){
  if(mx===mn){const p=mn===0?1:Math.abs(mn)*.1;mn-=p;mx+=p;}
  const span=mx-mn,raw=span/(n-1),mag=Math.pow(10,Math.floor(Math.log10(raw)));
  const norm=raw/mag;let step=mag*(norm<1.5?1:norm<3?2:norm<7?5:10);
  const lo=Math.floor(mn/step)*step,hi=Math.ceil(mx/step)*step;
  const t=[];for(let v=lo;v<=hi+step*1e-6;v+=step)t.push(+v.toFixed(6));
  return {lo:lo,hi:hi,ticks:t};
}
function tipFor(host){
  let t=host.querySelector(".tip");
  if(!t){t=el("div","tip");host.appendChild(t);}
  return t;
}
function placeTip(host,t,xPx,html){
  t.innerHTML=html;t.classList.add("show");
  const hw=host.clientWidth,tw=t.offsetWidth;
  const x=Math.max(tw/2+2,Math.min(hw-tw/2-2,xPx));
  t.style.left=x+"px";t.style.top="0px";
}
function svgEl(n,attrs){const x=document.createElementNS("http://www.w3.org/2000/svg",n);for(const k in attrs)x.setAttribute(k,attrs[k]);return x;}

/* Линия по замерам: каждый замер сохраняет место, история прокручивается. */
function lineChart(host,pts,opts){
  opts=opts||{};host.innerHTML="";host.classList.add("line-chart");
  if(pts.length<2){host.appendChild(el("div","pempty","Нужно минимум два замера для графика"));return;}
  const W=Math.max(240,24+(pts.length-1)*48),H=200,PL=12,PR=12,PT=16,PB=30;
  const ys=pts.map(p=>p.y),nt=niceTicks(Math.min(...ys),Math.max(...ys),4);
  const sx=i=>PL+i*((W-PL-PR)/(pts.length-1));
  const sy=v=>PT+(H-PT-PB)*(1-(v-nt.lo)/((nt.hi-nt.lo)||1));
  const detail=el("div","chart-detail");
  detail.setAttribute("aria-live","polite");detail.setAttribute("aria-atomic","true");
  const value=el("div","chart-value"),date=el("div","chart-date"),extra=el("div","chart-extra");
  detail.append(el("div","chart-caption","Выбранный замер"),value,date,extra);host.appendChild(detail);
  const frame=el("div","chart-frame"),scroll=el("div","chart-scroll");
  scroll.tabIndex=0;scroll.setAttribute("role","region");scroll.setAttribute("aria-label","История замеров. Стрелки влево и вправо выбирают замер");
  const scale=svgEl("svg",{viewBox:"0 0 42 "+H,class:"chart-scale","aria-hidden":"true"});
  const svg=svgEl("svg",{viewBox:"0 0 "+W+" "+H,preserveAspectRatio:"none",role:"img","aria-label":"График по датам замеров"});
  svg.style.minWidth=W+"px";
  nt.ticks.forEach(v=>{
    svg.appendChild(svgEl("line",{x1:0,x2:W,y1:sy(v),y2:sy(v),class:"grid"}));
    const tx=svgEl("text",{x:36,y:sy(v)+4,"text-anchor":"end",class:"ax"});
    tx.textContent=Math.abs(v)>=10000?fmtK(v):v.toLocaleString("ru-RU",{maximumFractionDigits:3});scale.appendChild(tx);
  });
  // Leave enough room for both the neighbouring date and the final date label.
  const labels=[0];
  for(let i=1;i<pts.length-1;i++){
    if(sx(i)-sx(labels[labels.length-1])>=64&&sx(pts.length-1)-sx(i)>=64)labels.push(i);
  }
  labels.push(pts.length-1);
  labels.forEach(i=>{
    const tx=svgEl("text",{x:sx(i),y:H-8,"text-anchor":i===0?"start":i===pts.length-1?"end":"middle",class:"ax chart-x-label"});
    tx.textContent=shortDate(pts[i].x);svg.appendChild(tx);
  });
  const line=pts.map((p,i)=>(i?"L":"M")+sx(i).toFixed(1)+","+sy(p.y).toFixed(1)).join(" ");
  const base=sy(nt.lo);
  svg.appendChild(svgEl("path",{d:line+" L"+sx(pts.length-1).toFixed(1)+","+base+" L"+sx(0).toFixed(1)+","+base+" Z",class:"ar"}));
  svg.appendChild(svgEl("path",{d:line,class:"ln"}));
  const cross=svgEl("line",{x1:0,x2:0,y1:PT,y2:H-PB,class:"cross"});svg.appendChild(cross);
  const dots=pts.map((p,i)=>{
    const dot=svgEl("circle",{cx:sx(i),cy:sy(p.y),r:4,class:"dot"+(p.pr?" pr":"")});svg.appendChild(dot);return dot;
  });
  const hit=svgEl("rect",{x:0,y:0,width:W,height:H,class:"hit"});svg.appendChild(hit);
  scroll.appendChild(svg);frame.append(scale,scroll);host.appendChild(frame);
  const nav=el("div","chart-nav"),prev=el("button",null,"←"),next=el("button",null,"→"),latest=el("button","chart-latest","Последний"),position=el("span","chart-position");
  prev.setAttribute("aria-label","Предыдущий замер");next.setAttribute("aria-label","Следующий замер");latest.setAttribute("aria-label","К последнему замеру");
  [prev,next,latest].forEach(b=>b.type="button");nav.append(prev,position,next,latest);host.appendChild(nav);
  host.appendChild(el("div","chart-hint",pts.length>6?"Листай историю в стороны · нажми на замер":"Нажми на замер или используй стрелки"));
  let sel=-1;
  function reveal(i,behavior){
    const rect=svg.getBoundingClientRect(),x=sx(i)*rect.width/W;
    scroll.scrollTo({left:Math.max(0,x-scroll.clientWidth/2),behavior:behavior||"auto"});
  }
  function show(i,move){
    i=Math.max(0,Math.min(pts.length-1,i));
    if(sel>=0)dots[sel].setAttribute("r",4);
    sel=i;const p=pts[i],x=sx(i);
    cross.setAttribute("x1",x);cross.setAttribute("x2",x);cross.style.opacity=1;dots[i].setAttribute("r",6);
    value.textContent=(opts.fmt||trim)(p.y)+(opts.unit?" "+opts.unit:"");
    date.textContent=new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"long",year:"numeric"}).format(parseD(p.x))+(p.pr?" · рекорд":"");
    extra.textContent=p.sub||"";extra.hidden=!p.sub;
    position.textContent=(i+1)+" / "+pts.length;
    prev.disabled=i===0;next.disabled=i===pts.length-1;
    if(move)reveal(i,window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth");
  }
  const chooseAt=ev=>{
    const rect=svg.getBoundingClientRect(),x=(ev.clientX-rect.left)*W/rect.width;
    show(Math.round((x-PL)/(W-PL-PR)*(pts.length-1)),false);
  };
  let down=null;
  hit.addEventListener("pointerdown",ev=>{down={x:ev.clientX,y:ev.clientY};});
  hit.addEventListener("pointercancel",()=>{down=null;});
  hit.addEventListener("pointerup",ev=>{
    if(down&&Math.hypot(ev.clientX-down.x,ev.clientY-down.y)<10)chooseAt(ev);
    down=null;
  });
  hit.addEventListener("pointermove",ev=>{if(ev.pointerType==="mouse"&&!ev.buttons)chooseAt(ev);});
  prev.onclick=()=>show(sel-1,true);next.onclick=()=>show(sel+1,true);latest.onclick=()=>show(pts.length-1,true);
  scroll.addEventListener("keydown",ev=>{
    const i={ArrowLeft:sel-1,ArrowRight:sel+1,Home:0,End:pts.length-1}[ev.key];
    if(i===undefined)return;ev.preventDefault();show(i,true);
  });
  show(pts.length-1,false);
  // The body-weight card may still be detached when this chart is constructed.
  requestAnimationFrame(()=>{if(host.isConnected)reveal(sel);});
}

/* Столбики: bars=[{x:'label', y:v, sub:'html', dim:bool}] */
function barChart(host,bars,opts){
  opts=opts||{};host.innerHTML="";
  if(!bars.length){host.appendChild(el("div","pempty","Данных пока нет"));return;}
  const W=340,H=140,PL=36,PR=8,PT=14,PB=22;
  const mx=Math.max(...bars.map(b=>b.y),1);
  const nt=niceTicks(0,mx,4);
  const slot=(W-PL-PR)/bars.length,bw=Math.min(24,slot*.62);
  const sy=v=>PT+(H-PT-PB)*(1-v/(nt.hi||1));
  const svg=svgEl("svg",{viewBox:"0 0 "+W+" "+H,role:"img"});
  nt.ticks.forEach(v=>{
    svg.appendChild(svgEl("line",{x1:PL,x2:W-PR,y1:sy(v),y2:sy(v),class:"grid"}));
    const tx=svgEl("text",{x:PL-6,y:sy(v)+3.5,"text-anchor":"end",class:"ax"});tx.textContent=fmtK(v);svg.appendChild(tx);
  });
  const base=sy(0),r=4;
  const rects=[];
  bars.forEach((b,i)=>{
    const x=PL+slot*i+(slot-bw)/2,y=b.y>0?sy(b.y):base;
    const h=base-y;
    let d;
    if(h<=r)d="M"+x+","+base+" L"+x+","+y+" L"+(x+bw)+","+y+" L"+(x+bw)+","+base+" Z";
    else d="M"+x+","+base+" L"+x+","+(y+r)+" Q"+x+","+y+" "+(x+r)+","+y+" L"+(x+bw-r)+","+y+" Q"+(x+bw)+","+y+" "+(x+bw)+","+(y+r)+" L"+(x+bw)+","+base+" Z";
    const p=svgEl("path",{d:d,class:"bar"+(b.dim?" dim":"")});svg.appendChild(p);rects.push(p);
    if(bars.length<=12||i%2===0||i===bars.length-1){
      const tx=svgEl("text",{x:x+bw/2,y:H-6,"text-anchor":"middle",class:"ax"});tx.textContent=b.x;svg.appendChild(tx);
    }
  });
  const hit=svgEl("rect",{x:PL,y:0,width:W-PL-PR,height:H,class:"hit"});svg.appendChild(hit);
  host.appendChild(svg);
  const tip=tipFor(host);
  let sel=-1;
  const show=i=>{
    if(i===sel)return;sel=i;
    rects.forEach((p,k)=>p.classList.toggle("hot",k===i));
    const b=bars[i],rect=svg.getBoundingClientRect();
    const cx=PL+slot*i+slot/2;
    placeTip(host,tip,cx*rect.width/W,'<b>'+(opts.fmt||fmtN)(b.y)+(opts.unit?" "+opts.unit:"")+'</b>'+(b.sub||""));
  };
  const onMove=ev=>{
    const rect=svg.getBoundingClientRect();
    const x=(ev.clientX-rect.left)*W/rect.width;
    show(Math.max(0,Math.min(bars.length-1,Math.floor((x-PL)/slot))));
  };
  hit.addEventListener("pointerdown",onMove);
  hit.addEventListener("pointermove",ev=>{if(ev.pointerType==="mouse"||ev.buttons)onMove(ev);});
  let init=bars.length-1;while(init>0&&!bars[init].y)init--;show(init);
}

function spark(vals){
  if(vals.length<2)return "";
  const W=86,H=30,P=3;
  const mn=Math.min(...vals),mx=Math.max(...vals),rng=(mx-mn)||1;
  const pts=vals.map((v,i)=>{
    const x=P+i*((W-P*2)/(vals.length-1));
    const y=H-P-((v-mn)/rng)*(H-P*2);
    return x.toFixed(1)+","+y.toFixed(1);
  });
  const col=vals[vals.length-1]>=vals[0]?"#48B58C":"#D96A5B";
  const [lx,ly]=pts[pts.length-1].split(",");
  return '<svg class="spark" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+
    '<polyline points="'+pts.join(" ")+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'+
    '<circle cx="'+lx+'" cy="'+ly+'" r="3" fill="'+col+'" stroke="#1B3242" stroke-width="2"/></svg>';
}

/* ---------- аналитика ---------- */
function allRecords(){
  const out=[];
  DAY_IDS.forEach(day=>PROGRAM[day].ex.forEach((e,i)=>{
    (state.hist[day+"|"+i]||[]).forEach(r=>out.push({day:day,i:i,e:e,r:r}));
  }));
  return out;
}
/* по датам: тоннаж, подходы, повторы, день программы */
function byDate(){
  const m={};
  allRecords().forEach(x=>{
    const o=m[x.r.d]||(m[x.r.d]={d:x.r.d,day:x.day,v:0,n:0,reps:0,ex:0});
    o.v+=x.r.v||0;o.n+=x.r.n||0;o.reps+=recReps(x.r);o.ex++;
  });
  return m;
}
function weekStats(dates){
  const w={};
  Object.values(dates).forEach(o=>{
    const k=weekStart(o.d);
    const x=w[k]||(w[k]={k:k,v:0,n:0,days:0});
    x.v+=o.v;x.n+=o.n;x.days++;
  });
  return w;
}
function computePRs(){
  const ev=[];
  DAY_IDS.forEach(day=>PROGRAM[day].ex.forEach(e=>{
    const all=state.hist[e.k]||[];
    const groups=isMachine(e)?state.gyms.map(g=>all.filter(r=>recGym(r)===g.id)):[all];
    groups.forEach(arr=>{
      if(!arr.length)return;
      const nm=e.n+(isMachine(e)?" · "+gymName(recGym(arr[0])):"");
      let mw=null,me=-1,mv=-1;
      arr.forEach((r,idx)=>{
        const e1=recE1(r,e);
        if(idx>0){
          if(e.w&&heavier(e,r.w,mw)&&(r.w>0||isAssist(e)))ev.push({d:r.d,n:nm,t:isAssist(e)?"противовес":"вес",val:trim(r.w)+" кг",prev:trim(mw)+" кг"});
          else if(e.w&&e1>me&&e1>0)ev.push({d:r.d,n:nm,t:"1ПМ",val:trim(e1)+" кг",prev:trim(me)+" кг"});
          else if(e.w&&r.v>mv&&r.v>0)ev.push({d:r.d,n:nm,t:"объём",val:fmtN(r.v)+" кг",prev:fmtN(mv)+" кг"});
          else if(!e.w&&r.r>mw)ev.push({d:r.d,n:nm,t:e.sec?"время":"повторы",val:r.r+(e.sec?" сек":""),prev:mw+(e.sec?" сек":"")});
        }
        const sc=e.w?r.w:r.r;
        mw=mw===null?sc:(e.w?(heavier(e,sc,mw)?sc:mw):Math.max(mw,sc));me=Math.max(me,e1);mv=Math.max(mv,r.v);
      });
    });
  }));
  ev.sort((a,b)=>a.d<b.d?1:a.d>b.d?-1:0);
  return ev;
}
function streakWeeks(weeks){
  let k=weekStart(todayKey()),n=0;
  if(!weeks[k])k=addDays(k,-7);
  while(weeks[k]){n++;k=addDays(k,-7);}
  return n;
}

/* ---------- экран прогресса ---------- */
let pview="all";
const openCards={};
function renderPTabs(){
  const c=document.getElementById("ptabs");c.innerHTML="";
  [["all","Обзор"]].concat(DAY_IDS.map(d=>[d,PROGRAM[d].name])).forEach(([id,lbl])=>{
    const b=el("button","ptab",esc(lbl));b.setAttribute("role","tab");b.setAttribute("aria-selected",id===pview);
    b.onclick=()=>{pview=id;renderPTabs();renderProgress();window.scrollTo({top:0});};
    c.appendChild(b);
  });
}
function renderProgress(){
  main.innerHTML="";
  const h=state.hist;
  let any=false;for(const k in h){if(h[k].length)any=true;}
  if(pview==="all"){
    if(!any)main.innerHTML='<div style="height:18px"></div><div class="restday"><b>Данных пока нет</b>Отметь подходы на тренировке - прогресс появится здесь после первой сессии.</div>';
    else renderOverview();
    main.appendChild(bodyWeightCard());
  }else{
    renderDayGroup(pview);
  }
  const foot=el("div","foot");
  if(pview==="all"){
    const c=el("button",null,"Стереть историю прогресса");c.style.marginTop="8px";
    c.onclick=()=>{if(confirm("Удалить всю историю? Вернуть можно будет кнопкой в подвале.")){snapshot("Стереть историю");state.hist={};state.sess={};state.notes={};saveNow();renderProgress();}};
    foot.appendChild(c);
  }
  const ub=undoButton();if(ub)foot.appendChild(ub);
  foot.appendChild(cloudBox());
  main.appendChild(foot);
}

function renderOverview(){
  const dates=byDate(),weeks=weekStats(dates);
  const dlist=Object.keys(dates).sort();
  const t=todayKey(),wk=weekStart(t),pwk=addDays(wk,-7),ppwk=addDays(wk,-14);
  const cw=weeks[wk]||{v:0,days:0,n:0},pw=weeks[pwk]||{v:0,days:0,n:0},ppw=weeks[ppwk]||{v:0,days:0};
  const prs=computePRs();
  const recentPR=prs.filter(p=>daysBetween(p.d,t)<=14).length;
  const streak=streakWeeks(weeks);
  const since=daysBetween(dlist[dlist.length-1],t);
  const dv=pw.v-ppw.v,dvp=ppw.v?Math.round(dv/ppw.v*100):0;

  const tiles=el("div","tiles");
  tiles.innerHTML=
    tile("Тренировок",dlist.length,"",streak?"серия "+streak+" нед. подряд":"с "+shortDate(dlist[0]))+
    tile("Эта неделя",cw.days,"<small>/ 4</small>",cw.v?fmtN(cw.v)+" кг · "+cw.n+" подх.":(since===0?"сегодня тренировка":since+" дн. без тренировки"))+
    tile("Прошлая неделя",fmtK(pw.v),"<small>кг</small>",ppw.v?'<span class="'+(dv>0?"up":dv<0?"down":"flat")+'">'+(dv>0?"+":"")+fmtN(dv)+' кг ('+(dvp>0?"+":"")+dvp+'%)</span> к позапрошлой':pw.days+" тренировки")+
    tile("Рекордов",recentPR,"","за 14 дней · всего "+prs.length);
  main.appendChild(tiles);

  /* тоннаж по неделям */
  const wc=el("div","card",'<div class="chead"><div><h4>Тоннаж по неделям</h4><div class="sub">Сумма вес × повторы за все тренировки недели</div></div></div><div class="chart"></div>');
  const bars=[];
  for(let k=addDays(wk,-9*7);k<=wk;k=addDays(k,7)){
    const w=weeks[k]||{v:0,days:0,n:0};
    const ws=parseD(k);
    bars.push({x:pad(ws.getDate())+"."+pad(ws.getMonth()+1),y:w.v,dim:k===wk,sub:shortDate(k)+" – "+shortDate(addDays(k,6))+(k===wk?" · текущая":"")+'<span class="ts">'+w.days+" тренир. · "+w.n+" подходов</span>"});
  }
  main.appendChild(wc);
  barChart(wc.querySelector(".chart"),bars,{unit:"кг"});

  /* календарь */
  const hc=el("div","card",'<div class="chead"><div><h4>Календарь · 12 недель</h4><div class="sub">Ярче - больше тоннаж. Нажми на день</div></div></div><div class="heat"></div><div class="heatlbl"></div><div class="heatinfo">Нажми на клетку, чтобы увидеть тренировку</div>');
  const grid=hc.querySelector(".heat"),info=hc.querySelector(".heatinfo");
  const start=addDays(wk,-11*7);
  const maxV=Math.max(1,...Object.values(dates).map(o=>o.v));
  const WD=["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];
  for(let d=start,i=0;i<84;d=addDays(d,1),i++){
    const o=dates[d];const c=el("div","hcell");
    if(o){const q=o.v/maxV;c.classList.add(q>.75?"l4":q>.5?"l3":q>.25?"l2":"l1");}
    if(d===t)c.classList.add("today");
    if(d>t)c.classList.add("future");
    c.dataset.d=d;
    c.onclick=()=>{
      grid.querySelectorAll(".sel").forEach(x=>x.classList.remove("sel"));c.classList.add("sel");
      const wd=WD[(parseD(d).getDay()+6)%7];
      if(!o){info.innerHTML='<b>'+wd+' '+shortDate(d)+'</b> · без тренировки';return;}
      const s=state.sess[d];
      info.innerHTML='<b>'+wd+' '+shortDate(d)+' · '+esc(PROGRAM[o.day].name)+'</b> · '+fmtN(o.v)+' кг · '+o.n+' подходов · '+o.ex+' упр.'+(s&&s.t1>s.t0?' · '+fmtDur(s.t1-s.t0):'');
    };
    grid.appendChild(c);
  }
  hc.querySelector(".heatlbl").innerHTML='<span>'+shortDate(start)+'</span><span>Пн – Вс сверху вниз</span><span>'+shortDate(addDays(wk,6))+'</span>';
  main.appendChild(hc);

  /* рекорды */
  const pc=el("div","card",'<div class="chead"><div><h4>Последние рекорды</h4><div class="sub">Вес, расчётный 1ПМ или объём выше всех прошлых</div></div></div>');
  if(!prs.length)pc.appendChild(el("div","pempty","Пока нет рекордов - они появятся со второй тренировки по упражнению"));
  prs.slice(0,8).forEach(p=>pc.appendChild(el("div","prrow",'<div class="pd">'+shortDate(p.d)+'</div><div class="pn">'+esc(p.n)+'<small>'+p.t+' · было '+esc(p.prev)+'</small></div><div class="pv">'+esc(p.val)+'</div>')));
  main.appendChild(pc);

  /* лучшие упражнения по росту */
  const growth=[];
  DAY_IDS.forEach(day=>PROGRAM[day].ex.forEach((e,i)=>{
    const a=recsFor(e,state.gym);if(a.length<2||!e.w)return;
    const f=a[0],l=a[a.length-1];const e0=recE1(f,e),e1=recE1(l,e);
    if(e0>0)growth.push({n:e.n,p:Math.round((e1-e0)/e0*100),from:trim(e0),to:trim(e1),d:daysBetween(f.d,l.d)});
  }));
  growth.sort((a,b)=>b.p-a.p);
  if(growth.length){
    const gc=el("div","card",'<div class="chead"><div><h4>Рост силы</h4><div class="sub">Расчётный 1ПМ: первая запись → последняя</div></div></div>');
    growth.slice(0,5).forEach(g=>gc.appendChild(el("div","prrow",'<div class="pn">'+esc(g.n)+'<small>'+g.from+' → '+g.to+' кг за '+g.d+' дн.</small></div><div class="pv '+(g.p>0?"up":g.p<0?"down":"flat")+'">'+(g.p>0?"+":"")+g.p+'%</div>')));
    if(growth.length>5){
      const worst=growth.slice(-2).filter(g=>g.p<=0);
      worst.forEach(g=>gc.appendChild(el("div","prrow",'<div class="pn">'+esc(g.n)+'<small>'+g.from+' → '+g.to+' кг за '+g.d+' дн. · отстаёт</small></div><div class="pv '+(g.p<0?"down":"flat")+'">'+g.p+'%</div>')));
    }
    main.appendChild(gc);
  }
}
function tile(l,v,vs,d){return '<div class="tile"><div class="tl">'+l+'</div><div class="tv">'+v+vs+'</div><div class="td">'+d+'</div></div>';}

function bodyWeightCard(){
  const c=el("div","card",'<div class="chead"><div><h4>Вес тела</h4><div class="sub">Утром, после туалета, до еды</div></div></div>');
  const row=el("div","bwrow",'<div class="fld"><input type="number" inputmode="decimal" step="0.1" placeholder="кг"><span>кг</span></div><button>Записать</button>');
  const inp=row.querySelector("input");
  row.querySelector("button").onclick=()=>{
    const w=parseFloat(inp.value);if(!w||w<30||w>300){toast("Введи вес в кг");return;}
    const t=todayKey();const ex=state.bw.find(x=>x.d===t);
    if(ex)ex.w=w;else state.bw.push({d:t,w:w});
    state.bw.sort((a,b)=>a.d<b.d?-1:1);save();renderProgress();toast("Вес записан");
  };
  c.appendChild(row);
  const bw=state.bw;
  if(bw.length){
    const l=bw[bw.length-1];
    let d7="";
    const ago=bw.filter(x=>daysBetween(x.d,l.d)>=6);
    if(ago.length){const a=ago[ago.length-1];const dd=l.w-a.w;d7=' · за '+daysBetween(a.d,l.d)+' дн. <span class="'+(dd<0?"up":dd>0?"down":"flat")+'">'+(dd>0?"+":"")+trim(dd)+' кг</span>';}
    const first=bw[0];const dt=l.w-first.w;
    const info=el("div","bwlast",'Сейчас <b>'+trim(l.w)+' кг</b> ('+shortDate(l.d)+')'+d7+(bw.length>1?' · с начала <span class="'+(dt<0?"up":dt>0?"down":"flat")+'">'+(dt>0?"+":"")+trim(dt)+'</span>':''));
    const del=el("button","notebtn","удалить последнюю");del.style.marginTop="0";del.style.marginLeft="8px";del.style.padding="2px 8px";
    del.onclick=()=>{if(confirm("Удалить запись "+shortDate(l.d)+" · "+trim(l.w)+" кг?")){bw.pop();save();renderProgress();}};
    info.appendChild(del);c.appendChild(info);
    if(bw.length>=2){const ch=el("div","chart");c.appendChild(ch);lineChart(ch,bw.map(x=>({x:x.d,y:x.w})),{unit:"кг"});}
  }else c.appendChild(el("div","pempty","Записывай раз в неделю - увидишь тренд на фоне тоннажа"));
  return c;
}

/* ---------- прогресс по дню: карточки упражнений ---------- */
function metricsFor(e){
  if(e.w)return [
    isAssist(e)?{id:"w",lbl:"Нагрузка",f:r=>Math.round(effW(e,r.w,r.d)*10)/10,unit:"кг"}:{id:"w",lbl:"Вес",f:r=>r.w,unit:"кг"},
    {id:"v",lbl:"Объём",f:r=>r.v,unit:"кг",fmt:fmtN},
    {id:"e1",lbl:"1ПМ",f:r=>Math.round(recE1(r,e)*10)/10,unit:"кг"},
    {id:"reps",lbl:"Повторы",f:r=>recReps(r),unit:""}
  ];
  return [
    {id:"r",lbl:e.sec?"Лучший, сек":"Лучший подход",f:r=>r.r,unit:e.sec?"сек":""},
    {id:"reps",lbl:"Всего за тренировку",f:r=>recReps(r),unit:e.sec?"сек":""}
  ];
}
const metricSel={};
let pgym=null;
function renderDayGroup(day){
  const p=PROGRAM[day];
  const g=el("div","pgroup",'<h3>'+esc(p.name)+' <small>· '+esc(p.note)+'</small></h3>');
  const pg=pgym||state.gym;
  if(p.ex.some(isMachine)){
    const row=el("div","gymrow");
    row.appendChild(el("span","gl","Тренажёры в зале"));
    state.gyms.forEach(x=>{
      const b=el("button","gchip",esc(x.n));b.setAttribute("aria-pressed",x.id===pg);
      b.onclick=()=>{pgym=x.id;renderProgress();};row.appendChild(b);
    });
    g.appendChild(row);
  }
  let shown=0;
  p.ex.forEach((e,i)=>{
    const arr=recsFor(e,pg);
    if(!arr.length)return;
    shown++;
    g.appendChild(progressCard(day,e,i,arr));
  });
  if(!shown)g.appendChild(el("div","restday","<b>Пока пусто</b>Записей по этому дню ещё нет."));
  main.appendChild(g);
}
function progressCard(day,e,i,arr){
  const k=day+"|"+i;
  const cur_=arr[arr.length-1], prev=arr.length>1?arr[arr.length-2]:null;
  const card=el("div","pex"+(openCards[k]?" open":""));
  const as=isAssist(e);
  let delta='<span class="pdelta flat">первая запись</span>';
  if(prev){
    const dw=cur_.w-prev.w, dv=cur_.v-prev.v, dr=recReps(cur_)-recReps(prev);
    let m;
    if(e.w&&dw!==0)m='<span class="'+(heavier(e,cur_.w,prev.w)?"up":"down")+'">'+(dw>0?"+":"")+trim(dw)+(as?" кг прот.":" кг")+'</span>';
    else if(cur_.r>prev.r)m='<span class="up">+'+(cur_.r-prev.r)+(e.sec?" сек":" повт.")+'</span>';
    else if(cur_.r<prev.r)m='<span class="down">'+(cur_.r-prev.r)+(e.sec?" сек":" повт.")+'</span>';
    else m='<span class="flat">тот же вес</span>';
    const sub=e.w?'объём '+(dv>0?"+":"")+fmtN(dv)+' кг':'всего '+(dr>0?"+":"")+dr;
    delta='<span class="pdelta">'+m+'<small>'+sub+'</small></span>';
  }
  const val=e.w
    ? '<div class="pnow">'+trim(cur_.w)+'<small>'+(as?"кг прот.":"кг")+' × '+cur_.r+'</small></div>'
    : '<div class="pnow">'+cur_.r+'<small>'+(e.sec?"сек":"повт")+'</small></div>';
  const sp=spark(arr.slice(-8).map(r=>e.w?recE1(r,e):recReps(r)));
  const rd=readiness(e,cur_);
  const head=el("button","phead",
    '<div class="pname">'+esc(e.n)+'</div>'+
    '<div class="pline">'+val+delta+sp+'</div>'+
    '<div class="plast"><b>'+shortDate(cur_.d)+(cur_.d===todayKey()?" (сегодня)":"")+'</b></div>'+
    (rd?'<div class="ready'+(rd.ok?"":" hold")+'">'+(rd.ok?ARROW:"")+esc(rd.txt)+'</div>':''));
  head.querySelector(".plast").appendChild(el("div",null,setsHTML(e,cur_)));
  head.onclick=()=>{
    openCards[k]=!openCards[k];card.classList.toggle("open",openCards[k]);
    if(openCards[k]&&!body.childElementCount)fillBody();
  };
  card.appendChild(head);
  const body=el("div","pbody");card.appendChild(body);
  function fillBody(){
    body.innerHTML="";
    const ms=metricsFor(e);
    if(!metricSel[k])metricSel[k]=ms[0].id;
    const chips=el("div","mchips");
    ms.forEach(m=>{
      const b=el("button","mchip",m.lbl);b.setAttribute("aria-pressed",metricSel[k]===m.id);
      b.onclick=()=>{metricSel[k]=m.id;chips.querySelectorAll(".mchip").forEach(x=>x.setAttribute("aria-pressed",x===b));draw();};
      chips.appendChild(b);
    });
    body.appendChild(chips);
    const ch=el("div","chart");body.appendChild(ch);
    function draw(){
      const m=ms.find(x=>x.id===metricSel[k]);
      let mx=-Infinity;
      const pts=arr.map((r,idx)=>{
        const y=m.f(r);const pr=idx>0&&y>mx&&y>0;mx=Math.max(mx,y);
        return {x:r.d,y:y,pr:pr,sub:r.s&&r.s.length?r.s.map(x=>chipTxt(e,x)).join(" · "):("лучший "+chipTxt(e,[r.w,r.r])+" · "+r.n+" подх.")};
      });
      lineChart(ch,pts,{unit:m.unit,fmt:m.fmt||trim});
    }
    draw();
    /* рекорды */
    let bw=null,be=null,bv=null;
    arr.forEach(r=>{
      if(!bw||heavier(e,r.w,bw.w)||(r.w===bw.w&&r.r>bw.r))bw=r;
      const e1=recE1(r,e);if(!be||e1>be.e1)be={e1:e1,d:r.d};
      if(!bv||r.v>bv.v)bv=r;
    });
    const rec=e.w
      ?'Рекорды: <b>'+trim(bw.w)+'×'+bw.r+'</b> ('+shortDate(bw.d)+') · 1ПМ <b>'+trim(be.e1)+' кг</b> ('+shortDate(be.d)+') · объём <b>'+fmtN(bv.v)+' кг</b> ('+shortDate(bv.d)+')'
      :'Рекорд: <b>'+bw.r+(e.sec?" сек":" повт.")+'</b> ('+shortDate(bw.d)+') · всего за тренировку <b>'+Math.max(...arr.map(recReps))+'</b>';
    body.appendChild(el("div","prec",rec+' · тренировок: <b>'+arr.length+'</b>'));
    /* все сессии */
    const sl=el("div","sesslist",'<div class="sesshead">Все тренировки · подходы</div>');
    arr.slice().reverse().forEach((r,idx)=>{
      const pv=arr[arr.length-2-idx];
      let dv="";
      if(pv&&e.w&&r.v){const d=r.v-pv.v;dv='<span class="'+(d>0?"up":d<0?"down":"flat")+'">'+(d>0?"+":"")+fmtN(d)+'</span>';}
      const note=state.notes[k]&&state.notes[k][r.d];
      sl.appendChild(el("div","hrow",'<div class="hdate">'+shortDate(r.d)+'</div><div class="hsets">'+setsHTML(e,r)+(note?'<div class="hnote">'+esc(note)+'</div>':'')+'</div>'+
        (e.w?'<div class="hvol"><b>'+fmtN(r.v)+'</b>'+dv+'</div>':'<div class="hvol"><b>'+recReps(r)+'</b>'+(e.sec?"сек":"повт")+'</div>')));
    });
    body.appendChild(sl);
    const legacy=arr.some(r=>!r.s);
    if(legacy)body.appendChild(el("div","pempty","Записи до 28.09 хранят только лучший подход - раскладка по подходам копится с этой версии."));
  }
  if(openCards[k])fillBody();
  return card;
}

function rulesHTML(){
  let v='<table class="vol">';
  VOLUME.forEach(r=>v+='<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>');
  v+='</table>';
  return '<div class="rules"><details><summary>Правила программы</summary><ol>'+
  '<li><b>Прогрессия двойная.</b> Вышел на верх диапазона во всех подходах - добавляй 2.5-5 кг и возвращайся к нижней границе. Приложение подскажет жёлтой плашкой.</li>'+
  '<li><b>1-3 повтора в запасе</b> в каждом рабочем подходе. Последний подход изоляции можно до отказа.</li>'+
  '<li><b>Рука.</b> Гантели вместо штанги первые 6-8 недель, брусья без веса первые 4-6.</li>'+
  '<li><b>Веса записывай сразу</b> - под номером подхода и в полях серым показано, что было в прошлый раз в этом же подходе.</li>'+
  '<li><b>Питание.</b> Дефицит 300-500 ккал, белок 1.8-2.2 г на кг. Без этого будет расти сила, но не изменится вид. Вес тела записывай в Прогрессе.</li>'+
  '<li><b>Пересмотр через 8-10 недель</b> или при остановке прогресса на 2-3 недели.</li>'+
  '</ol></details><details><summary>Недельный объём</summary>'+v+'</details></div>';
}

/* ---------- init ---------- */
let view="day";
const progBtn=document.getElementById("tab-prog");
const healthBtn=document.getElementById("tab-health");
const daysBar=document.getElementById("days"),ptabs=document.getElementById("ptabs");
function renderHealth(){
  const content=el("div","foot health-page");
  content.appendChild(cloudService.render({health:true}));
  main.replaceChildren(content);
}
function showView(next){
  view=next;
  progBtn.classList.toggle("on",view==="prog");
  progBtn.textContent=(view!=="day")?"Тренировка":"Прогресс";
  healthBtn.classList.toggle("on",view==="health");
  healthBtn.setAttribute("aria-pressed",view==="health");
  daysBar.style.display=(view==="day")?"flex":"none";
  ptabs.style.display=(view==="prog")?"flex":"none";
  const url=new URL(location.href);
  if(view==="health")url.searchParams.set("view","health");else url.searchParams.delete("view");
  history.replaceState(history.state,"",url);
  if(view==="prog")renderPTabs();
  rerender();
  window.scrollTo({top:0});
}
progBtn.onclick=()=>showView(view==="day"?"prog":"day");
healthBtn.onclick=()=>showView("health");
/* вернулись в приложение на следующий день - форма должна быть чистой */
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState!=="visible")return;
  const before=JSON.stringify(state.logDate);
  freshenLogs();
  if(JSON.stringify(state.logDate)!==before){save();if(view==="day")renderDay();}
  cloudSync();
});
/* без зума: пинч и двойной тап */
document.addEventListener("gesturestart",e=>e.preventDefault(),{passive:false});
document.addEventListener("gesturechange",e=>e.preventDefault(),{passive:false});
document.addEventListener("touchmove",e=>{if(e.scale!==undefined&&e.scale!==1)e.preventDefault();},{passive:false});
let lastTouch=0;
document.addEventListener("touchend",e=>{
  const now=Date.now();
  if(now-lastTouch<300&&!(e.target.closest("input")))e.preventDefault();
  lastTouch=now;
},{passive:false});
document.addEventListener("dblclick",e=>e.preventDefault(),{passive:false});

const cloudService=createCloud({
  getState:()=>state,
  applyState:(next)=>{snapshot("Синхронизация");state=next;normalize();freshenLogs();writeLocal();rerender();},
  onChange:()=>cloudService.updateStatus(),
  toast,
});
function cloudLoad(){cloudService.start();}
function cloudSchedule(){cloudService.changed();}
function cloudSync(){cloudService.sync();}
function cloudFlush(){cloudService.flush();}
function cloudBox(){return cloudService.render();}

(function(){
  load();
  cloudLoad();
  try{navigator.storage&&navigator.storage.persist&&navigator.storage.persist();}catch(e){}
  renderDays();
  const h=location.hash.replace("#","");
  if(new URLSearchParams(location.search).get("view")==="health")showView("health");
  else if(h.startsWith("prog")){
    const d=h.split("-")[1];if(d&&PROGRAM[d])pview=d;
    progBtn.onclick();
  }else renderDay();
  cloudSync();
  restoreRestTimer();

})();

if(import.meta.env.PROD && 'serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='OPEN_WORKOUT')showView('day');});
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js', {scope:import.meta.env.BASE_URL})
      .catch(()=>{});
  });
}
