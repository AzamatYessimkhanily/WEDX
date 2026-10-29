import { normalizeSleep, sha256, SleepImportError } from './validation.js';
const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Cache-Control':'no-store' };
const reply = (body,status=200) => Response.json(body,{status,headers:cors});
export function createSleepHandler({rpc, getUser, reportError = event => console.warn(JSON.stringify(event))}) {
  return async request => {
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    if (request.method!=='POST') return reply({message:'Нужен POST-запрос.'},405);
    const credential = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!credential) return reply({message:'Нужен ключ WEDX.'},401);
    const isToken = /^wedx_[a-f0-9]{64}$/.test(credential);
    let owner = null;
    if (!isToken) {
      try { const result=await getUser(credential);owner=result?.data?.user?.id; } catch {return reply({message:'Не удалось проверить подключение. Повтори позже.'},503);}
      if(!owner)return reply({message:'Подключение истекло. Открой WEDX заново.'},401);
    }
    if (!request.headers.get('Content-Type')?.includes('application/json')) return reply({message:'Нужен JSON.'},415);
    try {
      const reader=request.body?.getReader(); if(!reader) return reply({message:'Пустой запрос сна.'},400);
      const decoder=new TextDecoder(); let body='', size=0;
      while(true) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength;
        if(size>8*1024*1024) { await reader.cancel(); return reply({message:'Слишком много данных. Сократи период импорта.'},413); }
        body+=decoder.decode(value,{stream:true}); }
      body+=decoder.decode();
      const samples=await normalizeSleep(JSON.parse(body));
      const {data,error}=await rpc('ingest_sleep',{p_token_hash:isToken?await sha256(credential):null,p_owner:owner,p_samples:samples});
      if(error) return reply({message:error.code==='28000'?'Ключ сна неверен или отключён.':error.code==='P0001'?'Слишком частые запуски. Повтори через минуту.':'Сон не сохранён. Повтори импорт позже.'},error.code==='28000'?401:error.code==='P0001'?429:503);
      const missingSource=samples.filter(s=>!s.source_name).length;
      return reply({...data,message:samples.length?`Сон: сохранено записей ${data.records}.${missingSource?' Часть записей пришла без источника и хранится отдельно.':''} Открой раздел «Сон» в WEDX.`:'Новых записей сна нет. Проверь разрешения «Здоровья» и синхронизацию часов. История сохранена.'});
    } catch(error) {
      // Only our static validation reasons are logged: no payload, health values,
      // credentials or native JSON.parse errors (which can contain body excerpts).
      reportError({event:'sleep_import_rejected',code:error instanceof SleepImportError?'validation':error instanceof SyntaxError?'invalid_json':'internal',
        reason:error instanceof SleepImportError?error.message:undefined});
      return reply({message:error instanceof SleepImportError?error.message:error instanceof SyntaxError?'Неверный JSON сна. Обнови команду.':'Сон не сохранён. Повтори позже.'},error instanceof SleepImportError||error instanceof SyntaxError?400:503);
    }
  };
}
