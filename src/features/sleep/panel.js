import './sleep.css';
import { supabase } from '../../data/supabase.js';
import { loadSleepHistory } from '../../data/sleep-history.js';
import { summarizeSleep, sleepSourceLabel, SLEEP_STAGES, SLEEP_METRICS } from '../../domain/sleep.js';
import { importHealthFile } from './export.js';

const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!=null)n.textContent=value;if(cls)n.className=cls;return n;};
const button=(label,fn)=>{const n=el('button',label);n.type='button';n.onclick=fn;return n;};
const duration=value=>value==null?'—':`${Math.floor(Math.round(value)/60)} ч ${Math.round(value)%60} мин`;
const number=value=>value==null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1}).format(value);
const time=(local,utc)=>local?.slice(11,16)||new Date(utc).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
function download(data,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
class SleepPanel extends HTMLElement {
  connectedCallback() {
    this.events=new AbortController();
    if(!this.status) {
      this.month=new Date().toLocaleDateString('sv-SE').slice(0,7);
      this.status=el('p','Загружаем сон…','sleep-status');this.status.setAttribute('role','status');
      this.content=el('div',null,'sleep-content');
      const nav=el('div',null,'sleep-nav');
      this.monthInput=el('input');this.monthInput.type='month';this.monthInput.value=this.month;this.monthInput.setAttribute('aria-label','Месяц сна');
      this.monthInput.onchange=()=>{if(/^\d{4}-\d{2}$/.test(this.monthInput.value))this.changeMonth(this.monthInput.value);};
      const move=step=>{const [y,m]=this.month.split('-').map(Number);this.changeMonth(new Date(Date.UTC(y,m-1+step,1)).toISOString().slice(0,7));};
      const prev=button('‹',()=>move(-1)),next=button('›',()=>move(1));
      prev.setAttribute('aria-label','Предыдущий месяц сна');next.setAttribute('aria-label','Следующий месяц сна');
      nav.append(prev,this.monthInput,next);
      this.retry=button('↻ Обновить сон',()=>this.refresh());
      this.append(nav,this.status,this.content,this.retry,this.setup());
    }
    const resume=()=>this.refresh();
    for(const event of ['focus','pageshow','online','offline'])window.addEventListener(event,resume,{signal:this.events.signal});
    document.addEventListener('visibilitychange',resume,{signal:this.events.signal});
    this.refresh();
  }
  disconnectedCallback(){this.events.abort();this.request?.abort();this.importRequest?.abort();clearTimeout(this.timer);}
  changeMonth(month){this.month=month;this.monthInput.value=month;this.selected=null;this.rows=[];this.content.replaceChildren();this.request?.abort();this.request=null;this.refresh();}
  async refresh() {
    clearTimeout(this.timer);
    if(!navigator.onLine||document.visibilityState!=='visible') {
      this.request?.abort();if(!navigator.onLine)this.status.textContent='Нет интернета · показаны последние загруженные записи.';return;
    }
    if(this.request||!this.isConnected)return;
    const controller=new AbortController();this.request=controller;this.retry.disabled=true;
    const timeout=setTimeout(()=>controller.abort(),20000);
    try {
      const rows=await loadSleepHistory(supabase,this.owner,this.month,controller.signal);
      if(this.request!==controller||!this.isConnected)return;
      this.rows=rows;this.render();this.status.textContent='';
    } catch {if(this.request===controller&&this.isConnected)this.status.textContent='Не удалось обновить сон. Попробуй ещё раз; загруженные записи сохранены на экране.';}
    finally {clearTimeout(timeout);if(this.request===controller){this.request=null;this.retry.disabled=false;
      if(this.isConnected&&navigator.onLine&&document.visibilityState==='visible')this.timer=setTimeout(()=>this.refresh(),60000);}}
  }
  render() {
    const summary=summarizeSleep(this.rows||[],this.source);
    const episodes=summary.episodes.filter(e=>e.day.startsWith(this.month));
    this.content.replaceChildren();
    if(summary.sources.length>1) {
      const label=el('label','Источник сна'),select=el('select');select.setAttribute('aria-label','Источник сна');
      for(const source of summary.sources){const option=el('option',sleepSourceLabel(source));option.value=source;select.append(option);}
      select.value=summary.source;select.onchange=()=>{this.source=select.value;this.selected=null;this.render();};label.append(select);this.content.append(label);
    }
    if(!episodes.length){this.content.append(el('p','В этом месяце пока нет записей сна. После ночи с часами запусти «WEDX — Сон» или загрузи экспорт «Здоровья».','sleep-empty'));return;}
    const picker=el('select');picker.setAttribute('aria-label','Выбрать сон');
    for(const episode of episodes){const option=el('option',`${new Date(episode.day+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'})} · ${time(episode.localStart,episode.start)}–${time(episode.localEnd,episode.end)}`);option.value=String(episode.start);picker.append(option);}
    const episode=episodes.find(e=>String(e.start)===this.selected)||episodes[0];this.selected=String(episode.start);picker.value=this.selected;
    picker.onchange=()=>{this.selected=picker.value;this.render();};this.content.append(picker);
    const card=el('article',null,'sleep-night');card.dataset.day=episode.day;
    card.append(el('p',new Date(episode.day+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long',weekday:'long'}),'sleep-date'));
    card.append(el('h2',duration(episode.asleepMinutes),'sleep-duration'),el('p','Время сна по записям «Здоровья»','sleep-muted'));
    if(!episode.source)card.append(el('p','«Команды» не передали источник этих записей. Они показаны отдельно. Показатели пульса и дыхания не усредняются без подтверждённого источника. Для полной привязки загрузи экспорт «Здоровья» ниже.','sleep-muted'));
    const grid=el('div',null,'sleep-summary');
    for(const [label,value] of [[episode.asleepMinutes==null?'Начало записи':'Начало сна',time(episode.localStart,episode.start)],[episode.asleepMinutes==null?'Конец записи':'Окончание сна',time(episode.localEnd,episode.end)],['Пробуждения',episode.awakenings==null?'—':String(episode.awakenings)],['Бодрствование',duration(episode.awakeMinutes)]]) {
      const tile=el('div');tile.append(el('span',label),el('strong',value));grid.append(tile);
    }
    card.append(grid,this.timeline(episode));
    const stages=el('div',null,'sleep-stages');
    for(const stage of ['deep','core','rem','asleep','awake','unknown']) {
      const value=episode.stageMinutes[stage];if(!value)continue;
      const row=el('div',null,'sleep-stage-row');const label=el('span',SLEEP_STAGES[stage]);label.dataset.stage=stage;
      const pct=episode.asleepMinutes&&['deep','core','rem','asleep'].includes(stage)?` · ${Math.round(value/episode.asleepMinutes*100)}%`:'';
      row.append(label,el('strong',duration(value)+pct));stages.append(row);
    }
    card.append(stages);
    if(episode.unobservedMinutes>0||episode.stageMinutes.unknown>0)card.append(el('p','Есть промежутки без измерений или с неизвестной стадией. Они не засчитаны как сон.','sleep-muted'));
    const vitals=el('section',null,'sleep-vitals');vitals.append(el('h3','Показатели во время сна'));
    for(const [metric,[label,unit]] of Object.entries(SLEEP_METRICS)) {
      const stats=episode.vitals[metric];
      if(!stats&&['oxygen','wrist_temperature','breathing_disturbances'].includes(metric))continue;
      const row=el('div',null,'sleep-vital');
      const unlinked=!episode.source&&episode.samples.some(s=>s.metric===metric);
      row.append(el('span',label),el('strong',stats?`${number(stats.mean)} ${unit}`:unlinked?'Есть отдельные измерения':'Нет данных'));
      if(stats)row.append(el('small',`Мин ${number(stats.min)} · макс ${number(stats.max)} · измерений ${stats.count}`));
      vitals.append(row);
    }
    vitals.append(el('p','Средние значения по измерениям выбранного источника за время сна. Для SE 2 доступны пульс, вариабельность пульса и дыхание. Дополнительные показатели появятся, если они есть в импорте.','sleep-muted'));
    card.append(vitals);
    const more=el('details');more.append(el('summary','Подробности и исходные записи'));
    more.append(el('p',`В постели: ${duration(episode.inBedMinutes)} · до первого отрезка сна: ${duration(episode.latencyMinutes)} · доля сна в постели: ${episode.efficiency==null?'—':number(episode.efficiency)+'%'}`));
    more.append(el('p','Эти показатели рассчитываются только при наличии отдельной записи «В постели». Короткие пробуждения учитываются, только если часы их записали.'));
    more.append(el('p',`Источник: ${sleepSourceLabel(episode.source)}. Отдельных записей: ${episode.samples.length}. Дата — день окончания сна. Дневной сон сохраняется отдельным эпизодом.`));
    const updated=episode.samples.map(s=>s.imported_at).filter(Boolean).sort().at(-1);
    if(updated)more.append(el('p',`Последний импорт: ${new Date(updated).toLocaleString('ru-RU')}`));
    const goals=(this.rows||[]).filter(s=>s.metric==='sleep_goal'&&new Date(s.start_at).getTime()<=episode.end).sort((a,b)=>a.start_at.localeCompare(b.start_at));
    if(goals.length)more.append(el('p',`Цель сна из экспорта: ${duration(goals.at(-1).value)} (дата записи ${goals.at(-1).local_start.slice(0,10)})`));
    const events=(this.rows||[]).filter(s=>s.metric==='apnea_event'&&new Date(s.start_at).getTime()<=episode.end&&new Date(s.end_at).getTime()>=episode.start);
    if(events.length)more.append(el('p',`В экспорте есть уведомление Apple об апноэ за этот период. Подробности смотри в «Здоровье». Записей: ${events.length}.`));
    more.append(button('Скачать записи этого сна',()=>download(episode.samples,`wedx-sleep-${episode.day}.json`)));
    const list=el('ol',null,'sleep-records');
    for(const row of episode.samples.filter(s=>s.metric==='sleep'))list.append(el('li',`${row.local_start.slice(11,19)}–${row.local_end.slice(11,19)} · ${SLEEP_STAGES[row.stage]}${row.stage==='unknown'?` (${row.raw_value})`:''}`));
    more.append(list);
    const measurements=el('details');measurements.append(el('summary',episode.source?'Все измерения за этот сон':'Измерения за это время'));
    const measurementList=el('ol',null,'sleep-records');
    for(const row of episode.samples.filter(s=>s.metric!=='sleep').sort((a,b)=>a.start_at.localeCompare(b.start_at)))
      measurementList.append(el('li',`${row.local_start.slice(11,19)} · ${SLEEP_METRICS[row.metric]?.[0]||row.metric}: ${number(row.value)} ${SLEEP_METRICS[row.metric]?.[1]||row.unit||''}${episode.source?'':` · ${sleepSourceLabel(row.source_name)}`}`));
    if(!measurementList.children.length)measurements.append(el('p','Измерения пока не поступали.'));
    else measurements.append(measurementList);
    more.append(measurements);card.append(more);this.content.append(card);
  }
  timeline(episode) {
    const section=el('div',null,'sleep-chart');section.append(el('h3','Как менялись стадии'));
    const chart=el('div',null,'sleep-timeline');chart.setAttribute('aria-label','Стадии сна по времени');
    const start=episode.timeline[0].start,end=episode.timeline.at(-1).end;
    const detail=el('p','Нажми на отрезок, чтобы увидеть время и стадию.','sleep-muted');detail.setAttribute('role','status');
    const levels={awake:0,rem:1,core:2,asleep:2,unknown:2,in_bed:2,deep:3};
    for(const segment of episode.timeline) {
      const matching=episode.samples.find(s=>new Date(s.start_at).getTime()===segment.start);
      const label=`${SLEEP_STAGES[segment.stage]} · ${time(matching?.local_start,segment.start)} · ${duration((segment.end-segment.start)/60000)}`;
      const bar=button('',()=>{detail.textContent=label;});bar.className='sleep-segment';bar.dataset.stage=segment.stage;
      bar.setAttribute('aria-label',label);bar.title=label;
      bar.style.left=`${(segment.start-start)/(end-start)*100}%`;bar.style.width=`${Math.max(.3,(segment.end-segment.start)/(end-start)*100)}%`;bar.style.top=`${levels[segment.stage]*24}px`;
      chart.append(bar);
    }
    section.append(chart,detail);return section;
  }
  setup() {
    const details=el('details',null,'sleep-setup');details.append(el('summary','Подключить сон с Apple Watch'));
    details.append(el('p','Установи отдельную команду «WEDX — Сон». Она передаёт отрезки сна, пульс, вариабельность пульса, дыхание за последние 3 дня. История в WEDX сохраняется.'));
    const link=el('a','Скачать «WEDX — Сон»');link.href=`${import.meta.env.BASE_URL}shortcuts/${encodeURIComponent('WEDX — Сон.shortcut')}?v=3`;link.target='_blank';link.rel='noopener';details.append(link);
    details.append(el('p','Версия 3 исправляет остановку после первого этапа. Команда показывает ход четырёх этапов и результат отправки. Пульс загружается последним: отдельных измерений может быть много.'));
    const status=el('p');status.setAttribute('role','status');
    const create=button('Создать ключ для сна',async()=>{
      create.disabled=true;
      try {
        const token='wedx_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
        const {error}=await supabase.from('integration_tokens').insert({user_id:this.owner,label:'WEDX — Сон',source:'apple-health',token_hash:hash});if(error)throw error;
        if(!this.isConnected)return;
        const output=el('textarea');output.value=token;output.readOnly=true;output.rows=3;output.setAttribute('aria-label','Ключ импорта сна');
        const copy=button('Скопировать ключ сна',async()=>{try{await navigator.clipboard.writeText(token);status.textContent='Вставь ключ при добавлении команды.';}catch{output.focus();output.select();}});
        this.keyOutput?.remove();this.keyOutput=el('div');this.keyOutput.append(output,copy,button('Скрыть ключ',()=>this.keyOutput.remove()));create.after(this.keyOutput);
        status.textContent='Ключ готов. Скопируй его в новую команду.';
      }catch{status.textContent='Не удалось создать ключ. Повтори после подключения к интернету.';}finally{create.disabled=false;}
    });
    details.append(create,status,el('p','При первом запуске разреши чтение показателей и отправку в WEDX. Затем в «Команды» → «Автоматизация» → «Сон» → «Пробуждение» выбери «WEDX — Сон». Если часы синхронизируются позже, запусти команду повторно.'));
    const run=el('a','Запустить импорт сна');run.href=`shortcuts://run-shortcut?name=${encodeURIComponent('WEDX — Сон')}`;details.append(run);
    details.append(el('p','SE 2 не измеряет кислород и температуру запястья и не поддерживает выявление апноэ. Эти поля появятся только при наличии записей другого поддерживаемого устройства.'));
    details.append(button('Скачать загруженные записи месяца',()=>download(this.rows||[],`wedx-sleep-${this.month}.json`)));
    const archive=el('details');archive.append(el('summary','Загрузить всю историю и дополнительные показатели'));
    archive.append(el('p','В «Здоровье» нажми фото профиля → «Экспортировать все данные здоровья» → сохрани ZIP в «Файлы». Выбери его здесь. Можно также распаковать архив и выбрать export.xml. Для температуры запястья и нарушений дыхания нужен этот экспорт, если «Команды» не предоставляют их.'));
    archive.append(el('p','Из файла сохраняются только отрезки сна и связанные с ними измерения. Исходный архив остаётся на устройстве. Если данных нет, показатель останется пустым. Оценка сна Apple и рекомендации пока не импортируются.'));
    const file=el('input');file.type='file';file.accept='.xml,.zip,application/zip,text/xml,application/xml';file.setAttribute('aria-label','Экспорт Apple Health');
    const result=el('p');result.setAttribute('role','status');
    const cancel=button('Остановить импорт',()=>this.importRequest?.abort());cancel.hidden=true;
    file.onchange=async()=>{
      if(!file.files[0])return;file.disabled=true;cancel.hidden=false;const controller=new AbortController();this.importRequest=controller;
      result.textContent='Читаем файл на устройстве…';
      try {
        const outcome=await importHealthFile(file.files[0],async samples=>{
          controller.signal.throwIfAborted();const {data:{session}}=await supabase.auth.getSession();
          if(session?.user.id!==this.owner)throw new Error('Подключение изменилось. Открой раздел сна заново.');
          const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sleep-import`,{method:'POST',signal:controller.signal,
            headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({version:1,source:'apple-health',samples})});
          const data=await response.json();if(!response.ok)throw new Error(data.message||'Не удалось сохранить сон. Повтори импорт.');return data;
        },(count,pass)=>{result.textContent=`Сохранено записей: ${count}. ${pass==='sleep'?'Читаем стадии сна…':'Читаем ночные измерения…'}`;},controller.signal);
        result.textContent=outcome.sleepCount?`Готово. Сохранено записей: ${outcome.saved}.`:'В файле нет записей сна.';await this.refresh();
      }catch(error){result.textContent=controller.signal.aborted?'Импорт остановлен. Уже принятые записи сохранены; повторный запуск не создаст дубли.':`${error.message} Уже принятые записи сохранены; файл можно загрузить повторно.`;}
      finally{file.disabled=false;file.value='';cancel.hidden=true;this.importRequest=null;}
    };
    archive.append(file,cancel,result);details.append(archive);return details;
  }
}
customElements.define('wedx-sleep',SleepPanel);
export function sleepPanel(owner){const panel=document.createElement('wedx-sleep');panel.owner=owner;return panel;}
