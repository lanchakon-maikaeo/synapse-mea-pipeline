'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDateTime, type Role } from './lib';
import { nextUrgentAlert } from './agentic-alerts.mjs';
type Alert={alert_id:string;alert_type:string;severity:string;status:string;message:string;created_at:string;details:{
 material_id?:string;district_id?:string;location_id?:string;scope?:string;target?:string;action?:string;analysis_status?:string;analysis?:{summary:string;actions:string[];uncertainties:string[];evidence_ids:string[]};
 evidence?:Record<string,unknown>;limitations?:string[];analyzed_at?:string;fingerprint?:string}};
type Feed={open_count:number;alerts:Alert[];last_run?:{status:string;finished_at?:string};schedule:string};
const evidenceLabels:Record<string,string>={material_id:'รหัสวัสดุ',district_id:'รหัสเขต',location_id:'รหัสคลัง',snapshot_at:'เวลาของข้อมูลสต็อก',usage_as_of_date:'วันที่อัตราใช้',stock_qty:'สต็อกตามหลักฐาน',cmp_monthly:'อัตราใช้ต่อเดือน',months_available:'จำนวนเดือนที่คาดว่าพอใช้',target_gap_qty:'ส่วนต่างถึงเป้าหมายเติม',required_qty:'จำนวนที่แผนต้องการ',allocatable_qty:'ยอดพร้อมจัดสรร',shortfall_qty:'ส่วนขาดเทียบแผน',incomplete:'ข้อมูลยังไม่ครบ',count:'จำนวนรายการที่ต้องตรวจ',material_ids:'ตัวอย่างรหัสวัสดุ',oldest_snapshot:'ข้อมูลสต็อกเก่าสุด',stale:'ข้อมูลเก่า',plan_number:'เลขแผน',plan_id:'รหัสแผน',plan_ids:'แผนที่เกี่ยวข้อง',plan_status:'สถานะแผน',response_due_at:'กำหนดตอบแผน',item_count:'จำนวนรายการในแผน',items:'รายการแผนตามหลักฐาน',truncated:'แสดงรายการเพียงบางส่วน',priority:'คะแนนลำดับงานเดิม',needs_data_check:'ต้องตรวจข้อมูลต้นทาง',policy:'เกณฑ์เติมที่ใช้งาน',action:'สิ่งที่ควรทำ',district_name:'ชื่อเขต',name:'ชื่อคลัง',basis:'ฐานการเปรียบเทียบ'};
const severityLabel=(severity:string)=>severity==='critical'?'เร่งด่วน':severity==='warning'?'ควรตรวจสอบ':'งานที่ควรจัดการ';
const scopeLabel=(scope?:string)=>scope==='warehouse'?'คลังส่วนกลาง':scope==='district'?'คลังประจำเขต':'ระบบ/แผนงาน';
const evidenceValue=(value:unknown)=>value==null?'ไม่ทราบ':typeof value==='object'?JSON.stringify(value,null,2):typeof value==='boolean'?value?'ใช่':'ไม่':String(value);
const identity=(alert:Alert)=>[alert.details.location_id&&`คลัง ${alert.details.location_id}`,alert.details.district_id&&`เขต ${alert.details.district_id}`,alert.details.material_id&&`วัสดุ ${alert.details.material_id}`,alert.details.evidence?.plan_number&&`แผน ${alert.details.evidence.plan_number}`].filter(Boolean).join(' · ');
export default function AlertPanel({token,role,onNavigate,onAsk,demo=false}:{token:string|null;role:Role;
 onNavigate:(target:string)=>void;onAsk:(question:string)=>void;demo?:boolean}) {
 const [open,setOpen]=useState(false),[status,setStatus]=useState('open'),[feed,setFeed]=useState<Feed|null>(null);
 const [openCount,setOpenCount]=useState(0);
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
   const data=await response.json();if(!signal?.aborted&&current===sequence.current){setFeed(data);setOpenCount(data.open_count);
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
 const close=()=>{setOpen(false);button.current?.focus();};
 return <>
  <button ref={button} type="button" className="notification" onClick={()=>{setOpen(true);setPeek(null);void refresh();}} aria-label={`แจ้งเตือน ${openCount} รายการ`} aria-expanded={open}>
   <span aria-hidden="true">🔔</span>{!!openCount&&<b>{openCount>9?'9+':openCount}</b>}
  </button>
  {peek&&!open&&createPortal(<aside className="agent-notice" role="status" aria-live="polite">
   <div className="alert-notice-head"><span className="agent-assistant-icon" aria-hidden="true">✦</span><div><strong>มีเรื่องสำคัญที่ควรดู</strong><small>SYNAPSE · ผู้ช่วยส่วนตัว</small></div><button type="button" aria-label="ย่อคำแนะนำสำคัญ" onClick={()=>setPeek(null)}>×</button></div>
   <h3>{peek.message}</h3><small>{identity(peek)}</small>
   <p>{peek.details.analysis?.summary??peek.details.action}</p>
   <button type="button" className="btn primary" onClick={()=>{setStatus('open');setOffset(0);setOpen(true);setPeek(null);void refresh();}}>ดูคำแนะนำและสิ่งที่ควรทำ ↗</button>
  </aside>,document.body)}
  {open&&createPortal(<div className="alert-backdrop" onClick={close}>
   <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="งานวันนี้และแจ้งเตือน" onClick={e=>e.stopPropagation()} className="agent-assistant-panel alert-panel">
    <header><span className="agent-assistant-icon" aria-hidden="true">✦</span><div><small>SYNAPSE · ผู้ช่วยส่วนตัว</small><h2>วันนี้ควรทำอะไร</h2><small>สรุปทุกวัน 07:30 · เวลาไทย</small></div>
     <button type="button" onClick={()=>void refresh()} aria-label="โหลดแจ้งเตือนล่าสุด" disabled={loading}>↻</button>
     <button type="button" aria-label="ปิดแจ้งเตือน" onClick={close}>×</button></header>
    <div className="alert-tabs">{[['open','งานวันนี้'],['acknowledged','รับทราบแล้ว'],['resolved','ประวัติ']].map(([key,label])=>
     <button type="button" key={key} aria-pressed={status===key} onClick={()=>{setStatus(key);setOffset(0);setFeed(null);}}>{label}</button>)}</div>
    <div className="alert-list">
     {demo&&<p>โหมดทดลองยังไม่มีคำแนะนำจากข้อมูลจริง</p>}
     {error&&<p role="alert" className="alert-error">{error}</p>}
     {feed?.last_run&&<small>ประเมินล่าสุด {formatDateTime(feed.last_run.finished_at)} · {feed.last_run.status==='succeeded'?'สำเร็จ':'ยังไม่สำเร็จ'}</small>}
     {!demo&&!feed&&loading&&<p>กำลังโหลด…</p>}
     {feed?.alerts.length===0&&<p className="alert-empty">ไม่มีรายการในสถานะนี้</p>}
     {feed?.alerts.map(alert=><article key={alert.alert_id} className={`alert-card ${alert.severity}`}>
      <div className="alert-card-tags"><b>{severityLabel(alert.severity)}</b><span>{scopeLabel(alert.details.scope)}</span></div>
      <h3>{alert.message}</h3>
      {identity(alert)&&<small>{identity(alert)}</small>}
      <p>{alert.details.action??alert.message}</p>
      {alert.details.analysis&&<><p className="alert-muted">{alert.details.analysis.summary}</p>
       <ul>{alert.details.analysis.actions.map((a,i)=><li key={i}>{a}</li>)}</ul></>}
      {alert.alert_type==='agentic'&&alert.details.analysis_status!=='analyzed'&&<small>คำแนะนำจากหลักฐาน · Agent ยังไม่ได้วิเคราะห์เพิ่มเติม</small>}
      {[...(alert.details.limitations??[]),...(alert.details.analysis?.uncertainties??[])].map((x,i)=><small key={i}>{x}</small>)}
      <details><summary>ดูหลักฐานและเวลาของข้อมูล</summary>
       <dl>{Object.entries(alert.details.evidence??{}).map(([key,value])=>
        <div key={key}><dt>{evidenceLabels[key]??key}</dt><dd>{evidenceValue(value)}</dd></div>)}</dl></details>
      <div className="alert-actions">
       {status==='open'&&role!=='viewer'&&<button type="button" className="btn" onClick={()=>void acknowledge(alert.alert_id)}>รับทราบ</button>}
       <button type="button" className="btn primary" onClick={()=>{onNavigate(alert.details.target??'operations');setOpen(false);}}>เปิดข้อมูลต้นทาง</button>
       <button type="button" className="btn" onClick={()=>{onAsk(`ตรวจข้อมูลล่าสุดเกี่ยวกับ ${alert.message} (${identity(alert)}) และแนะนำสิ่งที่ควรทำ พร้อมหลักฐาน`);setOpen(false);}}>ถาม Agent ต่อ</button>
      </div>
     </article>)}
    </div>
    <footer><button type="button" disabled={offset===0||loading} onClick={()=>setOffset(Math.max(0,offset-30))}>ก่อนหน้า</button>
     <span>รายการ {feed?.alerts.length?offset+1:0}–{offset+(feed?.alerts.length??0)}</span><button type="button" disabled={!feed||feed.alerts.length<30||loading} onClick={()=>setOffset(offset+30)}>ถัดไป</button></footer>
   </div>
  </div>,document.body)}
 </>;
}
