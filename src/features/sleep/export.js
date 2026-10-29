// Parse Apple's export on-device in bounded chunks. Unrelated records never
// leave the device. ZIP64/multi-volume files can be extracted in Files first.
const types = {
  HKCategoryTypeIdentifierSleepAnalysis:'sleep', HKQuantityTypeIdentifierHeartRate:'heart_rate',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN:'hrv', HKQuantityTypeIdentifierRespiratoryRate:'respiratory_rate',
  HKQuantityTypeIdentifierOxygenSaturation:'oxygen', HKQuantityTypeIdentifierAppleSleepingWristTemperature:'wrist_temperature',
  HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances:'breathing_disturbances',
  HKDataTypeSleepDurationGoal:'sleep_goal',HKCategoryTypeIdentifierSleepApneaEvent:'apnea_event',
};
const iso = value => value?.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/,'$1T$2$3:$4');
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function checkedZipStream(stream,expectedCRC,expectedSize) {
  let crc=0xffffffff,size=0;
  return stream.pipeThrough(new TransformStream({transform(chunk,controller){
    size+=chunk.length;if(size>expectedSize||size>2*1024*1024*1024)throw new Error('Неверный размер XML в архиве.');
    for(const b of chunk)crc=crcTable[(crc^b)&255]^(crc>>>8);controller.enqueue(chunk);
  },flush(){if(((crc^0xffffffff)>>>0)!==expectedCRC||size!==expectedSize)throw new Error('Архив повреждён. Повтори экспорт из «Здоровья».');}}));
}
export function healthRecord(xml) {
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')) throw new Error('Повреждена запись XML. Повтори экспорт из «Здоровья».');
  const r=doc.documentElement, metric=types[r.getAttribute('type')];
  if(!metric)return null;
  const metadata=Object.fromEntries([...r.querySelectorAll('MetadataEntry')].map(e=>[e.getAttribute('key'),e.getAttribute('value')]));
  if(r.hasAttribute('creationDate'))metadata.creationDate=r.getAttribute('creationDate');
  return {metric,start:iso(r.getAttribute('startDate')),end:iso(r.getAttribute('endDate')),
    value:r.getAttribute('value'),unit:r.getAttribute('unit')||'',source:r.getAttribute('sourceName'),
    sourceVersion:r.getAttribute('sourceVersion')||'',device:r.getAttribute('device')||'',metadata};
}
export async function healthXMLStream(file) {
  if(!file.name.toLowerCase().endsWith('.zip')) return file.stream();
  const tail=new Uint8Array(await file.slice(Math.max(0,file.size-65557)).arrayBuffer());
  const view=new DataView(tail.buffer); let eocd=-1;
  for(let i=tail.length-22;i>=0;i--)if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw new Error('Не удалось открыть ZIP. Распакуй его в «Файлах» и выбери export.xml.');
  const size=view.getUint32(eocd+12,true),offset=view.getUint32(eocd+16,true);
  if(view.getUint16(eocd+4,true)!==0||size===0xffffffff||offset===0xffffffff||size>16*1024*1024)
    throw new Error('Распакуй этот архив в «Файлах» и выбери export.xml.');
  const central=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer()), c=new DataView(central.buffer);
  for(let i=0;i+46<=central.length;) {
    if(c.getUint32(i,true)!==0x02014b50)break;
    const nameLength=c.getUint16(i+28,true),extra=c.getUint16(i+30,true),comment=c.getUint16(i+32,true);
    const name=new TextDecoder().decode(central.slice(i+46,i+46+nameLength));
    if(/(^|\/)export\.xml$/i.test(name)) {
      const method=c.getUint16(i+10,true),compressed=c.getUint32(i+20,true),position=c.getUint32(i+42,true);
      if(c.getUint16(i+8,true)&1 || compressed===0xffffffff || position===0xffffffff || position+compressed>file.size)break;
      const header=new DataView(await file.slice(position,position+30).arrayBuffer());
      if(header.getUint32(0,true)!==0x04034b50)break;
      const begin=position+30+header.getUint16(26,true)+header.getUint16(28,true);
      const stream=file.slice(begin,begin+compressed).stream(),crc=c.getUint32(i+16,true),uncompressed=c.getUint32(i+24,true);
      if(method===0)return checkedZipStream(stream,crc,uncompressed);
      if(method===8){try{return checkedZipStream(stream.pipeThrough(new DecompressionStream('deflate-raw')),crc,uncompressed);}catch{break;}}
      break;
    }
    i+=46+nameLength+extra+comment;
  }
  throw new Error('Распакуй архив в «Файлах» и выбери apple_health_export → export.xml.');
}

export async function* readHealthRecords(stream, signal) {
  const reader=stream.getReader(),decoder=new TextDecoder(); let buffer='',bytes=0,sawRoot=false,sawEnd=false;
  try {
    while(true) {
      signal?.throwIfAborted(); const {done,value}=await reader.read();
      if(done) { buffer+=decoder.decode(); break; }
      bytes+=value.byteLength;
      if(bytes>2*1024*1024*1024)throw new Error('Экспорт больше 2 ГБ. Нужен файл за меньший период.');
      buffer+=decoder.decode(value,{stream:true});
      sawRoot ||= buffer.includes('<HealthData');sawEnd ||= buffer.includes('</HealthData>');
      while(true) {
        const start=buffer.search(/<Record\s/);
        if(start<0){buffer=buffer.slice(-20);break;}
        if(start>0)buffer=buffer.slice(start);
        const header=buffer.indexOf('>'); if(header<0)break;
        const self=buffer[header-1]==='/',end=self?header+1:buffer.indexOf('</Record>')+9;
        if(!self&&end===8)break;
        const record=buffer.slice(0,end);buffer=buffer.slice(end);
        // Avoid parsing thousands of irrelevant dietary/exercise records.
        const type=record.match(/\btype="([^"]+)"/)?.[1];
        if(types[type])yield healthRecord(record);
      }
      if(buffer.length>1000000)throw new Error('Слишком большая или повреждённая запись XML.');
    }
    if(/<Record\s/.test(buffer))throw new Error('Файл XML обрезан. Повтори экспорт.');
    if(!sawRoot||!sawEnd)throw new Error('Нужен полный export.xml из «Здоровья».');
  } finally { await reader.cancel().catch(()=>{}); }
}

export async function importHealthFile(file, upload, progress, signal) {
  let saved=0,batch=[],sleepCount=0;const windows=new Map();
  // Sleep first lets the server retain only measurements overlapping recorded
  // sleep, even if the export lists heart records before sleep records.
  for(const pass of ['sleep','vitals']) {
    const flush=async()=>{if(!batch.length)return;const result=await upload(batch);saved+=result.records;batch=[];progress(saved,pass);};
    for await(const record of readHealthRecords(await healthXMLStream(file),signal)) {
      if((record.metric==='sleep')!==(pass==='sleep'))continue;
      if(record.metric==='sleep') {sleepCount++;if(!windows.has(record.source))windows.set(record.source,[]);windows.get(record.source).push([Date.parse(record.start),Date.parse(record.end)]);}
      else if(!['sleep_goal','apnea_event'].includes(record.metric)) {
        const periods=windows.get(record.source)||[];const start=Date.parse(record.start),end=Date.parse(record.end);
        let lo=0,hi=periods.length;while(lo<hi){const mid=(lo+hi)>>1;if(periods[mid][1]<start)lo=mid+1;else hi=mid;}
        if(!periods[lo]||periods[lo][0]>end)continue;
      }
      batch.push(record);if(batch.length>=500)await flush();
    }
    await flush();
    if(pass==='sleep')for(const [source,periods] of windows){
      const merged=[];for(const p of periods.sort((a,b)=>a[0]-b[0])){const last=merged.at(-1);if(last&&p[0]<=last[1])last[1]=Math.max(last[1],p[1]);else merged.push([...p]);}windows.set(source,merged);
    }
  }
  return {saved,sleepCount};
}
