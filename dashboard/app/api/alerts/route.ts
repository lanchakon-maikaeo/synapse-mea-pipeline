import { publicConfig } from '../../lib';
import { controlledSupabaseOrigin } from '../supabase-server';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store',Vary:'Authorization','X-Content-Type-Options':'nosniff'};
async function handle(request:Request,write:boolean) {
  const authorization=request.headers.get('authorization')??'';
  if(!/^Bearer\s+\S+$/.test(authorization)) return Response.json({error:{message:'กรุณาเข้าสู่ระบบ'}},{status:401,headers});
  const origin=controlledSupabaseOrigin();
  if(!origin) return Response.json({error:{message:'ยังไม่ได้ตั้งค่าฐานข้อมูล'}},{status:503,headers});
  let name='agentic_alert_feed';
  let body:Record<string,unknown>;
  if(write) {
    if(Number(request.headers.get('content-length')??'0')>1024) return new Response(null,{status:413,headers});
    const reader=request.body?.getReader();
    let text='';let bytes=0;
    const decoder=new TextDecoder();
    if(reader)for(;;){const part=await reader.read();if(part.done)break;
      bytes+=part.value.byteLength;if(bytes>1024){await reader.cancel();return new Response(null,{status:413,headers});}
      text+=decoder.decode(part.value,{stream:true});}
    text+=decoder.decode();
    let input;
    try{input=JSON.parse(text);}catch{return new Response(null,{status:422,headers});}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.alert_id!=='string'||!/^[0-9a-f-]{36}$/i.test(input.alert_id)) return new Response(null,{status:422,headers});
    name='agentic_alert_ack';body={p_alert_id:input.alert_id};
  } else {
    const url=new URL(request.url);
    const status=url.searchParams.get('status')??'open';
    const offset=Number(url.searchParams.get('offset')??0);
    if(!['open','acknowledged','resolved'].includes(status)||!Number.isInteger(offset)||offset<0||offset>10000) return new Response(null,{status:422,headers});
    body={p_status:status,p_offset:offset};
  }
  try {
    const response=await fetch(`${origin}/rest/v1/rpc/${name}`,{method:'POST',headers:{Authorization:authorization,
      apikey:publicConfig.supabaseAnonKey,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok) {await response.body?.cancel();return Response.json({error:{message:'ไม่สามารถอ่านหรือรับทราบแจ้งเตือนได้'}},{status:response.status===401?401:response.status===403?403:503,headers});}
    return Response.json(write?{status:'acknowledged'}:await response.json(),{headers});
  } catch {return Response.json({error:{message:'บริการแจ้งเตือนขัดข้อง กรุณาลองใหม่'}},{status:503,headers});}
}
export async function GET(request:Request){return handle(request,false);}
export async function POST(request:Request){return handle(request,true);}
