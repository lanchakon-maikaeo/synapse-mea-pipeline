"use client";

import { isValidElement, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { formatDateTime, formatNumber, type Role } from "./lib";
import {
  createForecastRunPayload,
  parseVmiHistory,
  snapshotIso,
  toLocalDateInput,
  toLocalDateTimeInput,
} from "./pipeline-validation";
import {
  useSynapseBackend,
  type DashboardData,
  type ForecastRunPayload,
  type RecordRow,
  type RouteJobPayload,
  type VmiContext,
  type VmiInputPayload,
} from "./use-synapse-backend";

type UserRole = Role;
type ViewKey = "dashboard" | "data" | "stock" | "replenishment" | "history" | "stockUpdate" | "confirm" | "traceability" | "suggestions" | "requestReview" | "route" | "transportDashboard" | "transportMap" | "transportHistory" | "admin" | "modules" | "api" | "forecast" | "operations" | "releases";
type DeliveryState = "complete" | "gated" | "excluded";
type ModuleRecord = { id: string; name: string; delivery: string; operation: string; state: DeliveryState };

const modules: ModuleRecord[] = [
  { id: "M01", name: "Platform & Security", delivery: "Complete · deployed", operation: "Supabase Test active", state: "complete" },
  { id: "M02", name: "Source Connectors", delivery: "Complete · tested", operation: "Actual-source + governed Web input active", state: "complete" },
  { id: "M03", name: "Ingestion & Raw", delivery: "Complete · deployed", operation: "Contract, material, stock และ CMP reconciled", state: "complete" },
  { id: "M04", name: "Data Quality & Staging", delivery: "Complete · deployed", operation: "18-district mapping active", state: "complete" },
  { id: "M05", name: "Core Data Model", delivery: "Complete · deployed", operation: "1,043 materials + lineage active", state: "complete" },
  { id: "M06", name: "Stock & Replenishment", delivery: "Complete · deployed", operation: "รอ District Stock source", state: "gated" },
  { id: "M07", name: "Forecasting", delivery: "Complete · deployed", operation: "มีสูงสุด 12 เดือน; gate ต้อง ≥14 เดือน", state: "gated" },
  { id: "M08", name: "Transport & Route", delivery: "Complete · deployed", operation: "รอ verified routing masters + approved plan", state: "gated" },
  { id: "M09", name: "Same-origin API", delivery: "Complete · serverless deployed", operation: "29 unique paths · JWT/RBAC · 120 req/min", state: "complete" },
  { id: "M10", name: "Dashboard", delivery: "Complete · publicly deployed", operation: "Public surface; Auth protects business data", state: "complete" },
  { id: "M11", name: "RAG / MCP / AI", delivery: "Excluded from release", operation: "ไม่มี AI result ใน 1.0.0-non-ai", state: "excluded" },
  { id: "M12", name: "Operations & CI/CD", delivery: "Complete · tested", operation: "รอเชื่อม CI และตั้ง backup host", state: "complete" },
];

const navByRole: Record<UserRole, Array<{label:string;items:Array<[ViewKey,string,string]>}>> = {
  admin: [
    { label: "เมนูหลัก", items: [["dashboard","Dashboard","⌂"],["replenishment","คำนวณการจ่าย","▤"],["history","ประวัติแผนการจ่าย","◷"]] },
    { label: "Decision Intelligence", items: [["suggestions","Quantity Suggestions","✦"],["requestReview","Abnormal Request Review","!"],["traceability","Issue Traceback","⌕"]] },
    { label: "ระบบอื่น", items: [["stock","ข้อมูล Stock","▦"],["stockUpdate","อัปเดต Stock","↻"],["data","ข้อมูล SAP","▥"]] },
    { label: "การวางแผน", items: [["forecast","พยากรณ์ความต้องการ","⌁"],["route","วางแผนขนส่ง","▣"]] },
    { label: "ผู้ดูแลระบบ", items: [["admin","System Administration","⚙"]] },
  ],
  planner: [
    { label: "เมนูหลัก", items: [["dashboard","Dashboard","⌂"],["replenishment","คำนวณการจ่าย","▤"],["history","ประวัติแผนการจ่าย","◷"]] },
    { label: "ตรวจสอบและสอบกลับ", items: [["suggestions","Quantity Suggestions","✦"],["requestReview","Abnormal Request Review","!"],["traceability","Issue Traceback","⌕"]] },
    { label: "ข้อมูลและแผน", items: [["stock","ข้อมูล Stock","▦"],["stockUpdate","อัปเดต Stock","↻"],["data","ข้อมูล SAP","▥"],["forecast","พยากรณ์ความต้องการ","⌁"],["route","วางแผนขนส่ง","▣"]] },
  ],
  viewer: [{ label: "ดูข้อมูล", items: [["dashboard","Dashboard","⌂"],["stock","ข้อมูล Stock","▦"],["traceability","Issue Traceback","⌕"],["forecast","พยากรณ์ความต้องการ","⌁"],["transportDashboard","ภาพรวมขนส่ง","⌖"]] }],
  district: [{ label: "เมนูเขต", items: [["dashboard","Dashboard","⌂"],["confirm","ยืนยันรายการพัสดุ","✓"],["requestReview","คำขอปรับจำนวน","!"],["history","ประวัติการจ่าย","◷"],["stock","ข้อมูล Stock ของเขต","▦"],["forecast","พยากรณ์ของเขต","⌁"]] }],
};

const titles: Record<ViewKey, [string, string, string]> = {
  dashboard: ["OPERATIONS", "Operations Dashboard", "Your role-specific workspace for inventory, replenishment and planning."],
  modules: ["MODULE STATUS", "สถานะโมดูล M01–M12", "แยกสถานะการส่งมอบออกจากความพร้อมใช้งานจริง"],
  data: ["SAP DATA", "ข้อมูล SAP", "ข้อมูลการเบิกจ่ายที่ตรวจสอบแหล่งที่มาแล้ว"],
  api: ["M09 / M10 DELIVERY", "API, Web Input & Security", "Same-origin /api, Supabase JWT, governed publish และ persistent rate limiting"],
  stock: ["STOCK", "ข้อมูล Stock", "ตรวจสอบข้อมูลคงคลังล่าสุดตามสิทธิ์ของผู้ใช้งาน"],
  replenishment: ["WMS", "คำนวณการจ่ายพัสดุ", "คำนวณ CMP, Days of Stock และ Suggested Quantity จากข้อมูลที่ตรวจสอบแล้ว"],
  history: ["WMS", "ประวัติแผนการจ่าย", "ติดตามรายการที่สร้าง ยืนยัน และอนุมัติแล้ว"],
  stockUpdate: ["STOCK", "อัปเดต Stock", "นำเข้าข้อมูล Stock จากแหล่งที่ได้รับอนุมัติ"],
  confirm: ["DISTRICT", "ยืนยันรายการพัสดุ", "ตรวจสอบและยืนยันรายการเฉพาะเขตของผู้ใช้งาน"],
  traceability: ["TRACEABILITY", "Issue Traceback", "สอบกลับ Material จากเขตผู้รับไปถึงสัญญา ผู้ขาย งวดรับ และ Pallet ที่จ่ายจริง"],
  suggestions: ["DECISION SUPPORT", "Quantity Suggestions", "แสดง Policy suggestion และหลักฐานจากข้อมูลจริง โดยไม่อนุมัติรายการอัตโนมัติ"],
  requestReview: ["REQUEST CONTROL", "Abnormal Request Review", "ตรวจคำขอสูงกว่าระบบเสนอ พร้อมเหตุผลและสถานะที่ backend บันทึกไว้"],
  forecast: ["DEMAND PLANNING", "Demand & Forecast", "Demand history is recorded; operational forecasting remains behind the 14-month readiness gate"],
  route: ["TRANSPORT", "วางแผนขนส่ง", "สร้างรอบขนส่งจากแผนการจ่ายที่ได้รับอนุมัติ"],
  transportDashboard: ["TRANSPORT", "แผงควบคุมขนส่ง", "ภาพรวมรอบรถและงานขนส่งที่เกี่ยวข้อง"],
  transportMap: ["TRANSPORT", "แผนที่เส้นทาง", "แสดงเส้นทางเมื่อข้อมูลพิกัดและรถผ่านการยืนยัน"],
  transportHistory: ["TRANSPORT", "ประวัติการขนส่ง", "ติดตามรอบรถที่บันทึกไว้"],
  admin: ["ADMINISTRATION", "System Administration", "ตรวจสอบแหล่งข้อมูล สิทธิ์ และความพร้อมของระบบ"],
  operations: ["M12 OPERATIONS", "Operations Center & Runbook", "Health, alerts, jobs, backup, release และ incident response"],
  releases: ["RELEASE CONTROL", "Acceptance & Environment", "ผลตรวจรับและขอบเขต Environment ของ Release 1.0.0-non-ai"],
};

function StatePill({ state, label }: { state: DeliveryState; label?: string }) {
  return <span className={`state-pill ${state}`}>{label || (state === "complete" ? "READY" : state === "gated" ? "DATA GATED" : "EXCLUDED")}</span>;
}

function totals(data: DashboardData) {
  const value = data.legacyStatus?.totals;
  return value && typeof value === "object"
    ? value as RecordRow
    : {};
}

function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === ""
    ? fallback
    : String(value);
}

function latestSnapshot(data: DashboardData) {
  const timestamps = data.warehouseStock
    .map(row => new Date(String(row.snapshot_at ?? "")).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? formatDateTime(Math.max(...timestamps)) : "รอข้อมูล";
}

function LiveTable({
  columns,
  empty,
  rows,
}: {
  columns: Array<[string, (row: RecordRow) => unknown]>;
  empty: string;
  rows: RecordRow[];
}) {
  if (!rows.length) {
    return <article className="workspace-empty"><i>—</i><h3>{empty}</h3><p>ระบบไม่สร้างข้อมูลจำลองขึ้นมาแทนข้อมูลจริง</p></article>;
  }
  return <div className="live-table-wrap"><table className="live-table"><thead><tr>{columns.map(([label])=><th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={`${text(row.replenishment_item_id ?? row.material_id ?? row.route_plan_id ?? row.forecast_run_id ?? "row")}-${index}`}>{columns.map(([label,render])=>{const value=render(row);return <td key={label}>{isValidElement(value)?value:text(value)}</td>})}</tr>)}</tbody></table></div>;
}

function Login({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error: string;
  onLogin: (identifier: string, password: string) => Promise<boolean>;
}) {
  const [showPassword,setShowPassword] = useState(false);
  const [identifier,setIdentifier] = useState("");
  const [password,setPassword] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onLogin(identifier, password);
  };
  return <main className="login-page">
    <section className="login-visual" aria-label="MEA Synapse platform overview">
      <div className="login-brand"><b>MEA</b><span><strong>MEA Synapse</strong><small>WAREHOUSE OPERATIONS</small></span></div>
      <div className="login-copy">
        <span>RELEASE 1.0.0-NON-AI · STAGING</span>
        <h1>Warehouse operations,<br/>grounded in verified data.</h1>
        <p>Monitor inventory sources, replenishment readiness, demand history and transport preparation from one governed workspace.</p>
      </div>
      <div className="login-metrics" aria-label="Recorded data snapshot">
        <span><strong>1,043</strong> Materials</span><span><strong>18</strong> Active districts</span><span><strong>462</strong> Warehouse snapshots</span>
      </div>
    </section>
    <section className="login-form-wrap">
      <form className="login-form" onSubmit={submit}>
        <div className="mobile-logo"><b>MEA</b><span>MEA Synapse</span></div>
        <span className="demo-tag"><i/> STAGING · SUPABASE AUTH</span>
        <div className="login-heading"><h2>Sign in to MEA Synapse</h2><p>Access the warehouse operations workspace powered by the SYNAPSE data platform.</p></div>
        <label>Username or email<input value={identifier} onChange={event=>setIdentifier(event.target.value)} autoComplete="username" required aria-describedby="auth-access-note"/></label>
        <label>Password<div className="password-field"><input type={showPassword ? "text" : "password"} value={password} onChange={event=>setPassword(event.target.value)} autoComplete="current-password" required aria-describedby="auth-access-note"/><button type="button" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div></label>
        {error&&<div className="form-error" role="alert">{error}</div>}
        <button className="btn primary login-submit" type="submit" disabled={busy}>{busy?"Checking access…":"Sign in"} <span>→</span></button>
        <div className="login-assurance"><span>Role-based access</span><i/> <span>District-scoped views</span></div>
        <small id="auth-access-note">Authentication, application role and district scope are verified by the existing Supabase backend.</small>
      </form>
    </section>
  </main>;
}

function Sidebar({ active, role, open, navigate, close, snapshot }: { active: ViewKey; role:UserRole; open: boolean; navigate: (v: ViewKey) => void; close: () => void; snapshot: string }) {
  const roleName={admin:"Administrator",planner:"Planner",viewer:"Viewer",district:"District User"}[role];
  return <><button className={`scrim ${open ? "show" : ""}`} onClick={close} aria-label="Close menu"/><aside className={`sidebar ${open ? "open" : ""}`}><div className="brand"><span>MEA</span><div><strong>MEA Synapse</strong><small>WAREHOUSE OPERATIONS</small></div></div><div className="user-scope"><i>{roleName.charAt(0)}</i><div><small>Signed in as</small><strong>{roleName}</strong></div></div><nav>{navByRole[role].map(group => <section key={group.label}><p>{group.label}</p>{group.items.map(([key,label,icon]) => <button type="button" key={key} className={active === key ? "active" : ""} aria-current={active === key ? "page" : undefined} onClick={() => { navigate(key); close(); }}><i>{icon}</i><span>{label}</span></button>)}</section>)}</nav><div className="release-badge"><small>Latest verified snapshot</small><strong>{snapshot}</strong><span>STAGING · Live backend</span></div></aside></>;
}

function Header({ title, loading, openMenu, logout, navigate, notify, refresh, snapshot }: { title: string; loading: boolean; openMenu: () => void; logout: () => void; navigate: (v: ViewKey) => void; notify: (s: string) => void; refresh: () => void; snapshot: string }) {
  const [query,setQuery] = useState(""); const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const focus = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current?.focus(); } }; window.addEventListener("keydown",focus); return () => window.removeEventListener("keydown",focus); },[]);
  const search = () => { const q=query.trim().toLowerCase(); if(!q){searchRef.current?.focus();return;} const target:ViewKey=q.includes("trace")||q.includes("สอบกลับ")||q.includes("contract")||q.includes("สัญญา")?"traceability":q.includes("suggest")||q.includes("แนะนำ")?"suggestions":q.includes("request")||q.includes("คำขอ")?"requestReview":q.includes("stock")||q.includes("สต็อก")?"stock":q.includes("sap")?"data":q.includes("forecast")||q.includes("พยากรณ์")?"forecast":q.includes("route")||q.includes("ขนส่ง")?"route":q.includes("history")||q.includes("ประวัติ")?"history":"replenishment"; navigate(target); notify(`เปิดผลลัพธ์ “${query}” แล้ว`); setQuery(""); };
  return <header className="topbar"><button type="button" className="menu" onClick={openMenu} aria-label="Open menu">☰</button><div className="breadcrumb"><span>MEA Synapse</span><i>/</i><strong>{title}</strong></div><div className="header-actions"><form className="global-search" onSubmit={e=>{e.preventDefault();search();}}><button type="submit" aria-label="Search">⌕</button><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="ค้นหารหัสหรือชื่อพัสดุ"/><kbd>Ctrl K</kbd></form><span className="scope-chip">STAGING</span><button type="button" className="last-sync live-sync" onClick={refresh} disabled={loading}><i/> {loading?"Syncing…":snapshot}</button><button type="button" className="btn ghost logout" onClick={logout}>Sign out</button></div></header>;
}

function Dashboard({ data, role, navigate }: { data: DashboardData; role:UserRole; navigate: (v: ViewKey) => void }) {
  const config={
    admin:{title:"Run warehouse operations with confidence",desc:"Review inventory sources, planning workflows and data readiness from one workspace.",actions:[["Replenishment Planning","Create a plan using the approved inventory policy","replenishment"],["Stock Import","Load inventory from an approved source","stockUpdate"],["System Administration","Review data sources, access and system readiness","admin"]]},
    planner:{title:"Plan today’s warehouse operations",desc:"Calculate replenishment, review demand readiness and prepare transport plans from verified data.",actions:[["Replenishment Planning","Review policy readiness and calculate recommended quantities","replenishment"],["Demand Forecast","Check history coverage before creating a forecast","forecast"],["Transport Planning","Start with an approved replenishment plan","route"]]},
    viewer:{title:"Monitor operational performance",desc:"Review inventory, demand and transport status without changing or approving records.",actions:[["Inventory & Stock","Review verified inventory records","stock"],["Demand Forecast","View readiness and the latest available results","forecast"],["Transport Overview","Monitor planning and route status","transportDashboard"]]},
    district:{title:"Manage your district workload",desc:"Review only the inventory, forecast and replenishment records assigned to your district.",actions:[["Confirm Materials","Confirm quantities or provide a reason for changes","confirm"],["Replenishment History","Track plans assigned to your district","history"],["District Inventory","View records scoped to your district profile","stock"]]}
  }[role];
  const pending = data.replenishment.filter(row=>!["confirmed","rejected","shipped"].includes(text(row.item_status).toLowerCase())).length;
  return <div className="stack user-dashboard"><section className="user-hero"><div><span>MEA SYNAPSE · {role.toUpperCase()}</span><h2>{config.title}</h2><p>{config.desc}</p></div><strong>Live snapshot · {latestSnapshot(data)}</strong></section><section className="task-grid">{config.actions.map(([title,desc,target])=><button type="button" key={title} onClick={()=>navigate(target as ViewKey)}><i>→</i><span><strong>{title}</strong><small>{desc}</small></span></button>)}</section><section className="user-status"><article><span>Ready to act</span><strong>{formatNumber(pending)}</strong><small>Replenishment items awaiting action</small></article><article><span>Warehouse snapshots</span><strong>{formatNumber(data.warehouseStock.length)}</strong><small>Latest verified inventory records</small></article><article><span>District coverage</span><strong>{formatNumber(data.districts.length)}</strong><small>{role==="district"?"Scoped to your district profile":"Active districts"}</small></article></section><aside className="plain-notice"><i>i</i><div><strong>Verified operational data only</strong><p>ข้อมูลหน้านี้โหลดจาก Supabase ผ่าน same-origin API; ข้อมูลที่ขาดจะไม่ถูกแทนด้วยค่าจำลอง</p></div></aside></div>;
}

// Retained as release-evidence reference while the role-based workspace is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ModuleStatusView() {
  const [filter,setFilter] = useState<"all"|DeliveryState>("all"); const shown=modules.filter(m=>filter==="all"||m.state===filter);
  return <div className="stack"><section className="module-summary"><div><strong>11</strong><span>โมดูลใน Scope ส่งมอบแล้ว</span></div><div><strong>3</strong><span>Operational data gates</span></div><div><strong>1</strong><span>M11 excluded</span></div><p>“Data gated” หมายถึง Implementation พร้อม แต่จะ Fail closed จนได้รับข้อมูลจริง ไม่ใช่โมดูลพัฒนาไม่เสร็จ</p></section><section className="module-toolbar"><span>กรองสถานะ</span>{(["all","complete","gated","excluded"] as const).map(x=><button type="button" key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x==="all"?"ทั้งหมด":x==="complete"?"ส่งมอบแล้ว":x==="gated"?"Data gated":"Excluded"}</button>)}</section><section className="module-grid">{shown.map(m=><article key={m.id} className={m.state}><header><i>{m.id}</i><StatePill state={m.state}/></header><h3>{m.name}</h3><strong>{m.delivery}</strong><p>{m.operation}</p></article>)}</section></div>;
}

// Retained as release-evidence reference while the role-based workspace is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DataFoundationView({ notify }: { notify:(s:string)=>void }) {
  const sources=[
    ["Contracts","6,305","source rows","Reconciled"],["Legacy materials","658","actual source rows","Activated"],["Core materials","1,043","canonical records","Active"],["Warehouse stock","462","actual snapshots","Loaded"],["CMP usage","5,926","source rows","Loaded"],["Monthly demand","48,259","feature observations","Loaded"],
  ];
  return <div className="stack"><section className="data-hero honest"><div><span>WAVE 1 · DEPLOYED & ACCEPTED</span><h3>Auditable PostgreSQL Data Foundation</h3><p>Supabase Test · Raw immutable payload · typed staging · normalized Core · analytics views</p></div><strong>21/21</strong><button type="button" className="btn light" onClick={()=>notify("เอกสารปรับปรุง 20 ก.ค. 2569 · ตัวเลขข้อมูลเป็น snapshot 16 ก.ค. 2569")}>ตรวจที่มาข้อมูล</button></section><section className="source-metric-grid">{sources.map(([name,value,unit,status],i)=><article key={name}><div className={`source-icon s${i%4}`}>⇄</div><span>{status}</span><h3>{name}</h3><strong>{value}</strong><p>{unit}</p></article>)}</section><article className="panel lineage"><div className="panel-title"><div><span>GOVERNED LINEAGE</span><h3>Standard ingestion and promotion path</h3></div><StatePill state="complete" label="CHECKSUM + IDEMPOTENCY"/></div><div className="lineage-flow evidence-lineage"><span>Excel / CSV<br/><small>Sheets · Web</small></span><i>→</i><span>Raw<br/><small>Immutable rows</small></span><i>→</i><span>Staging<br/><small>Typed + DQ</small></span><i>→</i><b>Core<br/><small>Canonical</small></b><i>→</i><span>Analytics<br/><small>Views / Features</small></span><i>→</i><span>Ops / Audit<br/><small>Alerts + lineage</small></span></div></article><section className="quality-grid"><article className="panel"><div className="panel-title"><div><span>KNOWN SOURCE FACTS</span><h3>Data quality ที่เก็บไว้ตามจริง</h3></div></div><ul className="fact-list"><li><b>2,130</b><span>Contract rows ไม่มี Material Code</span></li><li><b>1,228</b><span>ไม่มี Contract Number; ใช้ PO เป็น key</span></li><li><b>38</b><span>Material codes ไม่ใช่ SAP 12 หลัก</span></li><li><b>11</b><span>Delivery dates ก่อน Document dates</span></li><li><b>0</b><span>Hard validation rejection ใน baseline</span></li></ul></article><article className="panel"><div className="panel-title"><div><span>SECURITY BOUNDARY</span><h3>RLS, roles และ browser safety</h3></div></div><ul className="check-list"><li>Browser ไม่มี service_role หรือ database credential</li><li>Roles: admin, planner, viewer, district</li><li>District user ถูก scope ด้วย district_id 5501–5518</li><li>Raw, Staging, Core, Analytics, Ops และ Audit ไม่เปิดตรงต่อ Browser</li><li>API ส่ง Supabase JWT ไปยัง security-definer RPC</li></ul></article></section><article className="panel doc-reconcile"><div className="panel-title"><div><span>DOCUMENT RECONCILIATION</span><h3>แยกผลตรวจรับเดิมออกจาก Current snapshot</h3></div><StatePill state="complete" label="TIMELINE ALIGNED"/></div><div className="reconcile-grid"><div><strong>Wave 1 baseline</strong><p>203 VMI material rows → 776 union masters · 6,305 contract items / 2,857 headers</p></div><i>→</i><div><strong>Legacy actual activation</strong><p>658 material rows · 462 warehouse snapshots · 5,926 CMP rows</p></div><i>→</i><div><strong>Current recorded state</strong><p>1,043 Core materials · 48,259 monthly-demand-v1 observations</p></div></div><small>Wave 2/3 readiness notes ที่ระบุ 0 stock หรือ 0 demand เป็น snapshot ก่อน legacy actual import; District Stock ยังคง unavailable ตามเอกสารล่าสุด</small></article></div>;
}

// Retained as release-evidence reference while the role-based workspace is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ApiPipelineView({ notify }: { notify:(s:string)=>void }) {
  const endpointGroups = [
    ["Public health", "2", "/health · /health/ready"],
    ["Identity & reference", "8", "me · contracts · quality · materials · districts · warehouse · source status/import"],
    ["Input & replenishment", "7", "context · governed publish · stock health · queue · run · confirm · approve"],
    ["Forecast, route & jobs", "10", "forecast results/monitoring · job queue · route plans/review · readiness"],
    ["Operations", "2", "operations health · alerts"],
  ];
  return <div className="stack"><section className="capability-hero api"><div><span>M09 / M10 · SERVERLESS DEPLOYED</span><h3>Same-origin API และ Governed Web Input</h3><p>29 unique paths · Supabase JWT/RBAC · district scope · 120 requests/minute · body limit 1 MiB</p></div><StatePill state="complete" label="DEPLOYED"/></section><section className="source-metric-grid api-groups">{endpointGroups.map(([name,value,note],i)=><article key={name}><div className={`source-icon s${i%4}`}>↗</div><span>ENDPOINT GROUP</span><h3>{name}</h3><strong>{value}</strong><p>{note}</p></article>)}</section><article className="panel lineage"><div className="panel-title"><div><span>SAME-ORIGIN DISPATCH</span><h3>Browser ไม่มี Database credential</h3></div><StatePill state="complete" label="JWT + RLS"/></div><div className="lineage-flow evidence-lineage"><span>Dashboard<br/><small>Supabase session</small></span><i>→</i><span>/api<br/><small>request ID + headers</small></span><i>→</i><b>RPC Gateway<br/><small>m09 · m10 · legacy 011</small></b><i>→</i><span>PostgreSQL<br/><small>RBAC + district scope</small></span><i>→</i><span>Core / Analytics<br/><small>governed result</small></span></div></article><article className="panel process-panel"><div className="panel-title"><div><span>GOVERNED WEB VMI INPUT</span><h3>ข้อมูลเข้า 1 Transaction พร้อม Lineage</h3></div></div><div className="process-steps">{[["1","Select context","Real material + active district"],["2","Validate input","Stock + 3–36 months + source note"],["3","Publish","Raw → Staging → Core / Analytics"],["4","Optional run","Create M06 run when authorized"]].map(([n,title,desc])=><div key={n}><i>{n}</i><strong>{title}</strong><small>{desc}</small></div>)}</div></article><section className="quality-grid"><article className="panel"><div className="panel-title"><div><span>VALIDATION & IDEMPOTENCY</span><h3>กติกาการ Publish</h3></div></div><ul className="check-list"><li>Material และ District ต้องอยู่ใน Supabase master</li><li>Stock ห้ามติดลบ; timestamp ห้ามเกินอนาคต 5 นาที</li><li>History ต้องมี 3–36 เดือน ไม่ซ้ำ ไม่ติดลบ และไม่ใช่เดือนอนาคต</li><li>Source note ต้องมี 3–500 ตัวอักษร</li><li>Payload เดิมคืนผลเดิมและไม่สร้างข้อมูลซ้ำ</li></ul></article><article className="panel"><div className="panel-title"><div><span>ACCESS CONTROL</span><h3>สิทธิ์ตามบทบาท</h3></div></div><ul className="check-list"><li>Admin: import, publish, run, approve และดู alerts</li><li>Planner: publish, run, approve และ review</li><li>Viewer: อ่านภาพรวม ไม่มีสิทธิ์ publish/approve</li><li>District: อ่านและ confirm เฉพาะ district_id ของตน</li><li><code>m11_legacy_dispatch</code> คือ migration 011 ไม่ใช่ M11 AI</li></ul></article></section><section className="truth-banner"><i>i</i><div><strong>การนับ API ที่ปรับให้ตรงกัน</strong><p>Latest endpoint catalog มี 29 unique paths; ตัวเลข 26 ใน completion record เป็นเอกสารก่อนเพิ่ม actual-source และ operations paths จึงใช้ catalog วันที่ 20 ก.ค. เป็นสถานะล่าสุด</p></div><button type="button" className="btn ghost" onClick={()=>notify("API catalog ล่าสุด: 29 unique paths · same-origin /api")}>ยืนยันสถานะ</button></section></div>;
}

function StockView({ data, role, navigate }: { data:DashboardData; role:UserRole; navigate:(v:ViewKey)=>void }) {
  const canUpdate=role==="admin"||role==="planner";
  const [query,setQuery]=useState("");
  const normalized=query.trim().toLowerCase();
  const warehouse=data.warehouseStock.filter(row=>!normalized||`${text(row.material_id)} ${text(row.material_name,"")}`.toLowerCase().includes(normalized));
  const district=data.stock.filter(row=>!normalized||`${text(row.material_id)} ${text(row.material_name,"")} ${text(row.district_id,"")}`.toLowerCase().includes(normalized));
  return <div className="stack user-workspace"><section className="filter-bar"><input aria-label="ค้นหาข้อมูล Stock" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ค้นหา Material ID / ชื่อพัสดุ"/><select aria-label="ประเภทสถานที่" disabled><option>{role==="district"?"เขตของฉัน":"ทุกข้อมูลตามสิทธิ์"}</option></select><button type="button" className="btn ghost" onClick={()=>setQuery("")}>ล้างตัวกรอง</button></section><section className="user-status"><article><span>Warehouse snapshots</span><strong>{formatNumber(data.warehouseStock.length)}</strong><small>Latest actual records</small></article><article><span>Material masters</span><strong>{formatNumber(data.materials.length)}</strong><small>Core materials</small></article><article><span>District Stock</span><strong>{formatNumber(data.stock.length)}</strong><small>Scoped by backend role</small></article></section>{!data.stock.length&&<aside className="plain-notice warning"><i>!</i><div><strong>ยังไม่พบข้อมูล Stock รายเขต</strong><p>หน้าจอแสดงเฉพาะข้อมูลที่ตรวจสอบแล้ว และจะไม่สร้างยอดคงเหลือรายเขตขึ้นมาแทน</p></div>{canUpdate&&<button type="button" className="btn primary" onClick={()=>navigate("stockUpdate")}>อัปเดต Stock</button>}</aside>}<section className="live-section"><div className="panel-title"><div><span>WAREHOUSE STOCK</span><h3>สต็อกคลังล่าสุด</h3></div><b>{formatNumber(warehouse.length)} รายการ</b></div><LiveTable rows={warehouse.slice(0,250)} empty="ไม่พบ Warehouse Stock" columns={[["Material",row=>row.material_id],["รายละเอียด",row=>row.material_name],["คงเหลือ",row=>formatNumber(row.quantity_on_hand,2)],["หน่วย",row=>row.unit],["สถานที่",row=>row.location_name_th??row.location_id],["Snapshot",row=>formatDateTime(row.snapshot_at)]]}/></section><section className="live-section"><div className="panel-title"><div><span>DISTRICT STOCK HEALTH</span><h3>สุขภาพสต็อกรายเขต</h3></div><b>{formatNumber(district.length)} รายการ</b></div><LiveTable rows={district.slice(0,250)} empty="ยังไม่มี District Stock ที่ตรวจสอบแล้ว" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_name_th??row.district_id],["คงเหลือ",row=>formatNumber(row.current_stock_qty,2)],["CMP/เดือน",row=>formatNumber(row.cmp_monthly,2)],["คงเหลือ (เดือน)",row=>formatNumber(row.months_available,1)],["สถานะ",row=>row.health_band]]}/></section></div>;
}

function ReplenishmentView({ actionBusy, data, districts, onApprove, onCreate, role }: { actionBusy:boolean; data:DashboardData; districts:RecordRow[]; onApprove:(planId:string)=>Promise<boolean>; onCreate:()=>Promise<boolean>; role:UserRole }) {
  const [district,setDistrict]=useState("all"); const [priority,setPriority]=useState("all"); const [query,setQuery]=useState("");
  const filtered=data.replenishment.filter(row=>(district==="all"||text(row.district_id)===district)&&(priority==="all"||text(row.priority_band).toLowerCase()===priority)&&(!query.trim()||`${text(row.material_id)} ${text(row.material_name,"")}`.toLowerCase().includes(query.trim().toLowerCase())));
  const canCreate=role==="admin"||role==="planner";
  const critical=filtered.filter(row=>["critical","high"].includes(text(row.priority_band).toLowerCase())).length;
  const total=filtered.reduce((sum,row)=>sum+(Number(row.suggested_qty)||0),0);
  return <div className="stack calculator-page"><section className="filter-bar calculator-filters"><label>เขต:<select value={district} onChange={e=>setDistrict(e.target.value)}><option value="all">ทุกเขต</option>{districts.map(row=><option key={text(row.district_id)} value={text(row.district_id)}>{text(row.district_name_th,row.district_id as string)}</option>)}</select></label><label>Priority:<select value={priority} onChange={e=>setPriority(e.target.value)}><option value="all">ทั้งหมด</option><option value="critical">สูง</option><option value="watch">เฝ้าระวัง</option><option value="normal">ปกติ</option></select></label><input aria-label="ค้นหารหัสหรือชื่อพัสดุ" value={query} onChange={event=>setQuery(event.target.value)} placeholder="ค้นหารหัส / ชื่อพัสดุ"/><button type="button" className="btn ghost" onClick={()=>{setDistrict("all");setPriority("all");setQuery("")}}>ล้างตัวกรอง</button></section><section className="policy-summary"><span><small>Trigger</small><strong>3.5 เดือน</strong></span><span><small>Proposed MIN</small><strong>4 เดือน</strong></span><span><small>Suggested / MAX</small><strong>6 เดือน</strong></span><span><small>รายการที่พบ</small><strong>{formatNumber(filtered.length)}</strong></span><span><small>Priority สูง</small><strong>{formatNumber(critical)}</strong></span></section><section className="calculation-summary">{[[formatNumber(filtered.length),"รายการทั้งหมด"],[formatNumber(critical),"Priority สูง"],[formatNumber(total,2),"จำนวนเสนอรวม"],[formatNumber(data.stock.length),"Stock rows"],[formatNumber(data.districts.length),"เขตในสิทธิ์"]].map(([value,label])=><article key={label}><strong>{value}</strong><span>{label}</span></article>)}{canCreate&&<button type="button" className="btn primary" disabled={actionBusy} onClick={()=>void onCreate()}>▷ เริ่มคำนวณรอบใหม่</button>}</section>{!data.stock.length&&<aside className="plain-notice warning"><i>!</i><div><strong>ยังไม่สามารถสร้าง Candidate ใหม่ได้</strong><p>ไม่พบ District Stock ที่ตรวจสอบแล้ว ระบบจึงคงสถานะ fail closed ตาม backend pipeline</p></div></aside>}<LiveTable rows={filtered} empty="ยังไม่มีรายการคำนวณการจ่าย" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_id],["Stock",row=>formatNumber(row.current_stock_qty,2)],["CMP",row=>formatNumber(row.cmp_monthly,2)],["คงเหลือ (เดือน)",row=>formatNumber(row.months_available,1)],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["Priority",row=>row.priority_band],["สถานะ",row=>row.item_status],["แผน",row=>{const planId=text(row.replenishment_plan_id);return canCreate&&planId&&text(row.plan_status).toLowerCase()!=="approved"?<button type="button" className="table-action" disabled={actionBusy} onClick={()=>void onApprove(planId)}>อนุมัติแผน</button>:text(row.plan_status);}]]}/></div>;
}

function HistoryView({ data, role }:{data:DashboardData;role:UserRole}) {
  return <div className="stack user-workspace">{role==="district"&&<aside className="scope-banner"><span>DISTRICT SCOPE</span><strong>แสดงเฉพาะเขตของผู้ใช้งาน</strong><p>ขอบเขตข้อมูลถูกบังคับโดย JWT และ district_id ใน backend</p></aside>}<LiveTable rows={data.replenishment} empty="ยังไม่มีประวัติแผนการจ่าย" columns={[["Plan",row=>text(row.replenishment_plan_id).slice(0,8)],["Material",row=>row.material_id],["เขต",row=>row.district_id],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["ยืนยัน",row=>formatNumber(row.confirmed_qty,2)],["สถานะแผน",row=>row.plan_status],["สถานะรายการ",row=>row.item_status]]}/></div>;
}

function StockUpdateView({
  actionBusy,
  data,
  onLoadContext,
  onPublish,
}:{
  actionBusy:boolean;
  data:DashboardData;
  onLoadContext:(materialId:string,districtId:string)=>Promise<VmiContext|null>;
  onPublish:(payload:VmiInputPayload)=>Promise<boolean>;
}) {
  const [materialId,setMaterialId]=useState("");
  const [districtId,setDistrictId]=useState("");
  const [snapshotAt,setSnapshotAt]=useState(()=>toLocalDateTimeInput());
  const [currentStock,setCurrentStock]=useState("");
  const [sourceNote,setSourceNote]=useState("");
  const [historyText,setHistoryText]=useState("");
  const [runReplenishment,setRunReplenishment]=useState(false);
  const [contextBusy,setContextBusy]=useState(false);
  const [formError,setFormError]=useState("");
  const selectedMaterialId=materialId||text(data.materials[0]?.material_id);
  const selectedDistrictId=districtId||text(data.districts[0]?.district_id);
  const loadContext=async()=>{
    if(!selectedMaterialId||!selectedDistrictId)return;
    setContextBusy(true);setFormError("");
    try{
      const context=await onLoadContext(selectedMaterialId,selectedDistrictId);
      if(!context)return;
      setCurrentStock(context.stock?text(context.stock.quantity_on_hand,"0"):"");
      const snapshot=context.stock?text(context.stock.snapshot_at):"";
      setSnapshotAt(snapshot?toLocalDateTimeInput(new Date(snapshot)):toLocalDateTimeInput());
      setHistoryText(context.history.map(row=>{
        const period=text(row.period_start).slice(0,7);
        return [period,text(row.demand_quantity,"0"),text(row.stockout_days,"0"),text(row.lead_time_days,"")].join(",").replace(/,+$/,"");
      }).join("\n"));
      setSourceNote("Web VMI update based on verified backend context");
    }finally{
      setContextBusy(false);
    }
  };
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setFormError("");
    try{
      const history=parseVmiHistory(historyText);
      if(currentStock.trim()===""||Number(currentStock)<0||!Number.isFinite(Number(currentStock)))throw new Error("Current stock ต้องไม่ติดลบ");
      if(sourceNote.trim().length<3)throw new Error("Source note ต้องมีอย่างน้อย 3 ตัวอักษร");
      const ok=await onPublish({
        material_id:selectedMaterialId,
        district_id:selectedDistrictId,
        snapshot_at:snapshotIso(snapshotAt),
        current_stock:Number(currentStock),
        source_note:sourceNote.trim(),
        history,
        run_replenishment:runReplenishment,
      });
      if(ok){setRunReplenishment(false);await loadContext();}
    }catch(submitError){setFormError(submitError instanceof Error?submitError.message:"ข้อมูลไม่ถูกต้อง");}
  };
  return <div className="stack user-workspace">
    <section className="upload-card"><i>↻</i><div><span>GOVERNED DATA INPUT</span><h2>Web → Raw → Staging → Core/Analytics</h2><p>เลือก master จาก Supabase โหลด context ล่าสุด แล้วเผยแพร่ Stock และ Demand history พร้อม lineage/idempotency</p></div></section>
    <form className="pipeline-form" onSubmit={submit}>
      <div className="form-grid">
        <label>Material<select value={selectedMaterialId} onChange={event=>setMaterialId(event.target.value)} required><option value="">เลือก Material</option>{data.materials.map(row=><option key={text(row.material_id)} value={text(row.material_id)}>{text(row.material_id)} · {text(row.material_name,"ไม่ระบุชื่อ")}</option>)}</select></label>
        <label>District<select value={selectedDistrictId} onChange={event=>setDistrictId(event.target.value)} required><option value="">เลือกเขต</option>{data.districts.map(row=><option key={text(row.district_id)} value={text(row.district_id)}>{text(row.district_id)} · {text(row.district_name_th)}</option>)}</select></label>
        <label>Snapshot time<input type="datetime-local" value={snapshotAt} onChange={event=>setSnapshotAt(event.target.value)} required/></label>
        <label>Current stock<input type="number" min="0" step="any" value={currentStock} onChange={event=>setCurrentStock(event.target.value)} required/></label>
        <label className="wide">Source note<input value={sourceNote} onChange={event=>setSourceNote(event.target.value)} minLength={3} maxLength={500} required placeholder="แหล่งข้อมูล ผู้ตรวจสอบ และเหตุผลการอัปเดต"/></label>
        <label className="wide">Demand history<textarea className="history-input" value={historyText} onChange={event=>setHistoryText(event.target.value)} required placeholder={"YYYY-MM,quantity,stockout_days,lead_time_days\n2026-01,120,0,7\n2026-02,98,1,7\n2026-03,105,0,6"}/><small>อย่างน้อย 3 เดือน สูงสุด 36 เดือน; 1 บรรทัดต่อเดือน</small></label>
      </div>
      <label className="pipeline-check"><input type="checkbox" checked={runReplenishment} onChange={event=>setRunReplenishment(event.target.checked)}/><span>สร้าง M06 replenishment run หลัง publish สำเร็จ</span></label>
      {formError&&<div className="form-error" role="alert">{formError}</div>}
      <div className="pipeline-actions"><button type="button" className="btn ghost" onClick={()=>void loadContext()} disabled={!selectedMaterialId||!selectedDistrictId||contextBusy||actionBusy}>{contextBusy?"กำลังโหลด…":"โหลด Context ล่าสุด"}</button><button type="submit" className="btn primary" disabled={actionBusy}>{actionBusy?"กำลังบันทึก…":"Publish governed input"}</button></div>
    </form>
    <aside className="plain-notice"><i>i</i><div><strong>Warehouse ล่าสุด: {formatNumber(data.warehouseStock.length)} รายการ</strong><p>การนำเข้า source เต็มชุดยังทำผ่าน governed Python importer; browser นี้รับเฉพาะ VMI input ที่ผู้ใช้ตรวจสอบแล้ว</p></div></aside>
    <LiveTable rows={data.inputSubmissions} empty="ยังไม่มี Web input submission" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_name_th??row.district_id],["จำนวนเดือน",row=>row.input_month_count],["Source note",row=>row.source_note],["สถานะ",row=>row.status],["บันทึกเมื่อ",row=>formatDateTime(row.created_at)]]}/>
  </div>;
}

function ConfirmView({ actionBusy, data, onConfirm }:{actionBusy:boolean;data:DashboardData;onConfirm:(itemId:string,quantity:number,reason:string)=>Promise<boolean>}) {
  const pending=data.replenishment.filter(row=>!["confirmed","rejected","shipped"].includes(text(row.item_status).toLowerCase()));
  const [selected,setSelected]=useState<RecordRow|null>(null);
  const [quantity,setQuantity]=useState("");
  const [reason,setReason]=useState("");
  const submit=async(event:FormEvent)=>{event.preventDefault();if(!selected)return;const ok=await onConfirm(text(selected.replenishment_item_id),Number(quantity),reason);if(ok){setSelected(null);setQuantity("");setReason("");}};
  return <div className="stack user-workspace"><aside className="scope-banner"><span>DISTRICT SCOPE</span><strong>แสดงเฉพาะรายการที่ backend อนุญาต</strong><p>District user ไม่สามารถอ่านหรือยืนยันข้อมูลของเขตอื่นได้</p></aside><LiveTable rows={pending} empty="ไม่มีรายการรอยืนยัน" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_id],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["Priority",row=>row.priority_band],["สถานะ",row=>row.item_status],["ดำเนินการ",row=><button type="button" className="table-action" disabled={actionBusy} onClick={()=>{setSelected(row);setQuantity(text(row.suggested_qty,"0"))}}>ยืนยัน</button>]]}/>{selected&&<form className="confirm-card" onSubmit={submit}><div><span>DISTRICT CONFIRMATION</span><h3>{text(selected.material_id)} · เขต {text(selected.district_id)}</h3></div><label>จำนวนที่ยืนยัน<input type="number" min="0" step="any" value={quantity} onChange={event=>setQuantity(event.target.value)} required/></label><label>เหตุผล<input value={reason} onChange={event=>setReason(event.target.value)} minLength={1} required placeholder="ระบุเหตุผลประกอบ"/></label><div><button type="button" className="btn ghost" disabled={actionBusy} onClick={()=>setSelected(null)}>ยกเลิก</button><button type="submit" className="btn primary" disabled={actionBusy}>{actionBusy?"กำลังบันทึก…":"บันทึกการยืนยัน"}</button></div></form>}</div>;
}

function TraceabilityView({ data, role }:{data:DashboardData;role:UserRole}) {
  const [query,setQuery]=useState("");
  const [submittedQuery,setSubmittedQuery]=useState("");
  const normalized=submittedQuery.trim().toLowerCase();
  const matches=(row:RecordRow,fields:string[])=>fields.some(field=>text(row[field],"").toLowerCase().includes(normalized));
  const planMatches=normalized
    ? data.replenishment.filter(row=>matches(row,["material_id","material_name","district_id","replenishment_plan_id","replenishment_item_id"]))
    : [];
  const contractMatches=normalized
    ? data.contracts.filter(row=>matches(row,["purchase_order","procurement_code","contract_number","vendor_name"]))
    : [];
  return <div className="stack intelligence-page">
    {role==="district"&&<aside className="scope-banner"><span>DISTRICT SCOPE</span><strong>สอบกลับได้เฉพาะรายการที่ backend อนุญาต</strong><p>ข้อมูลสัญญาและผู้ขายไม่ถูกโหลดให้ District role</p></aside>}
    <section className="trace-search"><div><span>END-TO-END TRACEABILITY</span><h2>ค้นหาหลักฐานการจ่าย</h2><p>ค้นจาก Material, Plan, PO หรือเลขสัญญา โดยใช้ข้อมูลจริงที่ API อนุญาตให้บัญชีนี้อ่าน</p></div><form onSubmit={event=>{event.preventDefault();setSubmittedQuery(query)}}><input value={query} onChange={event=>setQuery(event.target.value)} required placeholder="Material / Plan / PO / Contract"/><button className="btn primary" type="submit">Search Trace</button></form></section>
    <section className="trace-chain" aria-label="Traceback data path">{[["1","District Issue","เขต · วันที่รับ · จำนวน"],["2","Final Plan","คำแนะนำ · คำขอปรับ · ผู้อนุมัติ"],["3","FIFO Allocation","Pallet · Remain ก่อน/หลัง"],["4","Receipt Lot","วันผ่านตรวจรับ · งวดรับ"],["5","Contract & Vendor","PO · สัญญา · Vendor alias"]].map(([n,title,desc],index)=><div key={title}><i>{n}</i><span><strong>{title}</strong><small>{desc}</small></span>{index<4&&<b>→</b>}</div>)}</section>
    <aside className="plain-notice warning"><i>!</i><div><strong>End-to-end allocation ยัง Data gated</strong><p>backend เดิมยังไม่มี endpoint สำหรับ FIFO allocation, Handling Unit และ Issue movement; หน้านี้จึงแสดงเฉพาะ Plan/Contract evidence ที่มีจริงและไม่เชื่อมความสัมพันธ์ขึ้นเอง</p></div></aside>
    {normalized?<><section className="live-section"><div className="panel-title"><div><span>PLAN EVIDENCE</span><h3>รายการแผนที่ตรงกับคำค้น</h3></div><b>{formatNumber(planMatches.length)} รายการ</b></div><LiveTable rows={planMatches} empty="ไม่พบ Plan evidence ที่ตรงกับคำค้น" columns={[["Plan",row=>text(row.replenishment_plan_id).slice(0,8)],["Material",row=>row.material_id],["เขต",row=>row.district_id],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["ยืนยัน",row=>formatNumber(row.confirmed_qty,2)],["เหตุผล",row=>row.district_note],["สถานะ",row=>row.item_status]]}/></section>{role!=="district"&&<section className="live-section"><div className="panel-title"><div><span>CONTRACT EVIDENCE</span><h3>สัญญาที่ตรงกับคำค้น</h3></div><b>{formatNumber(contractMatches.length)} รายการ</b></div><LiveTable rows={contractMatches} empty="ไม่พบ Contract evidence ที่ตรงกับคำค้น" columns={[["PO",row=>row.purchase_order],["สัญญา",row=>row.contract_number],["รหัสจัดหา",row=>row.procurement_code],["ผู้ขาย",row=>row.vendor_name],["รายการ",row=>formatNumber(row.source_item_count)],["สถานะ",row=>row.contract_status]]}/></section>}</>:<article className="workspace-empty compact"><i>⌕</i><h3>ระบุรหัสเพื่อค้นหลักฐานจริง</h3><p>ผลลัพธ์จะไม่แสดงจนกว่าจะส่งคำค้น และจะไม่สร้าง Traceback จำลองเมื่อข้อมูลต้นทางยังไม่ครบ</p></article>}
  </div>;
}

function QuantitySuggestionsView({ data, navigate }:{data:DashboardData;navigate:(v:ViewKey)=>void}) {
  const [district,setDistrict]=useState("all");
  const [material,setMaterial]=useState("");
  const normalized=material.trim().toLowerCase();
  const rows=data.replenishment.filter(row=>(district==="all"||text(row.district_id)===district)&&(!normalized||`${text(row.material_id)} ${text(row.material_name,"")}`.toLowerCase().includes(normalized)));
  const hasPolicyEvidence=data.replenishment.length>0;
  const hasMatches=rows.length>0;
  return <div className="stack intelligence-page">
    <section className="decision-hero"><div><span>EXPLAINABLE RECOMMENDATION</span><h2>Policy first. History as evidence.</h2><p>แสดงผลจาก M06 Replenishment queue ของ backend เดิม; Planner ยังเป็นผู้ตัดสินใจและไม่มี Auto-approval</p></div><strong>{hasPolicyEvidence?"LIVE POLICY DATA":"DATA GATED"}</strong></section>
    <section className="suggestion-input"><label>District / เขต<select value={district} onChange={event=>setDistrict(event.target.value)}><option value="all">ทุกเขตตามสิทธิ์</option>{data.districts.map(row=><option key={text(row.district_id)} value={text(row.district_id)}>{text(row.district_name_th,row.district_id as string)}</option>)}</select></label><label>Material<input value={material} onChange={event=>setMaterial(event.target.value)} placeholder="ค้นหารหัสหรือชื่อพัสดุ"/></label><button type="button" className="btn ghost" onClick={()=>{setDistrict("all");setMaterial("")}}>ล้างตัวกรอง</button></section>
    <section className="method-grid"><article><i>01</i><span><strong>Policy Baseline</strong><small>Trigger · MIN · MAX จาก M06</small></span></article><article><i>02</i><span><strong>Stock Evidence</strong><small>Stock · CMP · Months remaining</small></span></article><article><i>03</i><span><strong>Priority</strong><small>Score · Band · Data readiness</small></span></article><article><i>04</i><span><strong>Human Decision</strong><small>Confirm หรือปรับพร้อมเหตุผล</small></span></article></section>
    <section className="suggestion-layout"><article className="panel suggestion-card"><div className="panel-title"><div><span>POLICY OUTPUT</span><h3>{hasMatches?"ผลคำนวณจาก backend เดิม":hasPolicyEvidence?"ไม่มีรายการตรงกับตัวกรอง":"ยังไม่มีข้อมูลพร้อมคำนวณ"}</h3></div><span className={`state-pill ${hasPolicyEvidence?"complete":"gated"}`}>{hasPolicyEvidence?"LIVE":"DATA GATED"}</span></div><div className="suggestion-numbers"><span><small>รายการ</small><strong>{formatNumber(rows.length)}</strong></span><span><small>Critical / High</small><strong>{formatNumber(rows.filter(row=>["critical","high"].includes(text(row.priority_band).toLowerCase())).length)}</strong></span><span><small>จำนวนเสนอรวม</small><strong>{formatNumber(rows.reduce((sum,row)=>sum+(Number(row.suggested_qty)||0),0),2)}</strong></span><span><small>ปรับแล้ว</small><strong>{formatNumber(rows.filter(row=>row.confirmed_qty!==null&&row.confirmed_qty!==undefined).length)}</strong></span></div><p>{hasPolicyEvidence?"ค่าด้านล่างมาจาก API และคำนวณรวมเฉพาะรายการที่โหลดมา":"ระบบไม่สร้างคำแนะนำแทน District Stock/CMP ที่ขาด"}</p></article><article className="panel evidence-panel"><span>AVAILABLE / GATED EVIDENCE</span><h3>ขอบเขตหลักฐาน</h3><ul className="check-list"><li>มี: Stock, CMP, Months Remaining, MIN/MAX และ Policy Suggested</li><li>มี: Priority, สถานะ, จำนวนยืนยัน และเหตุผล District</li><li>ยังไม่มี endpoint: Median/P90, Confidence และ Recommendation engine version</li><li>ยังไม่มี endpoint: FIFO/Pallet และ Sequential Academic approval</li></ul></article></section>
    <LiveTable rows={rows} empty="ไม่มี Policy suggestion ที่ตรงกับตัวกรอง" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_id],["Stock",row=>formatNumber(row.current_stock_qty,2)],["CMP",row=>formatNumber(row.cmp_monthly,2)],["คงเหลือ (เดือน)",row=>formatNumber(row.months_available,1)],["MIN",row=>formatNumber(row.min_fill_qty,2)],["MAX",row=>formatNumber(row.max_fill_qty,2)],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["Priority",row=>row.priority_band],["สถานะ",row=>row.item_status]]}/>
    <aside className="plain-notice"><i>i</i><div><strong>คำแนะนำไม่ใช่คำอนุมัติ</strong><p>การยืนยันหรือปรับจำนวนต้องใช้ workflow เดิมและบันทึกเหตุผลใน backend</p></div><button className="btn ghost" type="button" onClick={()=>navigate("requestReview")}>เปิด Abnormal Review</button></aside>
  </div>;
}

function RequestReviewView({ data, role, navigate }:{data:DashboardData;role:UserRole;navigate:(v:ViewKey)=>void}) {
  const adjusted=data.replenishment.filter(row=>row.confirmed_qty!==null&&row.confirmed_qty!==undefined&&Number(row.confirmed_qty)!==Number(row.suggested_qty));
  const aboveSuggestion=adjusted.filter(row=>Number(row.confirmed_qty)>Number(row.suggested_qty));
  const pending=data.replenishment.filter(row=>!["confirmed","rejected","shipped"].includes(text(row.item_status).toLowerCase()));
  return <div className="stack intelligence-page">
    <section className="risk-hero"><div><span>REQUEST CONTROL</span><h2>{role==="district"?"Request and confirm with a reason":"Review quantity adjustments"}</h2><p>เปรียบเทียบจำนวนที่ backend เสนอกับจำนวนยืนยันจริง พร้อมเหตุผลและสถานะของรายการ</p></div><span className="risk-badge">M06 MAX GUARD ACTIVE</span></section>
    <section className="user-status"><article><span>รายการปรับจำนวน</span><strong>{formatNumber(adjusted.length)}</strong><small>Confirmed quantity ต่างจาก Suggested</small></article><article><span>ปรับสูงกว่าระบบเสนอ</span><strong>{formatNumber(aboveSuggestion.length)}</strong><small>ต้องมี District note</small></article><article><span>รอดำเนินการ</span><strong>{formatNumber(pending.length)}</strong><small>ตามสิทธิ์ของบัญชีนี้</small></article></section>
    <aside className="plain-notice warning"><i>!</i><div><strong>ขอบเขตของ backend ปัจจุบัน</strong><p>M06 บังคับเหตุผลและไม่ให้จำนวนยืนยันเกิน MAX; 9-month special approval และ risk score จาก `update-v1` ยังไม่มี API จึงไม่แสดงว่า Operational</p></div>{role==="district"&&<button className="btn primary" type="button" onClick={()=>navigate("confirm")}>ไปยืนยันรายการ</button>}</aside>
    <LiveTable rows={adjusted} empty="ยังไม่มีรายการปรับจำนวนที่ backend บันทึกไว้" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_id],["ระบบเสนอ",row=>formatNumber(row.suggested_qty,2)],["ยืนยัน",row=>formatNumber(row.confirmed_qty,2)],["ส่วนต่าง",row=>formatNumber(Number(row.confirmed_qty)-Number(row.suggested_qty),2)],["MAX",row=>formatNumber(row.max_fill_qty,2)],["เหตุผล",row=>row.district_note],["สถานะ",row=>row.item_status]]}/>
    <section className="approval-flow">{[["1","District","ยืนยัน/ปรับ + เหตุผล"],["2","M06 Guard","ห้ามเกิน MAX"],["3","Planner","Review plan"],["4","API Audit","ผู้ใช้ + เวลา"],["5","Next phase","9M special approval"]].map(([n,title,desc],index)=><div key={title}><i>{n}</i><strong>{title}</strong><small>{desc}</small>{index<4&&<b>→</b>}</div>)}</section>
  </div>;
}

function SapDataView({ data }:{data:DashboardData}) {
  const currentTotals=totals(data);
  return <div className="stack user-workspace"><section className="user-status"><article><span>Demand observations</span><strong>{formatNumber(currentTotals.monthly_demand_rows)}</strong><small>monthly-demand-v1</small></article><article><span>CMP rows</span><strong>{formatNumber(currentTotals.usage_rates)}</strong><small>Source-traced usage</small></article><article><span>Materials</span><strong>{formatNumber(data.materials.length)}</strong><small>Core material master</small></article></section><LiveTable rows={data.materials.slice(0,500)} empty="ไม่พบ Material master" columns={[["Material",row=>row.material_id],["รายละเอียด",row=>row.material_name],["หน่วย",row=>row.unit],["Lot size",row=>formatNumber(row.lot_size,2)],["MOQ",row=>formatNumber(row.moq,2)],["คุณภาพข้อมูล",row=>row.data_quality_status]]}/></div>;
}

function ForecastWorkspace({ actionBusy, data, onQueue, role }:{actionBusy:boolean;data:DashboardData;onQueue:(payload:ForecastRunPayload)=>Promise<boolean>;role:UserRole}) {
  const currentTotals=totals(data);
  const ready=Boolean(data.readiness?.forecast_operational_ready);
  const canQueue=role==="admin"||role==="planner";
  const [trainingEnd,setTrainingEnd]=useState(()=>toLocalDateInput());
  const [trainingStart,setTrainingStart]=useState("");
  const [horizon,setHorizon]=useState("3");
  const [formError,setFormError]=useState("");
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setFormError("");
    try{
      await onQueue(createForecastRunPayload(trainingStart,trainingEnd,horizon));
    }catch(submitError){
      setFormError(submitError instanceof Error?submitError.message:"ข้อมูล Forecast run ไม่ถูกต้อง");
    }
  };
  return <div className="stack user-workspace">
    <section className="user-status"><article><span>Demand observations</span><strong>{formatNumber(currentTotals.monthly_demand_rows)}</strong><small>monthly-demand-v1</small></article><article><span>Forecast results</span><strong>{formatNumber(data.forecasts.length)}</strong><small>Latest persisted output</small></article><article><span>Operational gate</span><strong>{ready?"READY":"WAIT"}</strong><small>from backend readiness</small></article></section>
    <section className="readiness-card"><div><span>FORECAST READINESS</span><h2>{ready?"พร้อมสร้าง Forecast ทางการ":"ข้อมูลยังไม่ผ่าน Operational gate"}</h2><p>สถานะนี้โหลดจาก analytics.v_wave3_readiness ไม่ได้คำนวณจำลองใน Browser</p></div><strong>{ready?"READY":"DATA GATED"}</strong><div className="readiness-meter"><i style={{width:ready?"100%":"0%"}}/></div></section>
    {canQueue&&<form className="pipeline-form compact" onSubmit={submit}><div className="form-grid"><label>Training start (optional)<input type="date" value={trainingStart} max={trainingEnd} onChange={event=>setTrainingStart(event.target.value)}/></label><label>Training end<input type="date" value={trainingEnd} max={toLocalDateInput()} onChange={event=>setTrainingEnd(event.target.value)} required/></label><label>Horizon (months)<input type="number" min="1" max="24" step="1" value={horizon} onChange={event=>setHorizon(event.target.value)} required/></label></div>{formError&&<div className="form-error" role="alert">{formError}</div>}<div className="pipeline-actions"><button type="submit" className="btn primary" disabled={!ready||actionBusy}>{actionBusy?"กำลังเข้าคิว…":ready?"Queue Forecast Run":"รอข้อมูลผ่าน Readiness gate"}</button></div></form>}
    <LiveTable rows={data.forecasts} empty="ยังไม่มี Forecast operational result" columns={[["Material",row=>row.material_id],["เขต",row=>row.district_id],["งวด",row=>row.forecast_period],["แบบจำลอง",row=>row.model_version],["พยากรณ์",row=>formatNumber(row.predicted_quantity,2)],["Lower 80%",row=>formatNumber(row.lower_80,2)],["Upper 80%",row=>formatNumber(row.upper_80,2)]]}/>
    <section className="live-section"><div className="panel-title"><div><span>MONITORING</span><h3>Forecast runs และ drift status</h3></div><b>{formatNumber(data.forecastMonitoring.length)} รายการ</b></div><LiveTable rows={data.forecastMonitoring} empty="ยังไม่มี Forecast monitoring record" columns={[["Run",row=>text(row.forecast_run_id).slice(0,8)],["สถานะ",row=>row.status],["สร้างเมื่อ",row=>formatDateTime(row.created_at)],["WAPE",row=>formatNumber(row.wape,2)],["Bias",row=>formatNumber(row.bias,2)]]}/></section>
    {role==="district"&&<small className="scope-footnote">ผลลัพธ์ถูกจำกัดตาม district_id ของบัญชีนี้โดย backend</small>}
  </div>;
}

function AdminWorkspace({ data, onLoadJob }:{data:DashboardData;onLoadJob:(jobId:string)=>Promise<RecordRow|null>}) {
  const currentTotals=totals(data);
  const forecastReady=Boolean(data.readiness?.forecast_operational_ready);
  const routeReady=Boolean(data.readiness?.route_operational_ready);
  const [jobDetail,setJobDetail]=useState<RecordRow|null>(null);
  const [jobBusy,setJobBusy]=useState(false);
  const inspectJob=async(jobId:string)=>{setJobBusy(true);setJobDetail(await onLoadJob(jobId));setJobBusy(false);};
  const cards:Array<[string,string,string]>=[["Contracts",formatNumber(data.contracts.length),data.contracts.length?"Available":"Waiting"],["Material master",formatNumber(data.materials.length),data.materials.length?"Available":"Waiting"],["Warehouse Stock",formatNumber(data.warehouseStock.length),data.warehouseStock.length?"Available":"Waiting"],["District Stock",formatNumber(data.stock.length),data.stock.length?"Available":"Action needed"],["Forecast",forecastReady?"Ready":"Data gated",forecastReady?"Available":"Limited"],["Route",routeReady?"Ready":"Data gated",routeReady?"Available":"Action needed"],["Open alerts",formatNumber(data.operations?.open_alert_count),Number(data.operations?.open_alert_count)?"Action needed":"Available"],["Demand rows",formatNumber(currentTotals.monthly_demand_rows),"Available"]];
  return <div className="stack user-workspace">
    <section className="admin-source-grid">{cards.map(([name,value,status])=><article key={name} className={status==="Available"?'ready':'attention'}><span>{name}</span><strong>{value}</strong><small>{status}</small></article>)}</section>
    <section className="admin-panels"><article><span>ACCESS CONTROL</span><h3>Application roles</h3><ul><li>Admin: import, publish, run, approve และดู alerts</li><li>Planner: publish, run, approve และ review</li><li>Viewer: read-only monitoring</li><li>District: อ่านและยืนยันเฉพาะ district_id ของตน</li></ul></article><article><span>OPERATIONS HEALTH</span><h3>สถานะจาก backend</h3><ul><li>Failed jobs 24h: {formatNumber(data.operations?.failed_job_count_24h)}</li><li>Stale sources: {formatNumber(data.operations?.stale_source_count)}</li><li>Latest backup: {text(data.operations?.latest_backup_status)}</li><li>System alerts loaded: {formatNumber(data.alerts.length)}</li></ul></article></section>
    <section className="live-section"><div className="panel-title"><div><span>BACKGROUND WORKER</span><h3>Job queue และผลการทำงาน</h3></div><b>{formatNumber(data.jobs.length)} jobs</b></div><LiveTable rows={data.jobs} empty="ยังไม่มี Background job" columns={[["Job",row=>text(row.job_id).slice(0,8)],["ประเภท",row=>row.job_type],["สถานะ",row=>row.status],["Attempt",row=>`${formatNumber(row.attempt_count)}/${formatNumber(row.max_attempts)}`],["สร้างเมื่อ",row=>formatDateTime(row.created_at)],["รายละเอียด",row=><button type="button" className="table-action" disabled={jobBusy} onClick={()=>void inspectJob(text(row.job_id))}>เปิด</button>]]}/>{jobDetail&&<article className="pipeline-detail"><div><span>JOB DETAIL</span><button type="button" className="btn ghost" onClick={()=>setJobDetail(null)}>ปิด</button></div><pre>{JSON.stringify(jobDetail,null,2)}</pre></article>}</section>
    <section className="live-section"><div className="panel-title"><div><span>LEGACY INGESTION</span><h3>Governed source status</h3></div></div><pre className="pipeline-json">{JSON.stringify(data.legacyStatus??{},null,2)}</pre></section>
    <LiveTable rows={data.alerts} empty="ไม่มี System alert เปิดอยู่" columns={[["ประเภท",row=>row.alert_type],["ข้อความ",row=>row.message],["Severity",row=>row.severity],["สถานะ",row=>row.status],["เวลา",row=>formatDateTime(row.created_at)]]}/>
  </div>;
}

function TransportWorkspace({ data, onLoadDetail, view, navigate }:{data:DashboardData;onLoadDetail:(routePlanId:string)=>Promise<RecordRow|null>;view:ViewKey;navigate:(v:ViewKey)=>void}) {
  const title=view==="transportMap"?"แผนที่เส้นทาง":view==="transportHistory"?"ประวัติการขนส่ง":"แผงควบคุมขนส่ง";
  const [detail,setDetail]=useState<RecordRow|null>(null);
  const [detailBusy,setDetailBusy]=useState(false);
  const openDetail=async(routePlanId:string)=>{setDetailBusy(true);setDetail(await onLoadDetail(routePlanId));setDetailBusy(false);};
  return <div className="stack user-workspace"><section className="transport-quick"><button onClick={()=>navigate("route")}>วางแผนขนส่ง</button><button onClick={()=>navigate("transportMap")}>แผนที่เส้นทาง</button><button onClick={()=>navigate("transportHistory")}>ประวัติการขนส่ง</button></section><div className="panel-title"><div><span>TRANSPORT</span><h3>{title}</h3></div><b>{formatNumber(data.routes.length)} แผน</b></div><LiveTable rows={data.routes} empty="ยังไม่มี Route plan" columns={[["Route",row=>text(row.route_plan_id).slice(0,8)],["สถานะ",row=>row.status],["Solver",row=>row.solver_status],["จุดส่งสำเร็จ",row=>row.served_stop_count],["ไม่สำเร็จ",row=>row.unserved_stop_count],["ระยะทาง",row=>formatNumber(row.total_distance_m)],["สร้างเมื่อ",row=>formatDateTime(row.created_at)],["รายละเอียด",row=><button type="button" className="table-action" disabled={detailBusy} onClick={()=>void openDetail(text(row.route_plan_id))}>เปิด</button>]]}/>{detail&&<article className="pipeline-detail"><div><span>ROUTE PLAN + GEOJSON</span><button type="button" className="btn ghost" onClick={()=>setDetail(null)}>ปิด</button></div><pre>{JSON.stringify(detail,null,2)}</pre></article>}</div>;
}

function TransportPlanView({ actionBusy, data, navigate, onQueue, onReview }:{actionBusy:boolean;data:DashboardData;navigate:(v:ViewKey)=>void;onQueue:(payload:RouteJobPayload)=>Promise<boolean>;onReview:(routePlanId:string,decision:"approved"|"rejected",reason:string)=>Promise<boolean>}) {
  const ready=Boolean(data.readiness?.route_operational_ready);
  const approvedPlans=useMemo(()=>{
    const seen=new Set<string>();
    return data.replenishment.filter(row=>text(row.plan_status).toLowerCase()==="approved").filter(row=>{const id=text(row.replenishment_plan_id);if(!id||seen.has(id))return false;seen.add(id);return true;});
  },[data.replenishment]);
  const forecastRuns=useMemo(()=>Array.from(new Set(data.forecasts.map(row=>text(row.forecast_run_id)).filter(Boolean))),[data.forecasts]);
  const [planId,setPlanId]=useState("");
  const [forecastRunId,setForecastRunId]=useState("");
  const [reviewRoute,setReviewRoute]=useState<RecordRow|null>(null);
  const [reviewReason,setReviewReason]=useState("");
  const selectedPlanId=planId||text(approvedPlans[0]?.replenishment_plan_id);
  const queue=async()=>{if(!selectedPlanId)return;await onQueue({replenishment_plan_id:selectedPlanId,forecast_run_id:forecastRunId||undefined,matrix_source:"valhalla"});};
  const review=async(decision:"approved"|"rejected")=>{if(!reviewRoute)return;const ok=await onReview(text(reviewRoute.route_plan_id),decision,reviewReason);if(ok){setReviewRoute(null);setReviewReason("");}};
  return <div className="stack user-workspace">
    <section className="filter-bar"><label>Approved plan<select value={selectedPlanId} onChange={event=>setPlanId(event.target.value)} disabled={!ready}><option value="">{ready?"เลือกแผนการจ่ายที่อนุมัติแล้ว":"Route readiness ยังไม่ผ่าน"}</option>{approvedPlans.map(row=><option key={text(row.replenishment_plan_id)} value={text(row.replenishment_plan_id)}>{text(row.replenishment_plan_id).slice(0,8)} · {text(row.plan_status)}</option>)}</select></label><label>Forecast run<select value={forecastRunId} onChange={event=>setForecastRunId(event.target.value)} disabled={!ready}><option value="">ไม่ผูก Forecast run</option>{forecastRuns.map(id=><option key={id} value={id}>{id.slice(0,8)}</option>)}</select></label><button type="button" className="btn primary" onClick={()=>void queue()} disabled={!ready||!selectedPlanId||actionBusy}>{actionBusy?"กำลังเข้าคิว…":"สร้าง Route job"}</button></section>
    {!ready&&<aside className="plain-notice warning"><i>!</i><div><strong>ยังไม่มีข้อมูลจริงครบสำหรับ Route optimization</strong><p>backend ต้องตรวจ geocode, packaging, vehicle, driver, approved plan และ Valhalla ก่อนรับ job</p></div></aside>}
    <LiveTable rows={data.routes} empty="ยังไม่มี Route plan" columns={[["Route",row=>text(row.route_plan_id).slice(0,8)],["สถานะ",row=>row.status],["Solver",row=>row.solver_status],["Served",row=>row.served_stop_count],["Unserved",row=>row.unserved_stop_count],["Review",row=><button type="button" className="table-action" disabled={actionBusy||text(row.status).toLowerCase()!=="draft"} onClick={()=>setReviewRoute(row)}>{text(row.status).toLowerCase()==="draft"?"ตรวจ":"ดำเนินการแล้ว"}</button>]]}/>
    {reviewRoute&&<form className="confirm-card" onSubmit={event=>{event.preventDefault();void review("approved");}}><div><span>ROUTE REVIEW</span><h3>{text(reviewRoute.route_plan_id).slice(0,8)} · {text(reviewRoute.status)}</h3></div><label>เหตุผล / หมายเหตุ<input value={reviewReason} onChange={event=>setReviewReason(event.target.value)} maxLength={1000} placeholder="จำเป็นเมื่อปฏิเสธแผน"/></label><div><button type="button" className="btn ghost" onClick={()=>setReviewRoute(null)}>ยกเลิก</button><button type="button" className="btn ghost" disabled={actionBusy||reviewReason.trim().length===0} onClick={()=>void review("rejected")}>ปฏิเสธ</button><button type="submit" className="btn primary" disabled={actionBusy}>อนุมัติ Route</button></div></form>}
    <button type="button" className="btn ghost" onClick={()=>navigate("transportHistory")}>ดูประวัติการขนส่ง</button>
  </div>;
}

// Retained as release-evidence reference while the live forecast workspace is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ForecastView({ notify }: { notify:(s:string)=>void }) {
  const [horizon,setHorizon]=useState<3|7|14|30>(30);
  return <div className="stack"><section className="capability-hero forecast"><div><span>M07 · PLATFORM CAPABILITY DEPLOYED</span><h3>Forecasting engine พร้อม แต่ Operational activation ยังถูก Gate</h3><p>48,259 monthly-demand-v1 observations · สูงสุด 12 เดือนต่อ series</p></div><StatePill state="gated"/></section><section className="forecast-readiness"><article><span>History available</span><strong>12</strong><small>months maximum</small></article><div><header><span>AutoETS readiness</span><b>12 / 14 months</b></header><div className="large-progress"><i style={{width:"85.7%"}}/></div><p>Baseline ใช้ได้เมื่อ ≥7 เดือน แต่ AutoETS comparison และ operational readiness ต้อง ≥14 เดือน</p></div></section><section className="model-grid">{[["Seasonal Naive","Baseline","Available ≥7 months"],["Moving Average","Recursive baseline","Available ≥7 months"],["AutoETS","StatsForecast candidate","Blocked until ≥14 months"],["Model selection","WAPE → MAE → Bias","Implemented"],["Prediction interval","80% interval","Persisted"],["Drift checks","WAPE, Bias, shift, freshness","Scheduled design"]].map(([name,type,status],i)=><article key={name} className={i===2?"gated":""}><span>{type}</span><h3>{name}</h3><p>{status}</p></article>)}</section><article className="panel forecast-empty"><div className="panel-title"><div><span>FORECAST OUTPUT</span><h3>ยังไม่มี Forecast operational result</h3></div><div className="horizon-picker">{([3,7,14,30] as const).map(x=><button type="button" key={x} className={horizon===x?"active":""} onClick={()=>setHorizon(x)}>{x} วัน</button>)}</div></div><div className="empty-chart"><div className="threshold"><span>14-month gate</span></div><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><b>ต้องเพิ่มข้อมูลอย่างน้อย 2 เดือนต่อ series ก่อนสร้างผล {horizon} วัน</b></div><button type="button" className="btn ghost" onClick={()=>notify("Forecast run ถูกปิดไว้จนกว่า readiness จะผ่าน")}>ตรวจ Readiness gate</button></article></div>;
}

// Retained as release-evidence reference while the live transport workspace is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function RouteView({ notify }: { notify:(s:string)=>void }) {
  return <div className="stack"><section className="capability-hero route"><div><span>M08 · OR-TOOLS + VALHALLA ADAPTER DEPLOYED</span><h3>Route optimizer พร้อมทำงานเมื่อ Master Data ผ่านการยืนยัน</h3><p>Weight · volume · pallet · time window · service time · priority constraints</p></div><StatePill state="gated"/></section><section className="route-readiness-grid">{[["Locations","19 active","0 verified geocodes","gated"],["Materials","1,043 Core","0 routing-ready packaging","gated"],["Vehicles","2 source-traced","0 verified pallet capacity","gated"],["Drivers","0","ต้องใช้ข้อมูลจริง","gated"],["Approved plans","0","Route ต้องเริ่มจาก approved plan","gated"],["Matrix provider","Valhalla","ต้องมี reachable endpoint","gated"]].map(([name,value,note,state])=><article key={name}><span>{name}</span><strong>{value}</strong><p>{note}</p><StatePill state={state as DeliveryState}/></article>)}</section><article className="panel route-empty"><div className="map-placeholder"><div className="grid-map"><i/><i/><i/><i/></div><span>NO VERIFIED ROUTE DATA</span></div><div><span>PRODUCTION BEHAVIOR</span><h3>Fail closed เมื่อข้อมูลไม่ครบ</h3><p>Production จะไม่ใช้ Haversine แทน Valhalla โดยอัตโนมัติ และบันทึกเหตุผลของ Unserved stop อย่างชัดเจน</p><ul><li>Approved replenishment plan</li><li>Verified coordinates และ time windows</li><li>Packaging weight/volume/boxes per pallet</li><li>Vehicle capacity และ real driver</li></ul><button type="button" className="btn primary" onClick={()=>notify("Route job ยัง Queue ไม่ได้: routing readiness ไม่ผ่าน")}>ตรวจ Route readiness</button></div></article><article className="benchmark-strip"><span>Deterministic Bangkok benchmark</span><strong>34,885 m</strong><p>OR-Tools serves 3/3 stops · 0 unserved · no worse than nearest-neighbour baseline</p><StatePill state="complete" label="TEST EVIDENCE"/></article></div>;
}

// Retained as release-evidence reference while live operations data is active.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function OperationsView({ notify }: { notify:(s:string)=>void }) {
  const [checked,setChecked]=useState<string[]>([]); const toggle=(x:string)=>setChecked(v=>v.includes(x)?v.filter(y=>y!==x):[...v,x]);
  const routines=["/health/ready ต้องไม่เป็น 503","v_operations_health และ system_alerts","Heartbeat ล่าสุด < 10 นาที","Backup ล่าสุด succeeded + checksum","Refresh alerts หลัง source window 26 ชม."];
  return <div className="stack"><section className="operations-hero"><div><span>OPERATIONS RUNBOOK · RELEASE 1.0.0-NON-AI</span><h3>Daily Control Center</h3><p>รายการนี้เป็น Runbook checklist ไม่ใช่ผล Live query จาก Environment</p></div><button type="button" className="btn light" onClick={()=>{setChecked(routines);notify("ทำเครื่องหมาย Routine check ครบแล้ว — กรุณายืนยันกับระบบจริงอีกครั้ง")}}>ทำเครื่องหมายทั้งหมด</button></section><section className="ops-layout"><article className="panel routine-checks"><div className="panel-title"><div><span>ROUTINE CHECKS</span><h3>ตรวจประจำวัน</h3></div><b>{checked.length}/{routines.length}</b></div>{routines.map((item,i)=><label key={item}><input type="checkbox" checked={checked.includes(item)} onChange={()=>toggle(item)}/><i>{checked.includes(item)?"✓":i+1}</i><span>{item}</span></label>)}</article><article className="panel service-levels"><div className="panel-title"><div><span>OWNERSHIP & TARGETS</span><h3>ผู้รับผิดชอบหลัก</h3></div></div>{[["Source files","Procurement data steward","ตาม source window"],["Stock & CMP","SAP/WMS data steward","Freshness ≤26h"],["Pipeline & DQ","Data engineer","Investigate ≤4h"],["API & worker","Platform operator","99.5% pilot"],["Backup","Database operator","Daily / quarterly drill"],["Security","SYNAPSE admin","Quarterly review"]].map(([area,owner,target])=><div key={area}><span><strong>{area}</strong><small>{owner}</small></span><b>{target}</b></div>)}</article></section><section className="schedule-grid">{[["Monthly","วันที่ 1 · 02:05","Queue forecast"],["Every 5 min","Worker","Consume 1 forecast/route job"],["Daily","03:30","Refresh forecast drift"],["Every 15 min","Alert worker","Refresh operational alerts · stale 26h"]].map(([freq,time,job])=><article key={freq}><span>{freq}</span><strong>{time}</strong><p>{job}</p></article>)}</section><section className="activation-grid ops-procedures"><article><i>1</i><h3>Daily backup</h3><p>Logical dump + SHA-256 sidecar + evidence ใน ops.backup_runs</p></article><article><i>2</i><h3>Quarterly restore drill</h3><p>Restore ลง isolated database เท่านั้นและตรวจครบ 6 SYNAPSE schemas</p></article><article><i>3</i><h3>Safe release</h3><p>Test → OpenAPI → backup → migration → acceptance → smoke test → release record</p></article></section><section className="runbook-grid">{[
    ["API down","เช็ก /health → /health/ready → DB/TLS → restart เฉพาะ service"], ["Repeated 5xx","ใช้ request_id เชื่อม Dashboard error กับ JSON logs; ห้าม retry approval แบบสุ่ม"], ["Import / DQ failure","แก้ที่ Source แล้ว re-run checksum เดิม; ห้ามแก้ Core เพื่อซ่อน issue"], ["Failed worker","ตรวจ error_message, attempt count และ readiness masters ก่อน queue ใหม่"], ["Rollback","Pause writes → previous image → forward fix ก่อน destructive SQL rollback"], ["Security incident","Rotate credential → revoke user → preserve audit evidence → secret scan"],
  ].map(([title,body])=><details key={title}><summary>{title}<span>＋</span></summary><p>{body}</p></details>)}</section><section className="ops-warning"><i>!</i><div><strong>Environment boundary</strong><p>ขณะนี้มี Supabase managed project เพียง Test project เดียว ต้องแยก Development และ Production พร้อม backup/change approval ก่อน Production rollout</p></div></section></div>;
}

// Retained as release-evidence reference for the non-AI acceptance record.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ReleaseView() {
  const checks=[["Wave 1 database","21 / 21"],["Wave 3 database","12 / 12"],["Non-AI aggregate DB","15 / 15"],["M10 Web-input DB","10 / 10"],["API / Pipeline / Intelligence","30 / 30"],["Dashboard tests","15 / 15"]];
  return <div className="stack"><section className="release-hero"><div><span>ACCEPTANCE RECORD · DOCS ALIGNED 23 JUL 2026</span><h3>Release 1.0.0-non-ai</h3><p>M01–M10 และ M12 · Supabase Test + reproducible self-host runtime</p></div><StatePill state="complete" label="ACCEPTED"/></section><section className="acceptance-grid">{checks.map(([name,result])=><article key={name}><span>✓</span><div><strong>{result}</strong><p>{name}</p></div></article>)}</section><section className="release-layout"><article className="panel"><div className="panel-title"><div><span>DEPLOYED SURFACE</span><h3>Web & API topology</h3></div></div><ul className="check-list"><li>M09 same-origin `/api` มี 29 unique paths และ persistent 120 req/min</li><li>JWT roles + district scope + 1 MiB body limit + request ID</li><li>M10 เป็น Public surface บน Vercel; business data ป้องกันด้วย Supabase Auth</li><li>GitHub `main` เชื่อม Vercel project `synapse-mea/mea-synapse-staging` โดยตรง</li><li>FastAPI remains optional self-host alternative</li><li>No service-role or database credential shipped to Browser</li></ul><a className="btn primary external" href="https://mea-synapse-staging.vercel.app" target="_blank" rel="noreferrer">เปิด Vercel Dashboard ↗</a></article><article className="panel"><div className="panel-title"><div><span>BEFORE PRODUCTION</span><h3>Release gates ที่ยังต้องทำ</h3></div></div><ol className="number-list"><li>สร้าง Supabase Development / Test / Production แยกกัน</li><li>เผยแพร่ full-pipeline CI จาก outer workspace ไป Git repository</li><li>ตั้ง Daily logical backup และ Quarterly restore drill</li><li>เติม District Stock และ Forecast history ให้ผ่าน gate</li><li>ยืนยัน Route masters และ Valhalla endpoint</li><li>Smoke test แบบ authenticated สำหรับ RBAC และ idempotent publish</li></ol></article></section><article className="panel migration-strip"><div><span>DATABASE DELIVERY</span><h3>15 ordered migrations</h3><p>M01 foundation → ingestion/DQ/Core → replenishment → forecast/route → operations → API/Web input → legacy actual quality → M09 district-scope 403 hardening</p></div><StatePill state="complete" label="ORDERED + VERIFIED"/></article><aside className="scope-exclusion"><i>AI</i><div><strong>M11 RAG / MCP / AI ไม่อยู่ใน Release นี้</strong><p>Schema `rag` ถูกสงวนไว้เท่านั้น ส่วน <code>m11_legacy_dispatch</code> เป็นชื่อ migration 011 สำหรับ legacy actual source ไม่ใช่ AI module และไม่มี fabricated AI result ใน 1.0.0-non-ai</p></div></aside></div>;
}

function Page({
  actionBusy,
  data,
  navigate,
  onApprove,
  onConfirm,
  onCreate,
  onLoadJob,
  onLoadRoute,
  onLoadVmi,
  onPublishVmi,
  onQueueForecast,
  onQueueRoute,
  onReviewRoute,
  role,
  view,
}:{
  actionBusy:boolean;
  data:DashboardData;
  view:ViewKey;
  role:UserRole;
  navigate:(v:ViewKey)=>void;
  onApprove:(planId:string)=>Promise<boolean>;
  onConfirm:(itemId:string,quantity:number,reason:string)=>Promise<boolean>;
  onCreate:()=>Promise<boolean>;
  onLoadJob:(jobId:string)=>Promise<RecordRow|null>;
  onLoadRoute:(routePlanId:string)=>Promise<RecordRow|null>;
  onLoadVmi:(materialId:string,districtId:string)=>Promise<VmiContext|null>;
  onPublishVmi:(payload:VmiInputPayload)=>Promise<boolean>;
  onQueueForecast:(payload:ForecastRunPayload)=>Promise<boolean>;
  onQueueRoute:(payload:RouteJobPayload)=>Promise<boolean>;
  onReviewRoute:(routePlanId:string,decision:"approved"|"rejected",reason:string)=>Promise<boolean>;
}) {
  if(view==="dashboard") return <Dashboard data={data} role={role} navigate={navigate}/>;
  if(view==="data") return <SapDataView data={data}/>;
  if(view==="stock") return <StockView data={data} role={role} navigate={navigate}/>;
  if(view==="stockUpdate") return <StockUpdateView actionBusy={actionBusy} data={data} onLoadContext={onLoadVmi} onPublish={onPublishVmi}/>;
  if(view==="replenishment") return <ReplenishmentView actionBusy={actionBusy} data={data} districts={data.districts} onApprove={onApprove} onCreate={onCreate} role={role}/>;
  if(view==="history") return <HistoryView data={data} role={role}/>;
  if(view==="confirm") return <ConfirmView actionBusy={actionBusy} data={data} onConfirm={onConfirm}/>;
  if(view==="traceability") return <TraceabilityView data={data} role={role}/>;
  if(view==="suggestions") return <QuantitySuggestionsView data={data} navigate={navigate}/>;
  if(view==="requestReview") return <RequestReviewView data={data} role={role} navigate={navigate}/>;
  if(view==="forecast") return <ForecastWorkspace actionBusy={actionBusy} data={data} onQueue={onQueueForecast} role={role}/>;
  if(view==="admin") return <AdminWorkspace data={data} onLoadJob={onLoadJob}/>;
  if(view==="transportDashboard"||view==="transportMap"||view==="transportHistory") return <TransportWorkspace data={data} onLoadDetail={onLoadRoute} view={view} navigate={navigate}/>;
  if(view==="route") return <TransportPlanView actionBusy={actionBusy} data={data} navigate={navigate} onQueue={onQueueRoute} onReview={onReviewRoute}/>;
  return <Dashboard data={data} role={role} navigate={navigate}/>;
}

export default function Home() {
  const backend=useSynapseBackend();
  const [view,setView]=useState<ViewKey>("dashboard"); const [menuOpen,setMenuOpen]=useState(false); const [toast,setToast]=useState("");
  useEffect(()=>{const fn=(e:KeyboardEvent)=>{if(e.key==="Escape")setMenuOpen(false);};window.addEventListener("keydown",fn);return()=>window.removeEventListener("keydown",fn);},[]);
  const snapshot=useMemo(()=>latestSnapshot(backend.data),[backend.data]);
  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),3200);};
  if(!backend.session)return <Login busy={backend.authBusy} error={backend.error} onLogin={backend.signIn}/>;
  if(!backend.identity)return <main className="center-state"><section className="center-state-card" role={backend.error?"alert":"status"}><i>{backend.loading?"↻":"!"}</i><h1>{backend.loading?"กำลังตรวจสอบสิทธิ์":"ตรวจสอบสิทธิ์ไม่สำเร็จ"}</h1><p>{backend.error||"กำลังโหลด application role และ district scope จาก backend"}</p><div><button type="button" className="btn primary" onClick={()=>void backend.refresh()}>ลองอีกครั้ง</button><button type="button" className="btn ghost" onClick={()=>void backend.signOut()}>ออกจากระบบ</button></div></section></main>;
  const role=backend.identity.role; const [eyebrow,title,description]=titles[view];
  const visibleToast=toast||backend.notice;
  return <div className="app"><a className="skip" href="#content">ข้ามไปเนื้อหาหลัก</a><Sidebar active={view} role={role} open={menuOpen} navigate={setView} close={()=>setMenuOpen(false)} snapshot={snapshot}/><div className="shell"><Header title={title} loading={backend.loading} openMenu={()=>setMenuOpen(true)} logout={()=>void backend.signOut()} navigate={setView} notify={notify} refresh={()=>void backend.refresh()} snapshot={snapshot}/><main id="content" className="content"><header className="page-head user-page-head"><div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{(role==="admin"||role==="planner")&&view==="replenishment"&&<button type="button" className="btn primary" disabled={backend.actionBusy} onClick={()=>void backend.createReplenishmentRun()}>＋ คำนวณการจ่ายรอบใหม่</button>}</header>{backend.error&&<aside className="runtime-message error" role="alert"><i>!</i><div><strong>ไม่สามารถซิงก์ข้อมูลบางส่วน</strong><p>{backend.error}</p></div><button type="button" className="btn ghost" onClick={()=>void backend.refresh()}>ลองอีกครั้ง</button></aside>}<Page actionBusy={backend.actionBusy} data={backend.data} view={view} role={role} navigate={setView} onApprove={backend.approveReplenishmentPlan} onConfirm={backend.confirmReplenishment} onCreate={backend.createReplenishmentRun} onLoadJob={backend.loadJobDetail} onLoadRoute={backend.loadRoutePlanDetail} onLoadVmi={backend.loadVmiContext} onPublishVmi={backend.publishVmiInput} onQueueForecast={backend.queueForecastRun} onQueueRoute={backend.queueRouteJob} onReviewRoute={backend.reviewRoutePlan}/></main></div>{visibleToast&&<div className="toast" role="status" aria-live="polite"><span>✓</span>{visibleToast}</div>}</div>;
}
