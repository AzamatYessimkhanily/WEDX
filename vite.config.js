import { defineConfig, loadEnv } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = env.VITE_BASE_PATH || '/';
  return { base, build: { target: 'safari16', rollupOptions: { input: { main: 'index.html', coach: 'coach.html' } } }, plugins: [{
    name: 'wedx-offline',
    generateBundle(_options, bundle) {
      const files = [...new Set([...Object.keys(bundle), 'index.html', 'manifest.webmanifest', 'icon-180.png'])];
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const BASE=${JSON.stringify(base)}, PREFIX='wedx:'+BASE+':', CACHE=PREFIX+'${version}', FILES=${JSON.stringify(files.map(f => base + f))};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(BASE))return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).catch(()=>caches.match(BASE+'index.html',{ignoreVary:true})));
  }else if(FILES.includes(url.pathname)){
    event.respondWith(caches.match(url.pathname,{ignoreVary:true}).then(cached=>cached||fetch(event.request)));
  }
});
${readFileSync(new URL('./src/service-worker.js', import.meta.url), 'utf8')}
` });
    },
  }] };
});
