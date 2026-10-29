import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createSleepHandler } from './handler.js';
const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createSleepHandler({rpc:(name:string,args:Record<string,unknown>)=>client.rpc(name,args),getUser:(jwt:string)=>client.auth.getUser(jwt)}));
