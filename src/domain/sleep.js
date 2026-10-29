// Keep the original samples. These summaries are a view, never a replacement
// for the intervals and individual measurements supplied by Health.
export const SLEEP_STAGES = {
  awake: 'Бодрствование', rem: 'REM', core: 'Базовый', deep: 'Глубокий',
  asleep: 'Сон без стадии', in_bed: 'В постели', unknown: 'Неизвестная стадия',
};
export const SLEEP_METRICS = {
  heart_rate: ['Пульс во сне', 'уд/мин'], hrv: ['Вариабельность пульса · SDNN', 'мс'],
  respiratory_rate: ['Частота дыхания', 'вдох/мин'], oxygen: ['Кислород в крови', '%'],
  wrist_temperature: ['Температура запястья', '°C'], breathing_disturbances: ['Нарушения дыхания · показатель Apple', ''],
};
export const isWatch = source => /watch|часы/iu.test(source || '');
export const sleepSourceLabel = source => source || 'Источник не передан';
const asleep = stage => ['core', 'deep', 'rem', 'asleep'].includes(stage);
const stamp = value => new Date(value).getTime();
const minutes = (a, b) => (b - a) / 60000;

// Sweep overlapping intervals. In-bed and unspecified sleep are envelopes,
// not extra hours. Contradictory detailed stages remain visibly unknown.
export function sleepTimeline(samples) {
  const rows = samples.filter(s => s.metric === 'sleep' && s.stage !== 'in_bed')
    .map(s => ({ ...s, a: stamp(s.start_at), b: stamp(s.end_at) }));
  const edges = [...new Set(rows.flatMap(s => [s.a, s.b]))].sort((a,b) => a-b);
  const result = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i+1];
    const active = [...new Set(rows.filter(s => s.a < b && s.b > a).map(s => s.stage))];
    if (!active.length) continue;
    const detailed = active.filter(s => s !== 'asleep');
    const stage = detailed.length > 1 ? 'unknown' : detailed[0] || 'asleep';
    const previous = result.at(-1);
    if (previous?.stage === stage && previous.end === a) previous.end = b;
    else result.push({ start: a, end: b, stage });
  }
  return result;
}

function unionDuration(rows) {
  const sorted = rows.map(s => [stamp(s.start_at), stamp(s.end_at)]).sort((a,b) => a[0]-b[0]);
  let total = 0, end = -Infinity;
  for (const [a,b] of sorted) { total += Math.max(0, b-Math.max(a,end)); end = Math.max(end,b); }
  return total / 60000;
}

export function summarizeSleep(samples, preferredSource = null) {
  const sources = [...new Set(samples.filter(s => s.metric === 'sleep').map(s => s.source_name))];
  // Keep sources separate. A user can inspect any other source explicitly.
  const source = sources.includes(preferredSource) ? preferredSource : sources.sort((a,b) =>
    Number(Boolean(b))-Number(Boolean(a)) || Number(isWatch(b))-Number(isWatch(a)) ||
    Math.max(...samples.filter(s=>s.metric==='sleep'&&s.source_name===b).map(s=>stamp(s.end_at))) -
    Math.max(...samples.filter(s=>s.metric==='sleep'&&s.source_name===a).map(s=>stamp(s.end_at))) || a.localeCompare(b))[0];
  const sleep = samples.filter(s => s.metric === 'sleep' && s.source_name === source)
    .sort((a,b) => stamp(a.start_at)-stamp(b.start_at));
  const groups = [];
  // A gap over 90 minutes separates episodes, including daytime naps.
  for (const sample of sleep.filter(s => s.stage !== 'in_bed')) {
    const last = groups.at(-1), a = stamp(sample.start_at), b = stamp(sample.end_at);
    if (!last || a > last.end + 90*60000) groups.push({ rows: [sample], end: b });
    else { last.rows.push(sample); last.end = Math.max(last.end,b); }
  }
  for(const bed of sleep.filter(s=>s.stage==='in_bed')) {
    if(!groups.some(g=>g.rows.some(s=>stamp(s.start_at)<stamp(bed.end_at)&&stamp(s.end_at)>stamp(bed.start_at))))groups.push({rows:[bed],end:stamp(bed.end_at)});
  }
  const episodes = groups.map(group => {
    const timeline = sleepTimeline(group.rows);
    if(!timeline.length)timeline.push({start:stamp(group.rows[0].start_at),end:group.end,stage:'in_bed'});
    const sleeping = timeline.filter(s => asleep(s.stage));
    const first = sleeping[0]?.start ?? timeline[0].start, last = sleeping.at(-1)?.end ?? timeline.at(-1).end;
    const stageMinutes = Object.fromEntries(Object.keys(SLEEP_STAGES).map(s => [s,0]));
    for (const s of timeline) stageMinutes[s.stage] += minutes(s.start,s.end);
    const total = sleeping.reduce((sum,s) => sum+minutes(s.start,s.end),0);
    const bed = sleep.filter(s => s.stage==='in_bed' && stamp(s.start_at)<=first && stamp(s.end_at)>=last);
    const bedMinutes = bed.length ? unionDuration(bed) : null;
    const wakeSample = group.rows.reduce((a,b) => stamp(a.end_at)>stamp(b.end_at)?a:b);
    const day = wakeSample.local_end.slice(0,10);
    const measurements = samples.filter(s => s.metric !== 'sleep' && s.source_name === source &&
      sleeping.some(p => stamp(s.start_at) <= p.end && stamp(s.end_at) >= p.start));
    const vitals = {};
    for (const metric of Object.keys(SLEEP_METRICS)) {
      // Unknown origins cannot establish that sleep and vitals share a device.
      // Retain their raw measurements, but do not present a blended average.
      const values = source ? measurements.filter(s => s.metric===metric && s.value!=null).map(s => Number(s.value)) : [];
      vitals[metric] = values.length ? { count: values.length, min: Math.min(...values), max: Math.max(...values),
        mean: values.reduce((a,b)=>a+b,0)/values.length } : null;
    }
    const firstSample = group.rows.find(s=>stamp(s.start_at)===first);
    const lastSample = group.rows.find(s=>stamp(s.end_at)===last);
    return { day, source, start: first, end: last, localStart: firstSample?.local_start,
      localEnd: lastSample?.local_end, timeline, stageMinutes, asleepMinutes: sleeping.length ? total : null,
      inBedMinutes: bedMinutes, efficiency: bedMinutes && sleeping.length ? Math.min(100,total/bedMinutes*100) : null,
      latencyMinutes: bed.length && sleeping.length ? minutes(Math.min(...bed.map(s=>stamp(s.start_at))),first) : null,
      awakenings: sleeping.length?timeline.filter(s=>s.stage==='awake' && s.start>=first && s.end<=last).length:null,
      awakeMinutes: sleeping.length?timeline.filter(s=>s.stage==='awake' && s.start>=first && s.end<=last).reduce((n,s)=>n+minutes(s.start,s.end),0):null,
      unobservedMinutes: minutes(first,last)-timeline.filter(s=>s.start<last&&s.end>first)
        .reduce((n,s)=>n+minutes(Math.max(first,s.start),Math.min(last,s.end)),0),
      vitals, samples: [...new Map([...group.rows,...bed,...measurements].map(s=>[s.sample_key,s])).values()],
    };
  }).sort((a,b)=>b.end-a.end);
  return { sources, source, episodes };
}
