'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X, RefreshCw, Sparkles, ArrowUpRight } from 'lucide-react';
import { createPortal } from 'react-dom';
import { formatDateTime, type Role } from './lib';
import { nextUrgentAlert } from './agentic-alerts.mjs';
type Alert={alert_id:string;alert_type:string;severity:string;status:string;message:string;created_at:string;details:{
 material_id?:string;district_id?:string;location_id?:string;scope?:string;target?:string;action?:string;analysis_status?:string;analysis?:{summary:string;actions:string[];uncertainties:string[];evidence_ids:string[]};
 evidence?:Record<string,unknown>;limitations?:string[];analyzed_at?:string;fingerprint?:string}};
type Feed={open_count:number;alerts:Alert[];last_run?:{status:string;finished_at?:string};schedule:string};
const evidenceLabels:Record<string,string>={material_id:'รหัสวัสดุ',district_id:'รหัสเขต',location_id:'รหัสคลัง',snapshot_at:'เวลาของข้อมูลสต็อก',usage_as_of_date:'วันที่อัตราใช้',stock_qty:'สต็อกตามหลักฐาน',cmp_monthly:'อัตราใช้ต่อเดือน',months_available:'จำนวนเดือนที่คาดว่าพอใช้',target_gap_qty:'ส่วนต่างถึงเป้าหมายเติม',required_qty:'จำนวนที่แผนต้องการ',allocatable_qty:'ยอดพร้อมจัดสรร',shortfall_qty:'ส่วนขาดเทียบแผน',incomplete:'ข้อมูลยังไม่ครบ',count:'จำนวนรายการที่ต้องตรวจ',material_ids:'ตัวอย่างรหัสวัสดุ',oldest_snapshot:'ข้อมูลสต็อกเก่าสุด',stale:'ข้อมูลเก่า',plan_number:'เลขแผน',plan_id:'รหัสแผน',plan_ids:'แผนที่เกี่ยวข้อง',plan_status:'สถานะแผน',response_due_at:'กำหนดตอบแผน',item_count:'จำนวนรายการในแผน',items:'รายการแผนตามหลักฐาน',truncated:'แสดงรายการเพียงบางส่วน',priority:'คะแนนลำดับงานเดิม',needs_data_check:'ต้องตรวจข้อมูลต้นทาง',policy:'เกณฑ์เติมที่ใช้งาน',action:'สิ่งที่ควรทำ',district_name:'ชื่อเขต',name:'ชื่อคลัง',basis:'ฐานการเปรียบเทียบ'};
const identity=(alert:Alert)=>[alert.details.location_id&&`คลัง ${alert.details.location_id}`,alert.details.district_id&&`เขต ${alert.details.district_id}`,alert.details.material_id&&`วัสดุ ${alert.details.material_id}`,alert.details.evidence?.plan_number&&`แผน ${alert.details.evidence.plan_number}`].filter(Boolean).join(' · ');
export default function AlertPanel({token,role,onNavigate,onAsk,demo=false}:{token:string|null;role:Role;
 onNavigate:(target:string)=>void;onAsk:(question:string)=>void;demo?:boolean}) {
 const [open,setOpen]=useState(false),[status,setStatus]=useState('open'),[feed,setFeed]=useState<Feed|null>(null);
 const [peek,setPeek]=useState<Alert|null>(null);
 const shown=useRef(new Set<string>());
 const [offset,setOffset]=useState(0),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const button=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const sequence=useRef(0);
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  if(!token||demo||signal?.aborted)return;
  const current=++sequence.current;setLoading(true);setError('');
  try {const response=await fetch(`/api/alerts?status=${status}&offset=${offset}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal});
   if(!response.ok)throw Error('อ่านแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่');
   const data=await response.json();if(!signal?.aborted&&current===sequence.current){setFeed(data);
    if(status==='open'){const urgent=nextUrgentAlert(data.alerts,shown.current);
     if(urgent){const key=`${urgent.alert_id}:${urgent.details.fingerprint??urgent.created_at}`;
      if(!shown.current.has(key)){shown.current.add(key);setPeek(urgent);}}else setPeek(current=>data.alerts.some((a:Alert)=>a.alert_id===current?.alert_id&&a.severity==='critical')?current:null);}
   }
  } catch(e){if(!signal?.aborted&&current===sequence.current)setError(e instanceof Error?e.message:'บริการแจ้งเตือนขัดข้อง');}
  finally{if(!signal?.aborted&&current===sequence.current)setLoading(false);}
 },[token,status,offset,demo]);
 useEffect(()=>{const controller=new AbortController();queueMicrotask(()=>void refresh(controller.signal));
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(controller.signal);},60000);
  return()=>{controller.abort();clearInterval(timer);};},[refresh]);
 useEffect(()=>{if(!open)return;panel.current?.focus();
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus();}
   if(event.key==='Tab'&&panel.current){const elements=Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),summary,[tabindex="0"]'));
    const first=elements[0],last=elements.at(-1);if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.current)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
  document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);
 },[open]);
 const acknowledge=async(id:string)=>{setError('');try{
  const response=await fetch('/api/alerts',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({alert_id:id})});
  if(!response.ok)throw Error('รับทราบไม่สำเร็จ');setPeek(null);await refresh();
 }catch(e){setError(e instanceof Error?e.message:'รับทราบไม่สำเร็จ');}};
 return <>
  <button ref={button} type="button" onClick={()=>{setOpen(true);setPeek(null);void refresh();}} aria-label={`แจ้งเตือน ${feed?.open_count??0} รายการ`} aria-expanded={open}
   className="relative flex size-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
   <Bell className="size-4"/>{!!feed?.open_count&&<span className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[10px] text-white">{feed.open_count>9?'9+':feed.open_count}</span>}
  </button>
  {peek&&!open&&createPortal(<aside className="agent-notice" role="status" aria-live="polite">
   <div className="flex items-center gap-3"><span className="agent-assistant-icon"><Sparkles size={21}/></span><div className="flex-1"><strong>มีเรื่องสำคัญที่ควรดู</strong><p className="text-sm text-muted-foreground">SYNAPSE · ผู้ช่วยส่วนตัว</p></div><button type="button" aria-label="ย่อคำแนะนำสำคัญ" onClick={()=>setPeek(null)}><X size={20}/></button></div>
   <h3 className="mt-4 text-lg font-semibold leading-relaxed">{peek.message}</h3><p className="mt-2 text-sm text-muted-foreground">{identity(peek)}</p>
   <p className="mt-3 text-base leading-relaxed">{peek.details.analysis?.summary??peek.details.action}</p>
   <button type="button" className="mt-5 flex w-full items-center justify-between rounded-2xl bg-primary px-4 py-3 font-medium text-white" onClick={()=>{setStatus('open');setOffset(0);setOpen(true);setPeek(null);void refresh();}}>ดูคำแนะนำและสิ่งที่ควรทำ<ArrowUpRight size={20}/></button>
  </aside>,document.body)}
  {open&&createPortal(<div className="fixed inset-0 z-[1700] bg-slate-950/20 backdrop-blur-sm" onClick={()=>{setOpen(false);button.current?.focus();}}>
   <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="งานวันนี้และแจ้งเตือน" onClick={e=>e.stopPropagation()}
    className="agent-assistant-panel absolute right-0 top-0 flex h-dvh w-full max-w-[600px] flex-col overflow-hidden bg-background shadow-2xl sm:right-4 sm:top-4 sm:h-[calc(100dvh-2rem)] sm:rounded-[28px] sm:border sm:border-white/80">
    <header className="flex items-center gap-3 border-b border-border bg-gradient-to-br from-blue-50 to-background p-5"><span className="agent-assistant-icon"><Sparkles size={24}/></span><div className="flex-1"><p className="mb-1 text-sm font-medium text-primary">SYNAPSE · ผู้ช่วยส่วนตัว</p><h2 className="text-xl font-semibold tracking-tight">วันนี้ควรทำอะไร</h2>
     <p className="mt-1 text-sm text-muted-foreground">สรุปทุกวัน 07:30 · เวลาไทย</p></div>
     <button type="button" onClick={()=>void refresh()} aria-label="โหลดแจ้งเตือนล่าสุด" disabled={loading}><RefreshCw className={`size-4 ${loading?'animate-spin':''}`}/></button>
     <button type="button" aria-label="ปิดแจ้งเตือน" onClick={()=>{setOpen(false);button.current?.focus();}}><X className="size-5"/></button></header>
    <div className="mx-5 my-4 flex gap-1 rounded-2xl bg-muted p-1.5">{[['open','งานวันนี้'],['acknowledged','รับทราบแล้ว'],['resolved','ประวัติ']].map(([key,label])=>
     <button type="button" key={key} aria-pressed={status===key} onClick={()=>{setStatus(key);setOffset(0);setFeed(null);}}
      className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${status===key?'bg-card text-primary shadow-sm':'text-muted-foreground hover:text-foreground'}`}>{label}</button>)}</div>
    <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-5">
     {demo&&<p className="text-sm">โหมดทดลองยังไม่มีคำแนะนำจากข้อมูลจริง</p>}
     {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
     {feed?.last_run&&<p className="text-xs text-muted-foreground">ประเมินล่าสุด {formatDateTime(feed.last_run.finished_at)} · {feed.last_run.status==='succeeded'?'สำเร็จ':'ยังไม่สำเร็จ'}</p>}
     {!demo&&!feed&&loading&&<p className="text-sm">กำลังโหลด…</p>}
     {feed?.alerts.length===0&&<p className="py-8 text-center text-sm text-muted-foreground">ไม่มีรายการในสถานะนี้</p>}
     {feed?.alerts.map(alert=><article key={alert.alert_id} className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2 text-xs"><span className={alert.severity==='critical'?'text-red-600':alert.severity==='warning'?'text-amber-600':'text-muted-foreground'}>{alert.severity==='critical'?'เร่งด่วน':alert.severity==='warning'?'ควรตรวจสอบ':'งานที่ควรจัดการ'}</span>
       <span className="text-muted-foreground">{alert.details.scope==='warehouse'?'คลังส่วนกลาง':alert.details.scope==='district'?'คลังประจำเขต':'ระบบ/แผนงาน'}</span></div>
      <h3 className="text-lg font-semibold leading-relaxed">{alert.message}</h3>
      {identity(alert)&&<p className="break-words text-xs text-muted-foreground">{identity(alert)}</p>}
      <p className="text-base leading-relaxed">{alert.details.action??alert.message}</p>
      {alert.details.analysis&&<><p className="text-base leading-relaxed text-muted-foreground">{alert.details.analysis.summary}</p>
       <ul className="list-disc space-y-2 pl-5 text-base leading-relaxed">{alert.details.analysis.actions.map((a,i)=><li key={i}>{a}</li>)}</ul></>}
      {alert.alert_type==='agentic'&&alert.details.analysis_status!=='analyzed'&&<p className="text-xs text-muted-foreground">คำแนะนำจากหลักฐาน · Agent ยังไม่ได้วิเคราะห์เพิ่มเติม</p>}
      {[...(alert.details.limitations??[]),...(alert.details.analysis?.uncertainties??[])].map((x,i)=><p key={i} className="text-xs text-muted-foreground">{x}</p>)}
      <details><summary className="cursor-pointer rounded-xl bg-muted px-3 py-2.5 text-sm font-medium text-primary">ดูหลักฐานและเวลาของข้อมูล</summary>
       <dl className="mt-2 space-y-1 break-words text-xs">{Object.entries(alert.details.evidence??{}).map(([key,value])=>
        <div key={key}><dt className="font-medium">{evidenceLabels[key]??key}</dt><dd className="whitespace-pre-wrap text-muted-foreground">{value==null?'ไม่ทราบ':typeof value==='object'?JSON.stringify(value,null,2):typeof value==='boolean'?value?'ใช่':'ไม่':String(value??'ไม่ทราบ')}</dd></div>)}</dl></details>
      <div className="flex flex-wrap gap-2 text-sm">
       {status==='open'&&role!=='viewer'&&<button type="button" className="rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-muted" onClick={()=>void acknowledge(alert.alert_id)}>รับทราบ</button>}
       <button type="button" className="rounded-xl bg-primary px-3 py-2.5 text-white" onClick={()=>{onNavigate(alert.details.target??'operations');setOpen(false);}}>เปิดข้อมูลต้นทาง</button>
       <button type="button" className="rounded-xl border border-border px-3 py-2.5 transition-colors hover:bg-muted" onClick={()=>{onAsk(`ตรวจข้อมูลล่าสุดเกี่ยวกับ ${alert.message} (${identity(alert)}) และแนะนำสิ่งที่ควรทำ พร้อมหลักฐาน`);setOpen(false);}}>ถาม Agent ต่อ</button>
      </div>
     </article>)}
    </div>
    <footer className="flex justify-between border-t border-border p-3 text-xs"><button type="button" disabled={offset===0||loading} onClick={()=>setOffset(Math.max(0,offset-30))}>ก่อนหน้า</button>
     <span>รายการ {feed?.alerts.length?offset+1:0}–{offset+(feed?.alerts.length??0)}</span><button type="button" disabled={!feed||feed.alerts.length<30||loading} onClick={()=>setOffset(offset+30)}>ถัดไป</button></footer>
   </div>
  </div>,document.body)}
 </>;
}
