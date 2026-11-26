import { timingSafeEqual } from 'node:crypto';
import { controlledSupabaseOrigin } from "../../route-helpers";
import { embedMaterialNames } from '../../material-embeddings.mjs';
import { embedTexts } from '../../chat/embedding.mjs';
import { cloudflareConfig } from '../../chat/openrouter.mjs';
export const dynamic='force-dynamic';
export const maxDuration=120;
// Called daily by pg_cron + pg_net (ops.invoke_material_embeddings) with the agentic alerts cron secret.
export async function GET(request:Request) {
 const expected=process.env.AGENTIC_ALERT_CRON_SECRET?.trim();
 const supplied=request.headers.get('authorization')??'';
 const target=`Bearer ${expected}`;
 if(!expected||Buffer.byteLength(supplied)!==Buffer.byteLength(target)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(target))) return new Response(null,{status:401});
 const origin=controlledSupabaseOrigin();
 const key=process.env.AGENTIC_ALERT_SERVICE_KEY?.trim()||process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
 const cloudflare=cloudflareConfig();
 if(!origin||!key||!cloudflare) return Response.json({status:'not_configured'},{status:503});
 const rpc=async(name:string,body:unknown)=>{
   const response=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,apikey:key,'Content-Type':'application/json'},
     body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});
   if(!response.ok) {await response.body?.cancel();throw Error('embedding_rpc_unavailable');}
   return response.json();
 };
 try {
  const result=await embedMaterialNames({rpc,signal:AbortSignal.timeout(90000),
    embed:(texts:string[],signal:AbortSignal)=>embedTexts({texts,...cloudflare,signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])})});
  console.info(JSON.stringify({event:'material_embedding_run',...result}));
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 } catch(error) {
  const code=error instanceof Error&&/^[a-z_]{3,60}$/.test(error.message)?error.message:'embedding_unavailable';
  console.error(JSON.stringify({event:'material_embedding_run',status:'failed',code}));
  return Response.json({status:'failed',code},{status:503});
 }
}
