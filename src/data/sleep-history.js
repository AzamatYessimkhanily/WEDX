export async function loadSleepHistory(client, owner, month, signal) {
  const [year,m]=month.split('-').map(Number);
  // Two days of margin retain an episode crossing the month boundary and time zones.
  const from=new Date(Date.UTC(year,m-1,-1)).toISOString(),to=new Date(Date.UTC(year,m,3)).toISOString();
  const rows=[];
  for(let offset=0;;offset+=500) {
    signal.throwIfAborted();
    const {data,error}=await client.from('sleep_samples').select('*').eq('user_id',owner)
      .gte('start_at',from).lt('start_at',to).order('start_at',{ascending:true}).order('sample_key',{ascending:true})
      .range(offset,offset+499).abortSignal(signal);
    if(error)throw error;
    rows.push(...data);if(data.length<500)return rows;
  }
}
