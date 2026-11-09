import { timingSafeEqual } from 'node:crypto';
import { controlledSupabaseOrigin } from "../../route-helpers";
import { runAlertWorker } from '../../agentic-alert-worker.mjs';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request) {
 const expected=process.env.CRON_SECRET?.trim();
 const supplied=request.headers.get('authorization')??'';
 const target=`Bearer ${expected}`;
 if(!expected||Buffer.byteLength(supplied)!==Buffer.byteLength(target)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(target))) return new Response(null,{status:401});
 const origin=controlledSupabaseOrigin();
 const key=process.env.AGENTIC_ALERT_SERVICE_KEY?.trim();
 if(!origin||!key) return Response.json({status:'not_configured'},{status:503});
 const rpc=async(name:string,body:unknown)=>{
   const response=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,apikey:key,'Content-Type':'application/json'},
     body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
   if(!response.ok) {await response.body?.cancel();throw Error('alert_rpc_unavailable');}
   return response.json();
 };
 try {
  const result=await runAlertWorker({rpc,signal:AbortSignal.timeout(75000)});
  console.info(JSON.stringify({event:'agentic_alert_run',...result}));
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 } catch {console.error(JSON.stringify({event:'agentic_alert_run',status:'failed',code:'worker_unavailable'}));return Response.json({status:'failed'},{status:503});}
}
