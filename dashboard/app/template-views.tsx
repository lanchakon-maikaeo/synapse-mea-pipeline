"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Boxes,
  CheckCircle2,
  ClipboardList,
  MapPin,
  Package,
  Search,
  Truck,
  Warehouse,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDateTime, formatNumber, type Role } from "./lib";
import type { DashboardData, RecordRow } from "./use-synapse-backend";

type OpenView = (
  view:
    | "weekly"
    | "changes"
    | "approvals"
    | "receiving"
    | "fifo"
    | "stock"
    | "operations",
) => void;

function value(row: RecordRow, key: string) {
  const raw = row[key];
  return raw === null || raw === undefined || raw === "" ? "—" : String(raw);
}

function number(row: RecordRow, key: string) {
  const parsed = Number(row[key]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-border bg-card shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-5 pb-3 pt-5">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </header>
  );
}

function Action({
  children,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors ${primary ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-card text-foreground hover:bg-muted"}`}
    >
      {children}
    </button>
  );
}

const statusNames: Record<string, string> = {
  draft: "ร่าง",
  district_review: "รอเขตยืนยัน",
  planner_review: "รอผู้วางแผน",
  academic_review: "รอวิชาการ",
  approved: "อนุมัติแล้ว",
  locked: "ล็อกแผนแล้ว",
  issued: "จ่ายแล้ว",
  cancelled: "ยกเลิก",
  pending: "รอดำเนินการ",
  pending_review: "รอตรวจ",
  confirmed: "ยืนยันแล้ว",
  rejected: "ปฏิเสธ",
};

function StatusBadge({ status }: { status: string }) {
  const tone = /cancel|reject|error|critical|high/i.test(status)
    ? "border-destructive/30 bg-destructive/10 text-destructive"
    : /approved|locked|issued|confirmed|ready|healthy/i.test(status)
      ? "border-success/30 bg-success/10 text-success"
      : "border-warning/30 bg-warning/10 text-amber-700";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {statusNames[status] ?? status}
    </span>
  );
}

function KpiCard({
  label,
  value: metric,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Package;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{label}</span>
        <Icon className="size-4 text-primary" />
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-foreground">
        {metric}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </Card>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="p-8 text-center text-sm text-muted-foreground">{children}</p>
  );
}

function planKey(row: RecordRow) {
  return value(row, "replenishment_item_id") !== "—"
    ? value(row, "replenishment_item_id")
    : `${value(row, "replenishment_plan_id")}:${value(row, "material_id")}:${value(row, "district_id")}`;
}

export function OperationsTemplate({
  data,
  role,
  districtId,
  demoMode,
  open,
  openTransport,
}: {
  data: DashboardData;
  role: Role;
  districtId: string | null;
  demoMode: boolean;
  open: OpenView;
  openTransport: () => void;
}) {
  const visiblePlans =
    role === "district"
      ? data.replenishment.filter(
          (row) => value(row, "district_id") === districtId,
        )
      : data.replenishment;
  const visibleStock =
    role === "district"
      ? data.stock.filter((row) => value(row, "district_id") === districtId)
      : data.stock;
  const planIds = new Set(
    visiblePlans
      .map((row) => value(row, "replenishment_plan_id"))
      .filter((id) => id !== "—"),
  );
  const pending =
    role === "district"
      ? 0
      : data.changeRequests.filter(
          (row) => value(row, "status") === "pending_review",
        ).length;
  const fifo =
    role === "district"
      ? 0
      : data.fifo.filter((row) => number(row, "allocatable_qty") > 0).length;
  const districtTotals = Array.from(
    visiblePlans.reduce((map, row) => {
      const district = value(row, "district_id");
      map.set(district, (map.get(district) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
    ([district, count]) => ({ district, count }),
  ).slice(0, 8);
  const statusTotals = Array.from(
    visiblePlans.reduce((map, row) => {
      const status = value(row, "plan_status");
      map.set(status, (map.get(status) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
    ([status, count]) => ({ name: statusNames[status] ?? status, count }),
  );
  const stockByDistrict = Array.from(
    visibleStock.reduce((map, row) => {
      const district = value(row, "district_id");
      map.set(district, (map.get(district) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
    ([district, count]) => ({ district, count }),
  )
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const alerts =
    role === "admin" || role === "planner" ? data.alerts.slice(0, 3) : [];
  const visibleTrace =
    role === "district"
      ? data.traceability.filter(
          (row) => value(row, "district_id") === districtId,
        )
      : data.traceability;
  return (
    <div className="space-y-4">
      <PageHeader
        title="ภาพรวมการดำเนินงาน"
        description={`ข้อมูล${demoMode ? "ตัวอย่างในเครื่อง" : "ล่าสุดจากระบบ"}ตามสิทธิ์ของคุณ`}
      >
        <Action onClick={() => open("weekly")} primary>
          <ClipboardList className="size-4" /> เปิดแผนการจ่าย
        </Action>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="แผนการจ่าย"
          value={formatNumber(planIds.size)}
          sub="แผนที่มองเห็นตามสิทธิ์"
          icon={ClipboardList}
        />
        <KpiCard
          label={role === "district" ? "รายการในเขต" : "คำขอรอตรวจ"}
          value={formatNumber(
            role === "district" ? visiblePlans.length : pending,
          )}
          sub={
            role === "district"
              ? "รายการแผนของเขตที่รับผิดชอบ"
              : "รายการจากระบบอนุมัติ"
          }
          icon={AlertTriangle}
        />
        <KpiCard
          label={
            role === "district" ? "รายการสต็อกเขต" : "รายการพร้อมจ่าย FIFO"
          }
          value={formatNumber(role === "district" ? visibleStock.length : fifo)}
          sub={
            role === "district" ? "รายการสต็อกเขต" : "รายการที่มีจำนวนจัดสรรได้"
          }
          icon={Boxes}
        />
        <KpiCard
          label={role === "district" ? "เขตที่รับผิดชอบ" : "ข้อมูลสต็อกคลัง"}
          value={formatNumber(
            role === "district"
              ? Number(Boolean(districtId))
              : data.warehouseStock.length,
          )}
          sub={
            role === "district"
              ? (districtId ?? "ไม่ระบุเขต")
              : "รายการสต็อกล่าสุด"
          }
          icon={Warehouse}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="รายการแผนการจ่ายตามเขต"
            description="จำนวนรายการแผนที่เข้าถึงได้ในแต่ละเขต"
          />
          <div className="h-[260px] px-3 pb-4">
            {districtTotals.length ? (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 600, height: 260 }}
              >
                <AreaChart
                  data={districtTotals}
                  margin={{ left: 4, right: 16, top: 8 }}
                >
                  <defs>
                    <linearGradient
                      id="districtFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="#2575bb"
                        stopOpacity={0.38}
                      />
                      <stop
                        offset="95%"
                        stopColor="#2575bb"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="district"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={46}
                    fontSize={11}
                  />
                  <Tooltip formatter={(n) => formatNumber(n)} />
                  <Area
                    dataKey="count"
                    type="monotone"
                    stroke="#2575bb"
                    strokeWidth={2}
                    fill="url(#districtFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Empty>ยังไม่มีรายการแผนการจ่าย</Empty>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader
            title="สถานะแผนการจ่าย"
            description="สัดส่วนรายการตามสถานะจริง"
          />
          <div className="h-[260px] px-3 pb-4">
            {statusTotals.length ? (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 300, height: 260 }}
              >
                <PieChart>
                  <Pie
                    data={statusTotals}
                    dataKey="count"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={82}
                    paddingAngle={2}
                  >
                    {statusTotals.map((entry, index) => (
                      <Cell
                        key={entry.name}
                        fill={
                          [
                            "#2575bb",
                            "#278aa1",
                            "#21845c",
                            "#d3a03d",
                            "#9a71bc",
                          ][index % 5]
                        }
                      />
                    ))}
                  </Pie>
                  <Tooltip formatter={(n) => formatNumber(n)} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Empty>ยังไม่มีข้อมูลสถานะแผน</Empty>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader
            title="รายการแผนล่าสุด"
            description="ติดตามงานจ่ายพัสดุจากแผนจริง"
            action={
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                onClick={() => open("weekly")}
              >
                ดูทั้งหมด <ArrowRight className="size-4" />
              </button>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3">แผน / วัสดุ</th>
                  <th className="px-3 py-3">เขต</th>
                  <th className="px-3 py-3">สถานะ</th>
                  <th className="px-5 py-3 text-right">จำนวน</th>
                </tr>
              </thead>
              <tbody>
                {visiblePlans.slice(0, 6).map((row) => (
                  <tr
                    key={planKey(row)}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-5 py-3">
                      <strong className="block font-medium">
                        {value(row, "plan_code") !== "—"
                          ? value(row, "plan_code")
                          : value(row, "replenishment_plan_id")}
                      </strong>
                      <span className="text-xs text-muted-foreground">
                        {value(row, "material_name") !== "—"
                          ? value(row, "material_name")
                          : value(row, "material_id")}
                      </span>
                    </td>
                    <td className="px-3 py-3">{value(row, "district_id")}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={value(row, "plan_status")} />
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {formatNumber(row.suggested_qty, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visiblePlans.length && <Empty>ยังไม่มีรายการแผนการจ่าย</Empty>}
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="รายการที่ต้องติดตาม"
              description="แจ้งเตือนจากระบบปฏิบัติการ"
            />
            <div className="space-y-2 px-5 pb-5">
              {alerts.length ? (
                alerts.map((row, index) => (
                  <div
                    key={`${value(row, "alert_id")}-${index}`}
                    className="flex gap-3 rounded-lg border border-border bg-background p-3"
                  >
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    <div className="min-w-0">
                      <strong className="block text-sm">
                        {value(row, "title") !== "—"
                          ? value(row, "title")
                          : value(row, "alert_type")}
                      </strong>
                      <p className="truncate text-xs text-muted-foreground">
                        {value(row, "message")}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  ไม่มีแจ้งเตือนที่ต้องดำเนินการ
                </p>
              )}
            </div>
          </Card>
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-background p-3">
                <MapPin className="size-4 text-primary" />
                <p className="mt-2 text-2xl font-semibold">
                  {formatNumber(
                    role === "district"
                      ? Number(Boolean(districtId))
                      : data.districts.length,
                  )}
                </p>
                <p className="text-xs text-muted-foreground">เขตในระบบ</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-3">
                <CheckCircle2 className="size-4 text-success" />
                <p className="mt-2 text-2xl font-semibold">
                  {formatNumber(visibleTrace.length)}
                </p>
                <p className="text-xs text-muted-foreground">รายการสอบกลับ</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader
            title="เครือข่ายกระจายพัสดุ"
            description="ใช้แผนที่ถนนและพิกัดที่ยืนยันแล้วในระบบขนส่ง"
          />
          <div className="mx-5 mb-5 flex min-h-[220px] flex-col items-center justify-center rounded-lg border border-border bg-[radial-gradient(circle_at_center,#dcecf8,#f6f9fc)] p-6 text-center">
            <Truck className="size-10 text-primary" />
            <p className="mt-3 font-medium">
              {demoMode ? "แผนที่ข้อมูลตัวอย่าง" : "แผนที่ขนส่งจากข้อมูลระบบ"}
            </p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              ดูคลัง เขต และเส้นทางที่มีหลักฐานพิกัดในโมดูลขนส่ง
            </p>
            <div className="mt-4">
              <Action onClick={openTransport}>
                เปิดแผนที่ <ArrowRight className="size-4" />
              </Action>
            </div>
          </div>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader
            title="รายการสต็อกแยกตามเขต"
            description="จำนวนรายการจากข้อมูล Stock Health"
          />
          <div className="h-[260px] px-3 pb-4">
            {stockByDistrict.length ? (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 600, height: 260 }}
              >
                <BarChart
                  data={stockByDistrict}
                  margin={{ left: 4, right: 12, top: 8 }}
                >
                  <CartesianGrid vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="district"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={46}
                    fontSize={11}
                  />
                  <Tooltip formatter={(n) => formatNumber(n)} />
                  <Bar dataKey="count" fill="#278aa1" radius={[5, 5, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty>ยังไม่มีข้อมูลสต็อกเขต</Empty>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function PlansTemplate({
  data,
  role,
  districtId,
  open,
}: {
  data: DashboardData;
  role: Role;
  districtId: string | null;
  open: OpenView;
}) {
  const visiblePlans =
    role === "district"
      ? data.replenishment.filter(
          (row) => value(row, "district_id") === districtId,
        )
      : data.replenishment;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedKey, setSelectedKey] = useState("");
  const filtered = useMemo(
    () =>
      visiblePlans.filter((row) => {
        const matchesQuery = [
          "plan_code",
          "replenishment_plan_id",
          "material_id",
          "material_name",
          "district_id",
        ].some((key) =>
          value(row, key).toLowerCase().includes(query.toLowerCase()),
        );
        return (
          matchesQuery &&
          (status === "all" || value(row, "plan_status") === status)
        );
      }),
    [visiblePlans, query, status],
  );
  const selected =
    filtered.find((row) => planKey(row) === selectedKey) ?? filtered[0];
  const statuses = Array.from(
    new Set(visiblePlans.map((row) => value(row, "plan_status"))),
  );
  const pending = visiblePlans.filter((row) =>
    /review|pending/.test(value(row, "plan_status")),
  ).length;
  return (
    <div className="space-y-4">
      <PageHeader
        title="ติดตามแผนการจ่าย"
        description={`${formatNumber(visiblePlans.length)} รายการ · ${formatNumber(pending)} รายการรอตรวจ · แสดงตามสิทธิ์ผู้ใช้`}
      >
        <Action onClick={() => open("weekly")} primary>
          <ClipboardList className="size-4" /> เปิดขั้นตอนจ่ายจริง
        </Action>
      </PageHeader>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="overflow-hidden xl:col-span-2">
          <div className="flex flex-col gap-3 p-5 sm:flex-row">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <span className="sr-only">ค้นหาแผน</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="ค้นหาแผน วัสดุ หรือเขต…"
                className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm"
              />
            </label>
            <label>
              <span className="sr-only">กรองสถานะ</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm sm:w-44"
              >
                <option value="all">ทุกสถานะ</option>
                {statuses.map((key) => (
                  <option key={key} value={key}>
                    {statusNames[key] ?? key}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-y border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3">แผน / วัสดุ</th>
                  <th className="px-3 py-3">เขต</th>
                  <th className="px-3 py-3">สถานะ</th>
                  <th className="px-5 py-3 text-right">จำนวน</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={planKey(row)}
                    data-selected={selected === row}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 data-[selected=true]:bg-accent/30"
                    onClick={() => setSelectedKey(planKey(row))}
                  >
                    <td className="px-5 py-3">
                      <span className="block font-medium">
                        {value(row, "plan_code") !== "—"
                          ? value(row, "plan_code")
                          : value(row, "replenishment_plan_id")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {value(row, "material_name") !== "—"
                          ? value(row, "material_name")
                          : value(row, "material_id")}
                      </span>
                    </td>
                    <td className="px-3 py-3">{value(row, "district_id")}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={value(row, "plan_status")} />
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">
                      {formatNumber(row.suggested_qty, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && <Empty>ไม่พบรายการที่ตรงกับตัวกรอง</Empty>}
          </div>
        </Card>
        <Card className="p-5">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">รายละเอียดแผน</p>
                  <h2 className="mt-1 text-lg font-semibold">
                    {value(selected, "plan_code") !== "—"
                      ? value(selected, "plan_code")
                      : value(selected, "replenishment_plan_id")}
                  </h2>
                </div>
                <StatusBadge status={value(selected, "plan_status")} />
              </div>
              <dl className="mt-5 grid grid-cols-2 gap-3">
                {[
                  [
                    "วัสดุ",
                    value(selected, "material_name") !== "—"
                      ? value(selected, "material_name")
                      : value(selected, "material_id"),
                  ],
                  [
                    "เขตปลายทาง",
                    value(selected, "district_name_th") !== "—"
                      ? value(selected, "district_name_th")
                      : value(selected, "district_id"),
                  ],
                  ["จำนวนแนะนำ", formatNumber(selected.suggested_qty, 2)],
                  [
                    "จำนวนยืนยัน",
                    selected.confirmed_qty == null
                      ? "—"
                      : formatNumber(selected.confirmed_qty, 2),
                  ],
                  ["สัปดาห์เริ่ม", value(selected, "week_start_date")],
                  [
                    "อัปเดตล่าสุด",
                    formatDateTime(selected.updated_at ?? selected.created_at),
                  ],
                ].map(([label, detail]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-border bg-background p-3"
                  >
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words text-sm font-medium">
                      {detail}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-5 border-t border-border pt-4">
                <h3 className="text-sm font-medium">ขั้นตอนที่เกี่ยวข้อง</h3>
                <div className="mt-3 grid gap-2">
                  <Action onClick={() => open("weekly")}>
                    ตรวจแผนการจ่าย <ArrowRight className="size-4" />
                  </Action>
                  {["admin", "planner", "academic"].includes(role) && (
                    <Action onClick={() => open("approvals")}>
                      ดูประวัติอนุมัติ <ArrowRight className="size-4" />
                    </Action>
                  )}
                </div>
              </div>
            </>
          ) : (
            <Empty>เลือกแผนเพื่อดูรายละเอียด</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

export function WarehousesTemplate({
  data,
  role,
  open,
}: {
  data: DashboardData;
  role: Role;
  open: OpenView;
}) {
  const [query, setQuery] = useState("");
  const locations = Array.from(
    data.warehouseStock.reduce((map, row) => {
      const id = value(row, "location_id");
      const existing = map.get(id) ?? {
        id,
        name:
          value(row, "location_name_th") !== "—"
            ? value(row, "location_name_th")
            : id,
        items: 0,
        materials: new Set<string>(),
      };
      existing.items += 1;
      existing.materials.add(value(row, "material_id"));
      map.set(id, existing);
      return map;
    }, new Map<string, { id: string; name: string; items: number; materials: Set<string> }>()),
    ([, location]) => location,
  );
  const filtered = data.warehouseStock.filter((row) =>
    ["material_id", "material_name", "location_id", "location_name_th"].some(
      (key) => value(row, key).toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const materialTotals = Array.from(
    data.warehouseStock.reduce((map, row) => {
      const material = value(row, "material_id");
      map.set(
        material,
        (map.get(material) ?? 0) + number(row, "quantity_on_hand"),
      );
      return map;
    }, new Map<string, number>()),
    ([material, quantity]) => ({ material, quantity }),
  )
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 8);
  return (
    <div className="space-y-4">
      <PageHeader
        title="คลังและสต็อก"
        description={`${formatNumber(locations.length)} คลัง · ${formatNumber(data.warehouseStock.length)} รายการสต็อก · ข้อมูลตามสิทธิ์ผู้ใช้`}
      >
        {["admin", "planner"].includes(role) && (
          <Action onClick={() => open("stock")}>ข้อมูล Stock</Action>
        )}
        {(role === "admin" || role === "picker") && (
          <Action onClick={() => open("receiving")} primary>
            <ArrowDownToLine className="size-4" /> รับพัสดุเข้าคลัง
          </Action>
        )}
      </PageHeader>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {locations.length ? (
          locations.map((location) => (
            <Card key={location.id} className="p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-medium">{location.name}</h2>
                  <p className="text-xs text-muted-foreground">{location.id}</p>
                </div>
                <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                  มีข้อมูล
                </span>
              </div>
              <div className="mt-5 flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-2 text-muted-foreground">
                  <Boxes className="size-4" /> {formatNumber(location.items)}{" "}
                  รายการ
                </span>
                <span className="font-medium tabular-nums">
                  {formatNumber(location.materials.size)} วัสดุ
                </span>
              </div>
            </Card>
          ))
        ) : (
          <Card className="p-5 text-sm text-muted-foreground">
            ยังไม่มีข้อมูลสต็อกคลัง
          </Card>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="สต็อกตามวัสดุ"
            description="ปริมาณคงเหลือ 8 รายการสูงสุด"
          />
          <div className="h-[260px] px-3 pb-4">
            {materialTotals.length ? (
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 500, height: 260 }}
              >
                <BarChart
                  data={materialTotals}
                  margin={{ left: 4, right: 12, top: 8 }}
                >
                  <CartesianGrid vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="material"
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={46}
                    fontSize={11}
                  />
                  <Tooltip formatter={(n) => formatNumber(n)} />
                  <Bar
                    dataKey="quantity"
                    fill="#2575bb"
                    radius={[5, 5, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty>ยังไม่มีข้อมูลสต็อก</Empty>
            )}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="font-semibold">การดำเนินงานคลัง</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            เปิดหน้าดำเนินการตามสิทธิ์ของคุณ
          </p>
          <div className="mt-5 grid gap-3">
            {["admin", "planner"].includes(role) && (
              <Action onClick={() => open("fifo")}>
                <Boxes className="size-4" /> FIFO และพาเลท{" "}
                <ArrowRight className="ml-auto size-4" />
              </Action>
            )}
            {(role === "admin" || role === "picker") && (
              <Action onClick={() => open("receiving")}>
                <ArrowDownToLine className="size-4" /> รับพัสดุ{" "}
                <ArrowRight className="ml-auto size-4" />
              </Action>
            )}
            {["admin", "planner"].includes(role) && (
              <Action onClick={() => open("stock")}>
                <ArrowUpFromLine className="size-4" /> ตรวจ Stock{" "}
                <ArrowRight className="ml-auto size-4" />
              </Action>
            )}
            {["academic", "viewer"].includes(role) && (
              <p className="text-sm text-muted-foreground">
                บทบาทนี้ดูข้อมูลคลังได้อย่างเดียว
              </p>
            )}
          </div>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">ทะเบียนสต็อกคลัง</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              ข้อมูลสต็อกล่าสุดจากระบบ
            </p>
          </div>
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <span className="sr-only">ค้นหาวัสดุ</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ค้นหารหัส วัสดุ หรือคลัง…"
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm sm:w-64"
            />
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-y border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-5 py-3">รหัสวัสดุ</th>
                <th className="px-3 py-3">รายการ</th>
                <th className="px-3 py-3">คลัง</th>
                <th className="px-3 py-3 text-right">คงเหลือ</th>
                <th className="px-5 py-3 text-right">เวลาข้อมูล</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((row, index) => (
                <tr
                  key={`${value(row, "material_id")}-${value(row, "location_id")}-${index}`}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-5 py-3 font-mono text-xs">
                    {value(row, "material_id")}
                  </td>
                  <td className="px-3 py-3">{value(row, "material_name")}</td>
                  <td className="px-3 py-3">
                    {value(row, "location_name_th") !== "—"
                      ? value(row, "location_name_th")
                      : value(row, "location_id")}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNumber(row.quantity_on_hand, 2)} {value(row, "unit")}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-muted-foreground">
                    {formatDateTime(row.snapshot_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <Empty>ไม่พบรายการสต็อก</Empty>}
        </div>
      </Card>
    </div>
  );
}
