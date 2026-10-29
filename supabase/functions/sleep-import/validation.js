export class SleepImportError extends Error {}
const fail = message => { throw new SleepImportError(message); };
const stages = ['in_bed','asleep','awake','core','deep','rem'];
const aliases = new Map([
  ['inbed','in_bed'],['in bed','in_bed'],['в постели','in_bed'],['в кровати','in_bed'],
  ['asleep','asleep'],['asleepunspecified','asleep'],['asleep unspecified','asleep'],['спит','asleep'],['сон','asleep'],['сна','asleep'],
  ['awake','awake'],['бодрствование','awake'],['бодрствует','awake'],
  ['core','core'],['asleepcore','core'],['asleep core','core'],['базовый','core'],['базовый сон','core'],
  ['deep','deep'],['asleepdeep','deep'],['asleep deep','deep'],['глубокий','deep'],['глубокий сон','deep'],
  ['rem','rem'],['asleeprem','rem'],['asleep rem','rem'],['быстрый','rem'],['быстрый сон','rem'],
]);
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
function shortText(value, max=250) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008]/u.test(value)) fail('Некорректный текст записи сна.');
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    fail('Нужно точное время записи с часовым поясом.');
  const [y,m,d]=value.slice(0,10).split('-').map(Number);
  if(new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)!==value.slice(0,10))fail('Неверная календарная дата.');
  return value;
}
export async function normalizeSleep(input) {
  if (input?.version!==1 || input.source!=='apple-health' || !Array.isArray(input.samples) || input.samples.length>20000)
    fail('Неверный формат сна или слишком много записей.');
  const records = new Map();
  for (const sample of input.samples) {
    if (!sample || typeof sample!=='object') fail('Неверная запись сна.');
    const start = instant(sample.start), end = instant(sample.end);
    const duration = Date.parse(end)-Date.parse(start);
    if (duration<0 || duration>(sample.metric==='apnea_event'?90*86400000:48*3600000) || Date.parse(end)>Date.now()+86400000 || Date.parse(start)<Date.parse('2000-01-01')) fail('Неверный период записи сна.');
    const source = shortText(sample.source);
    if (!source.trim()) fail('В записи нет источника.');
    const metric = sample.metric;
    const rawValue = shortText(String(sample.value ?? ''),500), rawUnit = shortText(String(sample.unit ?? ''),50);
    let stage = null, value = null, unit = null;
    if (metric==='sleep') {
      if (!duration) fail('Отрезок сна не может иметь нулевую длительность.');
      const key = rawValue.toLowerCase().replace(/^hkcategoryvaluesleepanalysis/,'').replace(/[()]/g,'').replace(/\s+/g,' ').trim();
      stage = /^\d$/.test(key) ? stages[Number(key)] : aliases.get(key);
      if (!stage) stage = stages.includes(key) ? key : 'unknown';
    } else if (metric==='apnea_event') {
      value=0;unit='event';
    } else {
      value = typeof sample.value==='number' ? sample.value : Number(rawValue.replace(',','.').trim());
      if (!rawValue.trim() || !Number.isFinite(value)) fail('Неверное числовое измерение сна.');
      const u = rawUnit.toLowerCase().replace(/\s/g,'');
      const limits = { heart_rate:[0,300], hrv:[0,5000], respiratory_rate:[0,150], oxygen:[0,100], wrist_temperature:[20,50], breathing_disturbances:[0,1000], sleep_goal:[0,1440] };
      if (!limits[metric]) fail('Неизвестный показатель сна.');
      if (['heart_rate','respiratory_rate'].includes(metric)) {
        if (['count/s','1/s','hz'].includes(u)) value*=60;
        else if (!['count/min','bpm','1/min','уд/мин','вдох/мин','breaths/min','уд./мин','дых./мин'].includes(u)) fail('Неизвестная единица пульса или дыхания.');
        unit='count/min';
      } else if (metric==='hrv') {
        if (['s','sec','с'].includes(u)) value*=1000;
        else if (!['ms','мс'].includes(u)) fail('Неизвестная единица вариабельности пульса.');
        unit='ms';
      } else if (metric==='oxygen') {
        if (['fraction','1'].includes(u)) value*=100;
        else if (u==='%' && value>=0 && value<=1) value*=100;
        else if (u!=='%') fail('Неизвестная единица кислорода.');
        unit='%';
      } else if (metric==='wrist_temperature') {
        if (['degf','°f','f'].includes(u)) value=(value-32)*5/9;
        else if (!['degc','°c','c','°с'].includes(u)) fail('Неизвестная единица температуры.');
        unit='degC';
      } else if (metric==='sleep_goal') {
        if(['hr','h','ч'].includes(u))value*=60;
        else if(['s','sec','с'].includes(u))value/=60;
        else if(!['min','мин'].includes(u))fail('Неизвестная единица цели сна.');
        unit='min';
      } else {
        if (!['count','count/hr','count/h','1/h','событий/ч'].includes(u)) fail('Неизвестная единица нарушений дыхания.');
        unit='count';
      }
      if (value<limits[metric][0] || value>limits[metric][1]) fail('Измерение вне допустимого диапазона.');
    }
    const metadata = sample.metadata ?? {};
    if (!metadata || Array.isArray(metadata) || typeof metadata!=='object' || JSON.stringify(metadata).length>12000) fail('Слишком большие метаданные записи.');
    const row = { metric, start_at:new Date(start).toISOString(), end_at:new Date(end).toISOString(),
      local_start:start, local_end:end, source_name:source, source_version:shortText(sample.sourceVersion ?? '',100),
      device:shortText(sample.device ?? '',2000), stage, value, unit, raw_value:rawValue, raw_unit:rawUnit, metadata };
    // A correction at the same source/interval replaces its former value.
    row.sample_key = await sha256(JSON.stringify([metric,source,row.start_at,row.end_at,stage==='in_bed'?'in_bed':'measurement']));
    records.set(row.sample_key,row);
  }
  return [...records.values()];
}
